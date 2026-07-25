import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTransferError,
  FileTransferManager,
  inferMimeType,
  normalizeMimeType,
  sanitizeFileName,
} from "../src/file-transfer.js";

const temporaryDirectories: string[] = [];

async function fixture(options: { now?: () => number; maxUploadBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cmr-file-transfer-"));
  temporaryDirectories.push(root);
  const uploads = join(root, ".uploads");
  const manager = await FileTransferManager.create({
    allowedRoots: [root],
    uploadDirectory: uploads,
    downloadTtlMs: 1_000,
    uploadTtlMs: 2_000,
    maxUploadBytes: options.maxUploadBytes ?? 1024,
    now: options.now,
  });
  return { root, uploads, manager };
}

async function streamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("file transfer primitives", () => {
  it("sanitizes traversal, separators, controls, and excessively long names", () => {
    expect(sanitizeFileName(" ../../secret\\name\u0000.txt ")).toBe("_.._secret_name.txt");
    expect(Buffer.byteLength(sanitizeFileName(`${"你".repeat(100)}.png`))).toBeLessThanOrEqual(180);
    expect(sanitizeFileName("... ")).toBe("file");
    expect(normalizeMimeType("Image/PNG; charset=binary")).toBe("image/png");
    expect(normalizeMimeType("text/plain\r\nX-Evil: yes")).toBe("application/octet-stream");
    expect(inferMimeType("PHOTO.PNG")).toBe("image/png");
  });

  it("streams uploads to a private random directory without trusting the original path", async () => {
    const { manager } = await fixture();
    const result = await manager.receiveUpload({
      stream: Readable.from([Buffer.from("hello "), Buffer.from("world")]),
      fileName: "../../report.md",
      mimeType: "text/markdown; charset=utf-8",
      contentLength: 11,
    });

    expect(result.uploadId).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(result.fileName).toBe("_.._report.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.size).toBe(11);
    expect(await readFile(result.path, "utf8")).toBe("hello world");
    if (process.platform !== "win32")
      expect((await stat(result.path)).mode & 0o777).toBe(0o600);
  });

  it("rejects oversized streams and removes their partial files", async () => {
    const { manager, uploads } = await fixture({ maxUploadBytes: 5 });
    await expect(manager.receiveUpload({
      stream: Readable.from([Buffer.from("123"), Buffer.from("456")]),
      fileName: "large.bin",
    })).rejects.toMatchObject({ code: "FILE_TOO_LARGE", httpStatus: 413 });
    expect(await readdir(uploads)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("only registers canonical regular files inside allowed roots, including symlink resolution", async () => {
    const { root, manager } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "cmr-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    await expect(manager.createDownloadTicket(join(root, "escape.txt"))).rejects.toMatchObject({
      code: "PATH_NOT_ALLOWED",
      httpStatus: 403,
    });
    await expect(manager.createDownloadTicket(root)).rejects.toMatchObject({ code: "NOT_A_FILE" });
  });

  it("allows only an exact Desktop canonical attachment outside configured roots", async () => {
    const { manager } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "cmr-desktop-attachment-"));
    temporaryDirectories.push(outside);
    const image = join(outside, "screen.png");
    const sibling = join(outside, "other.png");
    await writeFile(image, "image");
    await writeFile(sibling, "other");

    await expect(manager.createDownloadTicket(image)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await manager.trustDesktopAttachment(image);
    const ticket = await manager.createDownloadTicket(image);
    expect(ticket.fileName).toBe("screen.png");
    await expect(manager.createDownloadTicket(sibling)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("serves a one-time ticket once and detects replacement after registration", async () => {
    const { root, manager } = await fixture();
    const path = join(root, "result.txt");
    await writeFile(path, "first");
    const ticket = await manager.createDownloadTicket(path, { mimeType: "text/plain", oneTime: true });
    const claimed = await manager.claimDownload(ticket.id);
    expect(await streamText(claimed.stream)).toBe("first");
    await expect(manager.claimDownload(ticket.id)).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });

    const changedTicket = await manager.createDownloadTicket(path, { oneTime: true });
    await rm(path);
    await writeFile(path, "other");
    await expect(manager.claimDownload(changedTicket.id)).rejects.toSatisfy((error: unknown) =>
      error instanceof FileTransferError && ["FILE_CHANGED", "FILE_NOT_FOUND"].includes(error.code));
  });

  it("expires tickets and removes expired uploads during cleanup", async () => {
    let now = 10_000;
    const { root, manager } = await fixture({ now: () => now });
    const path = join(root, "download.bin");
    await writeFile(path, "download");
    const ticket = await manager.createDownloadTicket(path);
    const upload = await manager.receiveUpload({ stream: Readable.from("upload"), fileName: "upload.bin" });

    now += 2_001;
    await expect(manager.claimDownload(ticket.id)).rejects.toMatchObject({ code: "TRANSFER_EXPIRED" });
    expect(await manager.cleanupExpired()).toEqual({ downloads: 0, uploads: 1 });
    await expect(readFile(upload.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("requires upload storage to remain inside an allowed root after symlink resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmr-root-"));
    const outside = await mkdtemp(join(tmpdir(), "cmr-storage-outside-"));
    temporaryDirectories.push(root, outside);
    await chmod(root, 0o700);
    await mkdir(join(outside, "uploads"));
    await symlink(join(outside, "uploads"), join(root, "linked-uploads"));

    await expect(FileTransferManager.create({
      allowedRoots: [root],
      uploadDirectory: join(root, "linked-uploads"),
    })).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });
});
