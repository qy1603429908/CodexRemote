import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ServerMessage, ThreadSummary } from "@codex-mobile/protocol";
import { SyncJournal, ThreadIndexStore } from "../src/sync-state.js";

function summary(index: number): ThreadSummary {
  return {
    id: `thread-${index}`,
    name: `Task ${index}`,
    preview: `Public-network history preview ${index} `.repeat(5),
    cwd: `/workspace/project-${index % 8}`,
    modelProvider: "custom",
    updatedAt: 1_700_000_000 + index,
    status: { type: "notLoaded" },
    parentThreadId: null,
    agentNickname: null,
    agentRole: null,
    source: "appServer",
  };
}

describe("incremental synchronization", () => {
  it("reduces a 1000-task reconnect to one changed summary", () => {
    const index = new ThreadIndexStore();
    index.replace(Array.from({ length: 1_000 }, (_, item) => summary(item)));
    const initialVersion = index.currentVersion;
    const welcome = { type: "welcome", version: "0.3.0", serverId: "test", codexReady: true, syncVersion: "boot", latestCursor: 0, threadIndexVersion: initialVersion };
    const initial = { type: "threads.snapshot", requestId: "initial", version: initialVersion, threads: index.snapshot() };

    index.upsert({ ...summary(500), preview: "one changed task", updatedAt: 1_800_000_000 });
    const delta = index.deltaAfter(initialVersion);
    expect(delta?.upserts).toHaveLength(1);
    expect(delta?.removedIds).toHaveLength(0);
    const replay = { type: "sync.replay", requestId: "resume", syncVersion: "boot", fromCursor: 0, toCursor: 0, events: [] };
    const reconnect = { type: "threads.delta", requestId: "delta", baseVersion: initialVersion, ...delta };

    const firstBytes = [welcome, initial].reduce((total, frame) => total + Buffer.byteLength(JSON.stringify(frame)), 0);
    const reconnectBytes = [welcome, replay, reconnect].reduce((total, frame) => total + Buffer.byteLength(JSON.stringify(frame)), 0);
    console.info(`SYNC_BYTES first_full_frames=2 first_full_bytes=${firstBytes} reconnect_frames=3 reconnect_bytes=${reconnectBytes} ratio=${(reconnectBytes / firstBytes).toFixed(4)}`);
    expect(reconnectBytes).toBeLessThan(firstBytes * 0.02);
  });

  it("replays only unseen subscribed events and rejects an expired cursor", () => {
    const journal = new SyncJournal(2, 1_000_000);
    const first = journal.append({ type: "status", codexReady: true } as ServerMessage);
    journal.append({ type: "event", method: "turn/started", params: { threadId: "thread-a" } } as ServerMessage, "thread-a");
    journal.append({ type: "event", method: "turn/started", params: { threadId: "thread-b" } } as ServerMessage, "thread-b");
    const replay = journal.replay(journal.version, first.syncCursor, ["thread-a"]);
    expect(replay.reset).toBe(false);
    expect(replay.events).toHaveLength(1);
    expect(journal.replay(journal.version, 0, ["thread-a"]).reset).toBe(true);
  });
});
