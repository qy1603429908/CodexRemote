import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { posix, win32 } from "node:path";

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AppServerBridgeOptions {
  codexBin: string;
  requestTimeoutMs?: number;
  restartDelayMs?: number;
  env?: NodeJS.ProcessEnv;
  expectedCodexHome?: string;
}

export class AppServerBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stopping = false;
  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private readonly requestTimeoutMs: number;
  private readonly restartDelayMs: number;

  constructor(private readonly options: AppServerBridgeOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.restartDelayMs = options.restartDelayMs ?? 1_000;
  }

  get ready(): boolean {
    return this.initialized && this.child !== null;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.spawnAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    const child = spawn(this.options.codexBin, ["app-server", "--listen", "stdio://"], {
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.initialized = false;

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("diagnostic", String(chunk)));
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => this.handleExit(new Error(`codex app-server exited code=${code} signal=${signal}`)));

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { child.off("spawn", onSpawn); child.off("error", onError); };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    try {
      const initializeResult = await this.request("initialize", {
        clientInfo: { name: "codex-mobile-remote", title: "Codex Mobile Remote", version: "0.3.2" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      if (this.options.expectedCodexHome) {
        const actualCodexHome = record(initializeResult)?.codexHome;
        if (!codexHomeMatches(this.options.expectedCodexHome, actualCodexHome)) {
          throw new Error(
            `codex app-server used unexpected CODEX_HOME; expected ${JSON.stringify(this.options.expectedCodexHome)}, got ${JSON.stringify(actualCodexHome)}`,
          );
        }
      }
      this.notify("initialized");
      this.initialized = true;
      this.emit("ready");
    } catch (error) {
      if (this.child === child) this.child = null;
      if (!child.killed) child.kill("SIGTERM");
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.initialized = false;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
    this.rejectPending(new Error("app-server stopped"));
  }

  async request(method: string, params: unknown = {}): Promise<unknown> {
    if (method !== "initialize" && !this.ready) await this.start();
    if (!this.child) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const message = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string, data?: unknown): void {
    this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  private write(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.emit("diagnostic", `non-JSON app-server output: ${trimmed}`);
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const response = message as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new Error(`${response.error.message} (${response.error.code})`));
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  private handleExit(error: Error): void {
    if (!this.child) return;
    this.child = null;
    this.initialized = false;
    this.rejectPending(error);
    this.emit("offline", error);
    if (!this.stopping) {
      setTimeout(() => void this.start().catch((restartError) => this.emit("offline", restartError)), this.restartDelayMs).unref();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function codexHomeMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !actual.trim()) return false;
  const windowsPath = looksLikeWindowsAbsolutePath(expected) || looksLikeWindowsAbsolutePath(actual);
  if (windowsPath) {
    return trimTrailingSeparators(win32.normalize(expected), win32.parse(expected).root.length).toLowerCase()
      === trimTrailingSeparators(win32.normalize(actual), win32.parse(actual).root.length).toLowerCase();
  }
  return trimTrailingSeparators(posix.normalize(expected), posix.parse(expected).root.length)
    === trimTrailingSeparators(posix.normalize(actual), posix.parse(actual).root.length);
}

function looksLikeWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function trimTrailingSeparators(value: string, rootLength: number): string {
  let result = value;
  while (result.length > rootLength && /[\\/]$/.test(result)) result = result.slice(0, -1);
  return result;
}
