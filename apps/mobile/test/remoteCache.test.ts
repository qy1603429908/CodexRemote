import { describe, expect, it } from "vitest";
import { cacheScope, clearRemoteCache, compactCache, loadRemoteCache, messagesForThread, type RemoteCacheSnapshot } from "../src/lib/remoteCache";

describe("remote cache", () => {
  it("does not persist streaming reasoning summaries as durable conversation history", () => {
    const reasoning = {
      id: "reason", threadId: "thread", turnId: "turn", role: "system" as const, content: "数小时前的旧梗概",
      createdAt: 1, status: "streaming" as const, itemType: "reasoning", toolName: "思考梗概",
    };
    const durable = {
      id: "answer", threadId: "thread", turnId: "turn", role: "assistant" as const, content: "保留的回答",
      createdAt: 2, status: "complete" as const,
    };
    const snapshot: RemoteCacheSnapshot = {
      schema: 4, savedAt: 1, syncCursor: 0, threadIndexVersion: 1, selectedThreadId: "thread",
      threads: [{ id: "thread", title: "task", preview: "", updatedAt: 2, state: "running", unread: 0, cwd: "/tmp", modelProvider: "" }],
      messagesByThread: { thread: [reasoning, durable] }, historyByThread: {},
    };
    expect(compactCache(snapshot).messagesByThread.thread).toEqual([durable]);
  });

  it("uses endpoint and token as an isolated stable scope", () => {
    expect(cacheScope("HTTPS://HOST/", "token")).toBe(cacheScope("https://host", "token"));
    expect(cacheScope("https://host", "token-a")).not.toBe(cacheScope("https://host", "token-b"));
  });

  it("filters messages by the target thread id", () => {
    const owned = { id: "owned", threadId: "child", role: "assistant" as const, content: "child", createdAt: 1, status: "complete" as const };
    const foreign = { ...owned, id: "foreign", threadId: "parent" };
    expect(messagesForThread("child", [foreign, owned])).toEqual([owned]);
  });

  it("removes foreign messages from every bucket during compaction", () => {
    const child = { id: "child-message", threadId: "child", role: "assistant" as const, content: "child", createdAt: 1, status: "complete" as const };
    const parent = { ...child, id: "parent-message", threadId: "parent" };
    const snapshot: RemoteCacheSnapshot = {
      schema: 4, savedAt: 1, syncCursor: 2, threadIndexVersion: 3, selectedThreadId: "child",
      threads: [
        { id: "child", title: "Child", preview: "", cwd: "/tmp", modelProvider: "custom", updatedAt: 2, state: "idle", unread: 0 },
        { id: "parent", title: "Parent", preview: "", cwd: "/tmp", modelProvider: "custom", updatedAt: 1, state: "idle", unread: 0 },
      ],
      messagesByThread: { child: [parent, child], parent: [child, parent] },
      historyByThread: {},
    };
    expect(compactCache(snapshot).messagesByThread).toEqual({ child: [child], parent: [parent] });
  });

  it("sanitizes a polluted fallback cache while loading", async () => {
    const child = { id: "child-message", threadId: "child", role: "assistant" as const, content: "child", createdAt: 1, status: "complete" as const };
    const parent = { ...child, id: "parent-message", threadId: "parent" };
    const snapshot: RemoteCacheSnapshot = {
      schema: 4, savedAt: 1, syncCursor: 2, threadIndexVersion: 3, selectedThreadId: "child",
      threads: [{ id: "child", title: "Child", preview: "", cwd: "/tmp", modelProvider: "custom", updatedAt: 1, state: "idle", unread: 0 }],
      messagesByThread: { child: [child, parent] },
      historyByThread: {},
    };
    const values = new Map([["codex-mobile.remote-cache.v4.polluted", JSON.stringify(snapshot)]]);
    const storage = {
      get length() { return values.size; },
      key(index: number) { return [...values.keys()][index] ?? null; },
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
      clear() { values.clear(); },
    };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      expect((await loadRemoteCache("polluted"))?.messagesByThread).toEqual({ child: [child] });
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      if (originalIndexedDb) Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  it("bounds persisted histories and removes volatile detail payloads", () => {
    const threads = Array.from({ length: 30 }, (_, index) => ({ id: `t-${index}`, title: `T${index}`, preview: "", cwd: "/tmp", modelProvider: "custom", updatedAt: index, state: "idle" as const, unread: 0 }));
    const snapshot: RemoteCacheSnapshot = { schema: 4, savedAt: 1, syncCursor: 2, threadIndexVersion: 3, selectedThreadId: "t-0", threads, messagesByThread: Object.fromEntries(threads.map((thread) => [thread.id, Array.from({ length: 510 }, (_, index) => ({ id: `${thread.id}-${index}`, threadId: thread.id, role: "assistant" as const, content: "x", createdAt: index, status: "complete" as const, detail: { large: true } }))])), historyByThread: Object.fromEntries(threads.map((thread) => [thread.id, { nextCursor: null, backwardsCursor: null, hasMore: false, loaded: true }])) };
    const compacted = compactCache(snapshot);
    expect(Object.keys(compacted.messagesByThread)).toHaveLength(25);
    expect(compacted.messagesByThread["t-0"]).toHaveLength(500);
    expect(compacted.messagesByThread["t-0"]?.[0]).not.toHaveProperty("detail");
  });

  it("clears fallback caches from every schema version while preserving unrelated storage", async () => {
    const values = new Map<string, string>([
      ["codex-mobile.remote-cache.v2.old", "old"],
      ["codex-mobile.remote-cache.v3.current", "stale"],
      ["codex-mobile.remote-cache.v4.current", "current"],
      ["unrelated", "keep"],
    ]);
    const storage = {
      get length() { return values.size; },
      key(index: number) { return [...values.keys()][index] ?? null; },
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
      clear() { values.clear(); },
    };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      await clearRemoteCache();
      expect([...values.entries()]).toEqual([["unrelated", "keep"]]);
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      if (originalIndexedDb) Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

  it("reports a fallback cleanup failure instead of claiming a successful full refresh", async () => {
    const storage = {
      get length() { return 1; },
      key() { return "codex-mobile.remote-cache.v3.current"; },
      getItem() { return "stale"; },
      setItem() {},
      removeItem() { throw new Error("storage denied"); },
      clear() {},
    };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      await expect(clearRemoteCache()).rejects.toThrow(/无法完全清除本地缓存/);
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      if (originalIndexedDb) Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
      else delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  });

});
