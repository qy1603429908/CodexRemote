import { randomUUID } from "node:crypto";
import type { ServerMessage, ThreadSummary } from "@codex-mobile/protocol";

export interface JournalEntry {
  cursor: number;
  message: ServerMessage;
  threadId?: string;
}

export class SyncJournal {
  readonly version = randomUUID();
  private cursor = 0;
  private readonly entries: JournalEntry[] = [];
  private retainedBytes = 0;

  constructor(
    private readonly maxEntries = 2_000,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  get latestCursor(): number {
    return this.cursor;
  }

  append(message: ServerMessage, threadId?: string): ServerMessage {
    const cursor = ++this.cursor;
    const enriched = { ...message, syncVersion: this.version, syncCursor: cursor } as ServerMessage;
    const bytes = Buffer.byteLength(JSON.stringify(enriched));
    this.entries.push({ cursor, message: enriched, ...(threadId ? { threadId } : {}) });
    this.retainedBytes += bytes;
    while (this.entries.length > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.retainedBytes -= Buffer.byteLength(JSON.stringify(removed.message));
    }
    return enriched;
  }

  replay(version: string | undefined, afterCursor: number | undefined, threadIds: string[]): {
    reset: boolean;
    events: ServerMessage[];
    latestCursor: number;
  } {
    if (version !== this.version || afterCursor == null || !Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      return { reset: true, events: [], latestCursor: this.cursor };
    }
    const oldestCursor = this.entries[0]?.cursor ?? this.cursor + 1;
    if (afterCursor < oldestCursor - 1) return { reset: true, events: [], latestCursor: this.cursor };
    const subscriptions = new Set(threadIds);
    return {
      reset: false,
      events: this.entries
        .filter((entry) => entry.cursor > afterCursor && (!entry.threadId || subscriptions.has(entry.threadId)))
        .map((entry) => entry.message),
      latestCursor: this.cursor,
    };
  }
}

interface ThreadChange {
  version: number;
  upserts: ThreadSummary[];
  removedIds: string[];
}

export class ThreadIndexStore {
  private readonly threads = new Map<string, ThreadSummary>();
  private readonly changes: ThreadChange[] = [];
  private initialized = false;
  private version = 0;

  get currentVersion(): number {
    return this.version;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  snapshot(): ThreadSummary[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  replace(items: ThreadSummary[]): void {
    const overlays = new Map(this.threads);
    this.threads.clear();
    for (const item of items) this.threads.set(item.id, clone(item));
    for (const [id, overlay] of overlays) {
      const base = this.threads.get(id);
      if (!base || overlay.updatedAt >= base.updatedAt || statusActive(overlay.status)) {
        this.threads.set(id, { ...base, ...clone(overlay) });
      }
    }
    this.initialized = true;
    this.version = Math.max(1, this.version + 1);
    this.changes.length = 0;
  }

  upsert(item: ThreadSummary): ThreadChange | null {
    if (!item.id) return null;
    const current = this.threads.get(item.id);
    const next = current ? { ...current, ...clone(item) } : clone(item);
    if (current && JSON.stringify(current) === JSON.stringify(next)) return null;
    this.threads.set(item.id, next);
    const change = { version: ++this.version, upserts: [clone(next)], removedIds: [] };
    this.record(change);
    return change;
  }

  patch(id: string, patch: Partial<ThreadSummary>): ThreadChange | null {
    const current = this.threads.get(id);
    if (!current) return null;
    return this.upsert({ ...current, ...patch, id });
  }

  remove(id: string): ThreadChange | null {
    if (!this.threads.delete(id)) return null;
    const change = { version: ++this.version, upserts: [], removedIds: [id] };
    this.record(change);
    return change;
  }

  deltaAfter(knownVersion: number): ThreadChange | null {
    if (knownVersion === this.version) return { version: this.version, upserts: [], removedIds: [] };
    const first = this.changes[0];
    if (!first || knownVersion < first.version - 1 || knownVersion > this.version) return null;
    const upserts = new Map<string, ThreadSummary>();
    const removed = new Set<string>();
    for (const change of this.changes) {
      if (change.version <= knownVersion) continue;
      for (const id of change.removedIds) {
        removed.add(id);
        upserts.delete(id);
      }
      for (const item of change.upserts) {
        removed.delete(item.id);
        upserts.set(item.id, clone(item));
      }
    }
    return { version: this.version, upserts: [...upserts.values()], removedIds: [...removed] };
  }

  private record(change: ThreadChange): void {
    this.changes.push(change);
    while (this.changes.length > 2_000) this.changes.shift();
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function statusActive(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return String((value as { type?: unknown }).type ?? "").toLowerCase() === "active";
}
