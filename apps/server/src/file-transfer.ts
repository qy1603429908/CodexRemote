import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UPLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_FILENAME_BYTES = 180;
const COMMITTED_UPLOAD_MARKER = ".codex-remote-committed";

export type FileTransferErrorCode =
  | "INVALID_ARGUMENT"
  | "PATH_NOT_ALLOWED"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "FILE_TOO_LARGE"
  | "TRANSFER_NOT_FOUND"
  | "TRANSFER_EXPIRED"
  | "TRANSFER_ALREADY_CLAIMED"
  | "FILE_CHANGED";

export class FileTransferError extends Error {
  constructor(
    readonly code: FileTransferErrorCode,
    message: string,
    readonly httpStatus: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileTransferError";
  }
}

export interface FileTransferManagerOptions {
  /** Existing directories whose descendants may be offered for download. */
  allowedRoots: string[];
  /** Dedicated upload storage. It must resolve inside an allowed root. */
  uploadDirectory: string;
  maxUploadBytes?: number;
  maxDownloadBytes?: number;
  downloadTtlMs?: number;
  maxDownloadTtlMs?: number;
  uploadTtlMs?: number;
  now?: () => number;
  randomId?: () => string;
}

export interface UploadInput {
  stream: Readable;
  fileName: string;
  mimeType?: string | null;
  contentLength?: number | null;
}

export interface StoredUpload {
  uploadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: number;
  expiresAt: number;
}

export interface DownloadTicket {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
  oneTime: boolean;
}

export interface CreateDownloadOptions {
  fileName?: string;
  mimeType?: string | null;
  ttlMs?: number;
  oneTime?: boolean;
}

export interface ClaimedDownload extends DownloadTicket {
  stream: Readable;
}

interface DownloadRecord extends DownloadTicket {
  canonicalPath: string;
  device: number;
  inode: number;
  claimed: boolean;
}

interface UploadRecord extends StoredUpload {
  storageDirectory: string;
}

interface TrustedFileRecord {
  canonicalPath: string;
  expiresAt: number;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FileTransferError("INVALID_ARGUMENT", `${field} must be a positive safe integer`, 400);
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  const target = resolve(path);
  let ancestor = target;
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, relative(ancestor, target));
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new FileTransferError("FILE_NOT_FOUND", "no existing ancestor for path", 404);
      ancestor = parent;
    }
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maxBytes) break;
    output += character;
  }
  return output;
}

export function sanitizeFileName(input: string): string {
  const normalized = input
    .normalize("NFKC")
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");

  let safe = basename(normalized || "file");
  if (!safe || safe === "." || safe === "..") safe = "file";

  const extension = extname(safe);
  const extensionBudget = Math.min(Buffer.byteLength(extension, "utf8"), 32);
  const stemBudget = Math.max(1, MAX_FILENAME_BYTES - extensionBudget);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  safe = `${truncateUtf8(stem || "file", stemBudget)}${truncateUtf8(extension, 32)}`;
  return safe || "file";
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

export function normalizeMimeType(input: string | null | undefined): string {
  const value = input?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)
    ? value
    : "application/octet-stream";
}

