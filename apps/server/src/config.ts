import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  tokenDigest: Buffer;
  allowedOrigins: Set<string>;
  codexBin: string;
  codexHome: string;
  serverId: string;
  desktopIpc: boolean;
  desktopIpcEndpoint?: string;
  fileRoots: string[];
  uploadDirectory: string;
  promptQueueFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.CMR_HOST ?? "127.0.0.1";
  const port = Number.parseInt(env.CMR_PORT ?? "8787", 10);
  const token = env.CMR_TOKEN ?? "";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CMR_PORT must be an integer between 1 and 65535; got ${env.CMR_PORT ?? ""}`);
  }
  if (token.length < 32) {
    throw new Error("CMR_TOKEN is required and must contain at least 32 characters. Run `npm run token` to generate one.");
  }

  const defaultOrigins = [
    "capacitor://localhost",
    "http://localhost",
    "https://localhost",
  ];
  const configuredOrigins = (env.CMR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);


  const stateDirectory = env.CMR_STATE_DIRECTORY ?? join(homedir(), ".codex-mobile-remote");
  const uploadDirectory = env.CMR_UPLOAD_DIRECTORY ?? join(stateDirectory, "uploads");
  const configuredFileRoots = (env.CMR_FILE_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // Safe default: uploads remain usable, but arbitrary Home files are not
  // downloadable until the operator explicitly opts directories in.
  const fileRoots = configuredFileRoots.length > 0 ? configuredFileRoots : [uploadDirectory];

  return {
    host,
    port,
    token,
    tokenDigest: createHash("sha256").update(token).digest(),
    allowedOrigins: new Set([...defaultOrigins, ...configuredOrigins]),
    codexBin: env.CODEX_BIN ?? "codex",
    codexHome: env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    serverId: env.CMR_SERVER_ID ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
    desktopIpc: env.CMR_DESKTOP_IPC !== "0",
    desktopIpcEndpoint: env.CMR_DESKTOP_IPC_ENDPOINT?.trim() || undefined,
    fileRoots,
    uploadDirectory,
    promptQueueFile: env.CMR_PROMPT_QUEUE_FILE ?? join(stateDirectory, "prompt-queue.json"),
  };
}
export function buildCodexEnvironment(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, CODEX_HOME: codexHome };
}
