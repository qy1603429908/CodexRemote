import { Capacitor, registerPlugin } from '@capacitor/core';
export interface RemoteFileTransferConfig {
  serverUrl: string;
  token: string;
}

export interface RemoteUploadResult {
  uploadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: number;
  expiresAt: number;
}

export interface RemoteDownloadResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface UploadRemoteFileOptions extends RemoteFileTransferConfig {
  file: Blob;
  fileName: string;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

function apiUrl(serverUrl: string, path: string): string {
  const base = new URL(serverUrl.trim().replace(/\/+$/, "") + "/");
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("文件传输服务器地址必须使用 http 或 https");
  }
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

function safeResponseFileName(contentDisposition: string | null, fallback: string): string {
  if (!contentDisposition) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replace(/[\\/\u0000-\u001f\u007f]/g, "_") || fallback;
    } catch {
      return fallback;
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(contentDisposition)?.[1];
  return quoted?.replace(/[\\/\u0000-\u001f\u007f]/g, "_") || fallback;
}

function parseJsonResponse<T>(xhr: XMLHttpRequest): T {
  let value: unknown;
  try {
    value = JSON.parse(xhr.responseText);
  } catch {
    throw new Error(`服务器返回了无法解析的响应（HTTP ${xhr.status}）`);
  }
  if (xhr.status < 200 || xhr.status >= 300) {
    const message = typeof value === "object" && value !== null && "error" in value
      ? String((value as { error: unknown }).error)
      : `文件上传失败（HTTP ${xhr.status}）`;
    throw new Error(message);
  }
  return value as T;
}

/**
 * Uploads a Blob as a raw request body. Gateway integration should expose
 * POST /api/files/upload and read X-CMR-Filename plus Content-Type.
 */
export function uploadRemoteFile(options: UploadRemoteFileOptions): Promise<RemoteUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(options.serverUrl, "/api/files/upload"));
    xhr.setRequestHeader("Authorization", `Bearer ${options.token}`);
    xhr.setRequestHeader("X-CMR-Filename", encodeURIComponent(options.fileName));
    xhr.setRequestHeader("Content-Type", options.file.type || "application/octet-stream");
    xhr.responseType = "text";

    const abort = () => xhr.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : options.file.size);
    xhr.onerror = () => reject(new Error("文件上传网络错误"));
    xhr.onabort = () => reject(new DOMException("文件上传已取消", "AbortError"));
    xhr.onload = () => {
      try {
        resolve(parseJsonResponse<RemoteUploadResult>(xhr));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onloadend = () => options.signal?.removeEventListener("abort", abort);
    xhr.send(options.file);
  });
}

/** Downloads a short-lived opaque ticket without putting the pairing token in the URL. */
export async function downloadRemoteFile(
  config: RemoteFileTransferConfig,
  ticketId: string,
  signal?: AbortSignal,
): Promise<RemoteDownloadResult> {
  const response = await fetch(apiUrl(config.serverUrl, `/api/files/download/${encodeURIComponent(ticketId)}`), {
    method: "GET",
    headers: { Authorization: `Bearer ${config.token}` },
    cache: "no-store",
    credentials: "omit",
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `文件下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const fallback = `codex-download-${ticketId.slice(0, 8)}`;
  const fileName = safeResponseFileName(response.headers.get("Content-Disposition"), fallback);
  return {
    blob,
    fileName,
    mimeType: response.headers.get("Content-Type")?.split(";", 1)[0] || blob.type || "application/octet-stream",
    size: blob.size,
  };
}

/** Browser-preview helper. Android native integration may replace this with a share/save plugin. */
export function triggerBrowserDownload(result: RemoteDownloadResult): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export interface RemoteDownloadTicket {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
  oneTime: boolean;
}

export async function createRemoteDownloadTicket(
  config: RemoteFileTransferConfig,
  path: string,
  signal?: AbortSignal,
): Promise<RemoteDownloadTicket> {
  const response = await fetch(apiUrl(config.serverUrl, "/api/files/ticket"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
    cache: "no-store",
    credentials: "omit",
    signal,
  });
  const value = await response.json().catch(() => null) as RemoteDownloadTicket | { error?: unknown } | null;
  if (!response.ok || !value || !("id" in value)) {
    throw new Error(value && "error" in value ? String(value.error) : `创建下载票据失败（HTTP ${response.status}）`);
  }
  return value;
}

export async function downloadHostFile(config: RemoteFileTransferConfig, path: string): Promise<RemoteDownloadResult> {
  const ticket = await createRemoteDownloadTicket(config, path);
  return downloadRemoteFile(config, ticket.id);
}


interface CodexFileTransferPluginApi {
  download(options: { serverUrl: string; token: string; ticketId: string }): Promise<{ uri: string; fileName: string; mimeType: string; size: number }>;
}
const CodexFileTransfer = registerPlugin<CodexFileTransferPluginApi>('CodexFileTransfer');

export async function saveHostFile(config: RemoteFileTransferConfig, path: string): Promise<{ fileName: string; mimeType: string; size: number; uri?: string }> {
  const ticket = await createRemoteDownloadTicket(config, path);
  if (Capacitor.isNativePlatform()) {
    return CodexFileTransfer.download({ serverUrl: config.serverUrl, token: config.token, ticketId: ticket.id });
  }
  const result = await downloadRemoteFile(config, ticket.id);
  triggerBrowserDownload(result);
  return result;
}