export function inferMimeType(fileName: string): string {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

function defaultRandomId(): string {
  return randomBytes(24).toString("base64url");
}

export class FileTransferManager {
  readonly allowedRoots: readonly string[];
  readonly uploadDirectory: string;

  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly trustedFiles = new Map<string, TrustedFileRecord>();

  private constructor(
    allowedRoots: string[],
    uploadDirectory: string,
    private readonly maxUploadBytes: number,
    private readonly maxDownloadBytes: number,
    private readonly downloadTtlMs: number,
    private readonly maxDownloadTtlMs: number,
    private readonly uploadTtlMs: number,
    private readonly now: () => number,
    private readonly randomId: () => string,
  ) {
    this.allowedRoots = allowedRoots;
    this.uploadDirectory = uploadDirectory;
  }

  static async create(options: FileTransferManagerOptions): Promise<FileTransferManager> {
    if (options.allowedRoots.length === 0) {
      throw new FileTransferError("INVALID_ARGUMENT", "allowedRoots must not be empty", 400);
    }

    const maxUploadBytes = options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    const downloadTtlMs = options.downloadTtlMs ?? DEFAULT_DOWNLOAD_TTL_MS;
    const maxDownloadTtlMs = options.maxDownloadTtlMs ?? 60 * 60 * 1000;
    const uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
    for (const [name, value] of Object.entries({ maxUploadBytes, maxDownloadBytes, downloadTtlMs, maxDownloadTtlMs, uploadTtlMs })) {
      assertPositiveInteger(value, name);
    }
    if (downloadTtlMs > maxDownloadTtlMs) {
      throw new FileTransferError("INVALID_ARGUMENT", "downloadTtlMs must not exceed maxDownloadTtlMs", 400);
    }

    const roots = await Promise.all(options.allowedRoots.map(async (root) => {
      const canonical = await realpath(resolve(root));
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) {
        throw new FileTransferError("INVALID_ARGUMENT", `allowed root is not a directory: ${root}`, 400);
      }
      return canonical;
    }));
    const allowedRoots = [...new Set(roots)];

    const requestedUploadDirectory = resolve(options.uploadDirectory);
    const prospectiveUploadDirectory = await canonicalizeProspectivePath(requestedUploadDirectory);
    const lexicalParentAllowed = allowedRoots.some((root) => isWithinRoot(root, prospectiveUploadDirectory));
    if (!lexicalParentAllowed) {
      throw new FileTransferError("PATH_NOT_ALLOWED", "uploadDirectory must be inside an allowed root", 403);
    }
    await mkdir(requestedUploadDirectory, { recursive: true, mode: 0o700 });
    const uploadDirectory = await realpath(requestedUploadDirectory);
    if (!allowedRoots.some((root) => isWithinRoot(root, uploadDirectory))) {
      throw new FileTransferError("PATH_NOT_ALLOWED", "uploadDirectory resolves outside the allowed roots", 403);
    }

    return new FileTransferManager(
      allowedRoots,
      uploadDirectory,
      maxUploadBytes,
      maxDownloadBytes,
      downloadTtlMs,
      maxDownloadTtlMs,
      uploadTtlMs,
      options.now ?? Date.now,
      options.randomId ?? defaultRandomId,
    );
  }

  async receiveUpload(input: UploadInput): Promise<StoredUpload> {
    const fileName = sanitizeFileName(input.fileName);
    const mimeType = input.mimeType == null ? inferMimeType(fileName) : normalizeMimeType(input.mimeType);
    if (input.contentLength != null) {
      if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0) {
        throw new FileTransferError("INVALID_ARGUMENT", "contentLength must be a non-negative safe integer", 400);
      }
      if (input.contentLength > this.maxUploadBytes) {
        throw new FileTransferError("FILE_TOO_LARGE", `upload exceeds ${this.maxUploadBytes} bytes`, 413);
      }
    }

    const uploadId = this.uniqueId(this.uploads);
    const storageDirectory = resolve(this.uploadDirectory, uploadId);
    if (!isWithinRoot(this.uploadDirectory, storageDirectory)) {
      throw new FileTransferError("PATH_NOT_ALLOWED", "generated upload path escaped storage root", 500);
    }
    await mkdir(storageDirectory, { mode: 0o700 });
    const path = resolve(storageDirectory, fileName);
    let size = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer | string, _encoding, callback) => {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
        size += bytes;
        if (size > this.maxUploadBytes) {
          callback(new FileTransferError("FILE_TOO_LARGE", `upload exceeds ${this.maxUploadBytes} bytes`, 413));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(input.stream, limiter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
      if (input.contentLength != null && size !== input.contentLength) {
        throw new FileTransferError("INVALID_ARGUMENT", "received byte count does not match contentLength", 400);
      }
      const createdAt = this.now();
      const record: UploadRecord = {
        uploadId,
        fileName,
        mimeType,
        size,
        path,
        createdAt,
        expiresAt: createdAt + this.uploadTtlMs,
        storageDirectory,
      };
      this.uploads.set(uploadId, record);
      return this.publicUpload(record);
    } catch (error) {
      await rm(storageDirectory, { recursive: true, force: true });
      if (error instanceof FileTransferError) throw error;
      throw new FileTransferError("INVALID_ARGUMENT", "upload stream failed", 400, { cause: error });
    }
  }

  pinUpload(uploadId: string): boolean {
    const record = this.uploads.get(uploadId);
    if (!record) return false;
    record.expiresAt = Number.MAX_SAFE_INTEGER;
    return true;
  }

  releaseUpload(uploadId: string): boolean {
    const record = this.uploads.get(uploadId);
    if (!record) return false;
    record.expiresAt = this.now() + this.uploadTtlMs;
    return true;
  }

  /** Marks an upload as durable because a persisted Codex message now references it. */
  async commitUpload(uploadId: string): Promise<boolean> {
    const record = this.uploads.get(uploadId);
    if (!record) return false;
    const markerPath = resolve(record.storageDirectory, COMMITTED_UPLOAD_MARKER);
    const marker = await open(markerPath, "a", 0o600);
    await marker.close();
    record.expiresAt = Number.MAX_SAFE_INTEGER;
    return true;
  }

  async getUpload(uploadId: string): Promise<StoredUpload> {
    const record = this.uploads.get(uploadId);
    if (!record) throw new FileTransferError("TRANSFER_NOT_FOUND", "upload was not found", 404);
    if (record.expiresAt <= this.now()) {
      await this.removeUpload(uploadId);
      throw new FileTransferError("TRANSFER_EXPIRED", "upload has expired", 410);
    }
    const canonicalPath = await this.resolveAllowedFile(record.path);
    if (canonicalPath !== record.path) throw new FileTransferError("FILE_CHANGED", "upload changed after registration", 409);
    const metadata = await stat(canonicalPath);
    if (metadata.size !== record.size) throw new FileTransferError("FILE_CHANGED", "upload changed after registration", 409);
    return this.publicUpload(record);
  }

  /** Trusts one exact file path observed in a Desktop canonical user attachment. */
  async trustDesktopAttachment(path: string, ttlMs = Number.MAX_SAFE_INTEGER): Promise<string> {
    assertPositiveInteger(ttlMs, "ttlMs");
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolve(path));
    } catch (error) {
      throw new FileTransferError("FILE_NOT_FOUND", "Desktop attachment no longer exists", 404, { cause: error });
    }
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) throw new FileTransferError("NOT_A_FILE", "Desktop attachment is not a regular file", 400);
    if (metadata.size > this.maxDownloadBytes) throw new FileTransferError("FILE_TOO_LARGE", `download exceeds ${this.maxDownloadBytes} bytes`, 413);
    this.trustedFiles.set(canonicalPath, { canonicalPath, expiresAt: this.now() + ttlMs });
    return canonicalPath;
  }

  async createDownloadTicket(path: string, options: CreateDownloadOptions = {}): Promise<DownloadTicket> {
    const ttlMs = options.ttlMs ?? this.downloadTtlMs;
    assertPositiveInteger(ttlMs, "ttlMs");
    if (ttlMs > this.maxDownloadTtlMs) {
      throw new FileTransferError("INVALID_ARGUMENT", `ttlMs exceeds ${this.maxDownloadTtlMs}`, 400);
    }
    const canonicalPath = await this.resolveAllowedFile(path);
    const metadata = await stat(canonicalPath);
    if (metadata.size > this.maxDownloadBytes) {
      throw new FileTransferError("FILE_TOO_LARGE", `download exceeds ${this.maxDownloadBytes} bytes`, 413);
    }

    const id = this.uniqueId(this.downloads);
    const record: DownloadRecord = {
      id,
      canonicalPath,
      fileName: sanitizeFileName(options.fileName ?? basename(canonicalPath)),
      mimeType: options.mimeType == null ? inferMimeType(options.fileName ?? canonicalPath) : normalizeMimeType(options.mimeType),
      size: metadata.size,
      expiresAt: this.now() + ttlMs,
      oneTime: options.oneTime ?? true,
      device: metadata.dev,
      inode: metadata.ino,
      claimed: false,
    };
    this.downloads.set(id, record);
    return this.publicTicket(record);
  }

  async claimDownload(id: string): Promise<ClaimedDownload> {
    const record = this.downloads.get(id);
    if (!record) {
      throw new FileTransferError("TRANSFER_NOT_FOUND", "download ticket was not found", 404);
    }
    if (record.expiresAt <= this.now()) {
      this.downloads.delete(id);
      throw new FileTransferError("TRANSFER_EXPIRED", "download ticket has expired", 410);
    }
    if (record.claimed) {
      throw new FileTransferError("TRANSFER_ALREADY_CLAIMED", "download ticket has already been claimed", 410);
    }

    // Claim before opening so concurrent requests cannot consume a one-time ticket twice.
    record.claimed = true;
    if (record.oneTime) this.downloads.delete(id);

    try {
      const canonicalPath = await this.resolveAllowedFile(record.canonicalPath);
      if (canonicalPath !== record.canonicalPath) {
        throw new FileTransferError("FILE_CHANGED", "download target changed after ticket creation", 409);
      }
      const handle = await open(canonicalPath, "r");
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.dev !== record.device || metadata.ino !== record.inode || metadata.size !== record.size) {
          throw new FileTransferError("FILE_CHANGED", "download target changed after ticket creation", 409);
        }
        const stream = handle.createReadStream({ autoClose: true });
        if (!record.oneTime) {
          const releaseClaim = () => {
            if (this.downloads.get(id) === record) record.claimed = false;
          };
          stream.once("close", releaseClaim);
        }
        return { ...this.publicTicket(record), stream };
      } catch (error) {
        await handle.close();
        throw error;
      }
    } catch (error) {
      if (!record.oneTime) record.claimed = false;
      if (error instanceof FileTransferError) throw error;
      throw new FileTransferError("FILE_NOT_FOUND", "download target is no longer available", 404, { cause: error });
    }
  }

  async removeUpload(uploadId: string): Promise<boolean> {
    const record = this.uploads.get(uploadId);
    if (!record) return false;
    this.uploads.delete(uploadId);
    await rm(record.storageDirectory, { recursive: true, force: true });
    return true;
  }

  /** Removes stale upload directories left on disk by a previous process. */
  async cleanupOrphanedUploads(protectedPaths: ReadonlySet<string> = new Set()): Promise<number> {
    const entries = await readdir(this.uploadDirectory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{22,128}$/.test(entry.name) || this.uploads.has(entry.name)) continue;
      const directory = resolve(this.uploadDirectory, entry.name);
      if (!isWithinRoot(this.uploadDirectory, directory) || protectedPaths.has(directory)) continue;
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || metadata.mtimeMs + this.uploadTtlMs > this.now()) continue;
      try {
        const marker = await lstat(resolve(directory, COMMITTED_UPLOAD_MARKER));
        if (marker.isFile() && !marker.isSymbolicLink()) continue;
      } catch {
        // No durable marker: the stale directory remains eligible for cleanup.
      }
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async cleanupExpired(): Promise<{ downloads: number; uploads: number }> {
    const now = this.now();
    let downloads = 0;
    let uploads = 0;
    for (const [id, record] of this.downloads) {
      if (record.expiresAt <= now) {
        this.downloads.delete(id);
        downloads += 1;
      }
    }
    for (const [id, record] of this.uploads) {
      if (record.expiresAt <= now) {
        this.uploads.delete(id);
        await rm(record.storageDirectory, { recursive: true, force: true });
        uploads += 1;
      }
    }
    for (const [path, record] of this.trustedFiles) {
      if (record.expiresAt <= now) this.trustedFiles.delete(path);
    }
    return { downloads, uploads };
  }

  private async resolveAllowedFile(path: string): Promise<string> {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(resolve(path));
    } catch (error) {
      throw new FileTransferError("FILE_NOT_FOUND", "file does not exist", 404, { cause: error });
    }
    const trusted = this.trustedFiles.get(canonicalPath);
    if (trusted && trusted.expiresAt <= this.now()) this.trustedFiles.delete(canonicalPath);
    const trustedNow = Boolean(trusted && trusted.expiresAt > this.now());
    if (!trustedNow && !this.allowedRoots.some((root) => isWithinRoot(root, canonicalPath))) {
      throw new FileTransferError("PATH_NOT_ALLOWED", "file is outside the allowed roots", 403);
    }
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      throw new FileTransferError("NOT_A_FILE", "path is not a regular file", 400);
    }
    return canonicalPath;
  }

  private uniqueId<T>(records: Map<string, T>): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.randomId();
      if (/^[A-Za-z0-9_-]{22,128}$/.test(id) && !records.has(id)) return id;
    }
    throw new FileTransferError("INVALID_ARGUMENT", "could not allocate a unique transfer id", 500);
  }

  private publicTicket(record: DownloadRecord): DownloadTicket {
    return {
      id: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      expiresAt: record.expiresAt,
      oneTime: record.oneTime,
    };
  }

  private publicUpload(record: UploadRecord): StoredUpload {
    return {
      uploadId: record.uploadId,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      path: record.path,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }
}
