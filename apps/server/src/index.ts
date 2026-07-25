import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AppServerBridge } from "./app-server-bridge.js";
import { authenticateBearer } from "./auth.js";
import { buildCodexEnvironment, loadConfig } from "./config.js";
import { DesktopIpcBridge } from "./desktop-ipc-bridge.js";
import { FileTransferError, FileTransferManager } from "./file-transfer.js";
import { MobileGateway } from "./gateway.js";
import { PromptQueueStore } from "./prompt-queue.js";

const config = loadConfig();
const bridge = new AppServerBridge({
  codexBin: config.codexBin,
  env: buildCodexEnvironment(config.codexHome),
  expectedCodexHome: config.codexHome,
});
const desktopIpc = new DesktopIpcBridge(config.desktopIpc);
const promptQueue = await PromptQueueStore.create(config.promptQueueFile);
const files = await FileTransferManager.create({ allowedRoots: config.fileRoots, uploadDirectory: config.uploadDirectory });
await files.cleanupOrphanedUploads(promptQueue.protectedFilePaths());
const gateway = new MobileGateway(bridge, config, desktopIpc, files, promptQueue);
const heartbeat = gateway.startHeartbeat();
const fileCleanup = setInterval(() => void Promise.all([files.cleanupExpired(), files.cleanupOrphanedUploads(promptQueue.protectedFilePaths())]).catch((error) => console.warn("[files] cleanup", error)), 60_000);
fileCleanup.unref();

const server = createServer((request, response) => void handleHttp(request, response));

async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(bridge.ready ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ok: bridge.ready, service: "codex-mobile-remote", version: "0.3.2", desktopIpc: desktopIpc.ready }));
    return;
  }

  if (request.url?.startsWith("/api/files/")) {
    const origin = request.headers.origin;
    if (origin && !config.allowedOrigins.has(origin)) {
      json(response, 403, { error: "origin_not_allowed" });
      return;
    }
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, X-CMR-Filename",
        "access-control-max-age": "600",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!authenticateBearer(request.headers.authorization, config)) {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      if (request.method === "POST" && request.url === "/api/files/upload") {
        const encodedName = String(request.headers["x-cmr-filename"] ?? "file");
        let fileName = "file";
        try { fileName = decodeURIComponent(encodedName); } catch { fileName = encodedName; }
        const contentLength = Number.parseInt(String(request.headers["content-length"] ?? ""), 10);
        const upload = await files.receiveUpload({
          stream: request,
          fileName,
          mimeType: request.headers["content-type"],
          contentLength: Number.isFinite(contentLength) ? contentLength : null,
        });
        json(response, 201, upload);
        return;
      }
      if (request.method === "POST" && request.url === "/api/files/ticket") {
        const body = await readJsonBody(request, 64 * 1024);
        const path = typeof body.path === "string" ? body.path : "";
        const ticket = await files.createDownloadTicket(path);
        json(response, 201, ticket);
        return;
      }
      const match = request.method === "GET" ? /^\/api\/files\/download\/([A-Za-z0-9_-]{22,128})$/.exec(request.url ?? "") : null;
      if (match) {
        const download = await files.claimDownload(match[1]!);
        response.writeHead(200, {
          "content-type": download.mimeType,
          "content-length": String(download.size),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        download.stream.on("error", () => response.destroy());
        download.stream.pipe(response);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof FileTransferError ? error.httpStatus : 500;
      json(response, status, { error: error instanceof Error ? error.message : "file transfer failed" });
    }
    return;
  }

  json(response, 404, { error: "not_found" });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new FileTransferError("FILE_TOO_LARGE", "request body is too large", 413);
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FileTransferError("INVALID_ARGUMENT", "JSON object required", 400);
  return value as Record<string, unknown>;
}

server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] received ${signal}; shutting down`);
  clearInterval(heartbeat);
  clearInterval(fileCleanup);
  gateway.close();
  await desktopIpc.stop();
  await bridge.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[server] uncaught exception", error);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  console.error("[server] unhandled rejection", error);
});

console.log(`[server] Codex home ${config.codexHome}`);
await bridge.start();
await desktopIpc.start();
server.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port}`);
  console.log(`[server] websocket endpoint ws://${config.host}:${config.port}/ws`);
});
