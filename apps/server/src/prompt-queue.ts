import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PromptQueueStatus = "queued" | "sending" | "paused" | "failed" | "uncertain";

export interface PromptQueueItem {
  id: string;
  threadId: string;
  clientUserMessageId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  status: PromptQueueStatus;
  fileNames: string[];
  error?: string;
}

export interface PromptQueueInput {
  threadId: string;
  clientUserMessageId: string;
  text: string;
  turnParams: Record<string, unknown>;
  fileNames?: string[];
  filePaths?: string[];
  uploadIds?: string[];
}

export interface StoredPromptQueueItem extends PromptQueueItem {
  turnParams: Record<string, unknown>;
  filePaths: string[];
  uploadIds: string[];
}

interface QueueDocument {
  version: 1;
  items: StoredPromptQueueItem[];
}

export class PromptQueueStore {
  private readonly items = new Map<string, StoredPromptQueueItem>();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly filename: string, private readonly now: () => number) {}

  static async create(filename: string, now = () => Date.now()): Promise<PromptQueueStore> {
    const store = new PromptQueueStore(filename, now);
    await store.load();
    return store;
  }

  list(threadId?: string): PromptQueueItem[] {
    return [...this.items.values()]
      .filter((item) => !threadId || item.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicItem);
  }

  protectedFilePaths(): Set<string> {
    return new Set([...this.items.values()].flatMap((item) => item.filePaths));
  }

  get(id: string): StoredPromptQueueItem | null {
    const item = this.items.get(id);
    return item ? cloneStored(item) : null;
  }

  async enqueue(input: PromptQueueInput): Promise<StoredPromptQueueItem> {
    const duplicate = [...this.items.values()].find(
      (item) => item.threadId === input.threadId && item.clientUserMessageId === input.clientUserMessageId,
    );
    if (duplicate) {
      if (duplicate.text !== input.text || JSON.stringify(duplicate.turnParams) !== JSON.stringify(input.turnParams)) {
        throw new Error("idempotency_conflict: queued clientUserMessageId already belongs to different content");
      }
      return cloneStored(duplicate);
    }
    const timestamp = this.now();
    const item: StoredPromptQueueItem = {
      id: randomUUID(),
      threadId: input.threadId,
      clientUserMessageId: input.clientUserMessageId,
      text: input.text,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "queued",
      fileNames: [...(input.fileNames ?? [])],
      filePaths: [...(input.filePaths ?? [])],
      uploadIds: [...(input.uploadIds ?? [])],
      turnParams: structuredClone(input.turnParams),
    };
    this.items.set(item.id, item);
    await this.persist();
    return cloneStored(item);
  }

  async claimNext(threadId: string): Promise<StoredPromptQueueItem | null> {
    const item = [...this.items.values()]
      .filter((candidate) => candidate.threadId === threadId && candidate.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    return item ? this.claim(item.id) : null;
  }

  async claim(id: string): Promise<StoredPromptQueueItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    item.status = "sending";
    item.updatedAt = this.now();
    delete item.error;
    await this.persist();
    return cloneStored(item);
  }

  async requeue(id: string, error?: string): Promise<PromptQueueItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    item.status = "queued";
    item.updatedAt = this.now();
    if (error) item.error = error; else delete item.error;
    await this.persist();
    return publicItem(item);
  }

  async pauseThread(threadId: string, reason: string): Promise<boolean> {
    let changed = false;
    for (const item of this.items.values()) {
      if (item.threadId !== threadId || item.status !== "queued") continue;
      item.status = "paused";
      item.error = reason;
      item.updatedAt = this.now();
      changed = true;
    }
    if (changed) await this.persist();
    return changed;
  }

  async resumeThread(threadId: string): Promise<boolean> {
    let changed = false;
    for (const item of this.items.values()) {
      if (item.threadId !== threadId || item.status !== "paused") continue;
      item.status = "queued";
      delete item.error;
      item.updatedAt = this.now();
      changed = true;
    }
    if (changed) await this.persist();
    return changed;
  }

  async complete(id: string): Promise<PromptQueueItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    await this.persist();
    return publicItem(item);
  }

  async fail(id: string, error: string, uncertain = false): Promise<PromptQueueItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    item.status = uncertain ? "uncertain" : "failed";
    item.error = error;
    item.updatedAt = this.now();
    await this.persist();
    return publicItem(item);
  }

  async cancel(id: string): Promise<PromptQueueItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id);
    await this.persist();
    return publicItem(item);
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filename, "utf8")) as Partial<QueueDocument>;
      if (raw.version !== 1 || !Array.isArray(raw.items)) return;
      let recoveredSending = false;
      for (const value of raw.items) {
        if (!validStoredItem(value)) continue;
        const item = cloneStored(value);
        if (item.status === "sending") {
          item.status = "uncertain";
          item.error = "Host 在投递过程中重启，结果未知；请先刷新历史，再取消或手动立即引导。";
          item.updatedAt = this.now();
          recoveredSending = true;
        }
        this.items.set(item.id, item);
      }
      if (recoveredSending) await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
  }

  private persist(): Promise<void> {
    const document: QueueDocument = { version: 1, items: [...this.items.values()].map(cloneStored) };
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.filename);
      await chmod(this.filename, 0o600);
    });
    return this.writeChain;
  }
}

function publicItem(item: StoredPromptQueueItem): PromptQueueItem {
  const { turnParams: _turnParams, filePaths: _filePaths, uploadIds: _uploadIds, ...rest } = item;
  return structuredClone(rest);
}

function cloneStored(item: StoredPromptQueueItem): StoredPromptQueueItem {
  return structuredClone(item);
}

function validStoredItem(value: unknown): value is StoredPromptQueueItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredPromptQueueItem>;
  return typeof item.id === "string"
    && typeof item.threadId === "string"
    && typeof item.clientUserMessageId === "string"
    && typeof item.text === "string"
    && typeof item.createdAt === "number"
    && typeof item.updatedAt === "number"
    && ["queued", "sending", "paused", "failed", "uncertain"].includes(String(item.status))
    && Array.isArray(item.fileNames)
    && Array.isArray(item.filePaths)
    && Array.isArray(item.uploadIds)
    && Boolean(item.turnParams && typeof item.turnParams === "object" && !Array.isArray(item.turnParams));
}
