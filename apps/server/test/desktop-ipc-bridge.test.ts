import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { DesktopIpcBridge, applyDesktopPatches, canonicalTurns, defaultDesktopIpcEndpoint, isExplicitInactiveSteerError, isUncertainDesktopSubmissionError, isWindowsNamedPipeEndpoint, normalizeDesktopConversation } from "../src/desktop-ipc-bridge.js";

function ipcFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Desktop IPC approval forwarding", () => {
  it("forwards native Computer Use elicitation responses with the Desktop follower payload", async () => {
    const bridge = new DesktopIpcBridge(false);
    const calls: Array<{ conversationId: string; method: string; params: Record<string, unknown> }> = [];
    const internal = bridge as unknown as {
      requestFollower(
        conversationId: string,
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };
    internal.requestFollower = async (conversationId, method, params) => {
      calls.push({ conversationId, method, params });
      return { ok: true };
    };

    const response = { action: "accept", content: null, _meta: null };
    await bridge.resolveApproval(
      "thread-cu",
      "mcpServer/elicitation/request",
      47,
      response,
    );

    expect(calls).toEqual([{
      conversationId: "thread-cu",
      method: "thread-follower-submit-mcp-server-elicitation-response",
      params: {
        conversationId: "thread-cu",
        requestId: 47,
        response,
      },
    }]);
  });
});

describe("Desktop IPC canonical history", () => {
  it("converts canonical turnHistory islands into ordered turns", () => {
    const first = { turnId: "turn-1", status: "completed", items: [{ type: "userMessage", content: "one" }] };
    const tail = { turnId: "turn-2", status: "inProgress", items: [{ type: "agentMessage", text: "two" }] };
    const conversation = {
      id: "thread-1",
      turns: [],
      turnHistory: {
        kind: "canonical",
        history: {
          isComplete: true,
          entitiesByKey: { "turn:1": first, "tail:0": tail },
          islands: [{ entries: [{ value: "turn:1" }, { value: "tail:0" }] }],
        },
      },
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      source: "vscode",
    };
    expect(canonicalTurns(conversation)).toEqual([first, tail]);
    expect(normalizeDesktopConversation("thread-1", "local", conversation)).toMatchObject({
      id: "thread-1",
      turns: [first, tail],
      status: { type: "active", activeFlags: [] },
      source: { desktopIpc: true, original: "vscode" },
    });
  });

  it("keeps the original Desktop source stable across normalized patches", () => {
    let conversation = normalizeDesktopConversation("thread-1", "local", {
      id: "thread-1",
      source: "vscode",
      turns: [],
      marker: 0,
    });
    for (let revision = 1; revision <= 100; revision += 1) {
      conversation = normalizeDesktopConversation(
        "thread-1",
        "local",
        applyDesktopPatches(conversation, [
          { op: "replace", path: ["marker"], value: revision },
        ]),
      );
    }
    expect(conversation.source).toEqual({ desktopIpc: true, original: "vscode" });
  });

  it("ignores state broadcasts for other clients and owner replacements", () => {
    const bridge = new DesktopIpcBridge(false);
    const internal = bridge as unknown as {
      clientId: string | null;
      handleFrame(frame: unknown): void;
    };
    internal.clientId = "bridge-client";
    const snapshots: Array<Record<string, unknown>> = [];
    bridge.on("snapshot", (thread) => snapshots.push(thread));
    bridge.on("diagnostic", () => {});
    const snapshot = (
      sourceClientId: string,
      targetClientIds: string[],
      revision: number,
      marker: string,
    ) => ({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId,
      targetClientIds,
      params: {
        conversationId: "thread-1",
        hostId: "local",
        change: {
          type: "snapshot",
          revision,
          conversationState: { id: "thread-1", marker, turns: [] },
        },
      },
    });

    internal.handleFrame(snapshot("rogue", ["different-client"], 1, "wrong-target"));
    expect(bridge.getConversation("thread-1")).toBeNull();

    internal.handleFrame(snapshot("owner-one", ["bridge-client"], 1, "unsolicited"));
    expect(bridge.getConversation("thread-1")).toBeNull();

    internal.handleFrame({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: "owner-one",
      targetClientIds: ["bridge-client"],
      params: { conversationId: "thread-1", hostId: "local", following: true },
    });
    internal.handleFrame(snapshot("owner-one", ["bridge-client"], 1, "accepted"));
    internal.handleFrame(snapshot("owner-two", ["bridge-client"], 2, "replaced"));
    expect(snapshots).toHaveLength(1);
    expect(bridge.getConversation("thread-1")?.marker).toBe("accepted");

    internal.handleFrame({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: "owner-one",
      targetClientIds: ["bridge-client"],
      params: { conversationId: "thread-1", hostId: "local", following: false },
    });
    internal.handleFrame(snapshot("owner-two", ["bridge-client"], 3, "new-owner"));
    expect(snapshots).toHaveLength(2);
    expect(bridge.getConversation("thread-1")?.marker).toBe("new-owner");
  });

  it("emits per-conversation native queued-follow-up broadcasts", () => {
    const bridge = new DesktopIpcBridge(false);
    let observed: unknown;
    bridge.on("queuedFollowUps", (event) => { observed = event; });
    (bridge as unknown as { handleFrame(frame: unknown): void }).handleFrame({
      type: "broadcast",
      method: "thread-queued-followups-changed",
      version: 1,
      params: { conversationId: "thread-1", messages: [{ id: "desktop-q1", text: "next" }] },
    });
    expect(observed).toEqual({ conversationId: "thread-1", messages: [{ id: "desktop-q1", text: "next" }] });
  });

  it("falls back to legacy turns when canonical history is unavailable", () => {
    const turns = [{ id: "legacy", items: [] }];
    expect(canonicalTurns({ turns, turnHistory: {} })).toBe(turns);
  });

  it("prefers canonical order and appends a live tail without duplicating turns", () => {
    const canonical = { id: "turn-1", items: [{ type: "userMessage", content: "one" }] };
    const liveTail = { id: "turn-2", items: [{ type: "agentMessage", text: "two" }] };
    expect(canonicalTurns({
      turns: [canonical, liveTail],
      turnHistory: {
        history: {
          entitiesByKey: { first: canonical },
          islands: [{ entries: [{ value: "first" }] }],
        },
      },
    })).toEqual([canonical, liveTail]);
  });
  it("classifies only explicit inactive steer failures as safe start fallbacks", () => {
    expect(isExplicitInactiveSteerError(new Error("SteerTurnInactiveError: active turn already ended"))).toBe(true);
    expect(isExplicitInactiveSteerError(new Error("NoActiveTurn(thread-1)"))).toBe(true);
    expect(isExplicitInactiveSteerError(new Error("Desktop IPC request timed out"))).toBe(false);
    expect(isExplicitInactiveSteerError(new Error("connection closed"))).toBe(false);
  });

  it("classifies timeout and disconnect errors as uncertain submissions", () => {
    expect(isUncertainDesktopSubmissionError(new Error("Desktop IPC request timed out: steer"))).toBe(true);
    expect(isUncertainDesktopSubmissionError({ message: "Desktop IPC connection closed." })).toBe(true);
    expect(isUncertainDesktopSubmissionError(new Error("active turn already ended"))).toBe(false);
  });

  it("selects the platform IPC endpoint and validates Windows named pipes", () => {
    expect(defaultDesktopIpcEndpoint("win32", "C:\\Users\\alice")).toBe("\\\\.\\pipe\\codex-ipc");
    expect(defaultDesktopIpcEndpoint("darwin", "/Users/alice")).toBe("/Users/alice/.codex/ipc/ipc.sock");
    expect(isWindowsNamedPipeEndpoint("\\\\.\\pipe\\codex-ipc")).toBe(true);
    expect(isWindowsNamedPipeEndpoint("\\\\.\\pipe\\cmr.test-1")).toBe(true);
    expect(isWindowsNamedPipeEndpoint("C:\\tmp\\ipc.sock")).toBe(false);
    expect(new DesktopIpcBridge(true, undefined, "win32").supported).toBe(true);
    expect(new DesktopIpcBridge(false, undefined, "win32").supported).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("connects to the Windows named pipe and auto-follows the active Desktop task", async () => {
    const pipe = `\\\\.\\pipe\\cmr-ipc-test-${randomUUID()}`;
    const conversationId = "thread-windows-active";
    const bridgeClientId = "bridge-client";
    const ownerClientId = "desktop-owner";
    let requestedFollowingStatus = false;
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (buffer.length < 4 + length) return;
          const frame = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
          buffer = buffer.subarray(4 + length);
          if (frame.type === "request" && frame.method === "initialize") {
            socket.write(ipcFrame({ type: "response", method: "initialize", requestId: frame.requestId, result: { clientId: bridgeClientId } }));
          } else if (frame.type === "broadcast" && frame.method === "thread-stream-following-status-requested") {
            requestedFollowingStatus = true;
            socket.write(ipcFrame({
              type: "broadcast",
              method: "thread-stream-following-changed",
              version: 1,
              sourceClientId: "desktop-renderer",
              targetClientIds: [bridgeClientId],
              params: { conversationId, hostId: "local", following: true },
            }));
          } else if (frame.type === "broadcast" && frame.method === "thread-stream-following-changed") {
            const snapshot = ipcFrame({
              type: "broadcast",
              method: "thread-stream-state-changed",
              version: 11,
              sourceClientId: ownerClientId,
              targetClientIds: [bridgeClientId],
              params: {
                conversationId,
                hostId: "local",
                change: {
                  type: "snapshot",
                  revision: 7,
                  conversationState: {
                    id: conversationId,
                    cwd: "C:\\Users\\alice\\project",
                    threadRuntimeStatus: { type: "active", activeFlags: [] },
                    turns: [],
                    turnHistory: {
                      kind: "canonical",
                      history: {
                        entitiesByKey: {
                          active: { id: "turn-active", status: "inProgress", items: [{ type: "agentMessage", text: "streaming" }] },
                        },
                        islands: [{ entries: [{ value: "active" }] }],
                      },
                    },
                  },
                },
              },
            });
            socket.write(snapshot.subarray(0, 3));
            socket.write(snapshot.subarray(3));
          } else if (frame.type === "client-discovery-response") {
            continue;
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
    const bridge = new DesktopIpcBridge(true, pipe, "win32");
    try {
      await bridge.start();
      await waitUntil(() => bridge.ready && bridge.hasOwner(conversationId));
      expect(requestedFollowingStatus).toBe(true);
      expect(bridge.getConversation(conversationId)).toMatchObject({
        id: conversationId,
        cwd: "C:\\Users\\alice\\project",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-active", status: "inProgress" }],
      });
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("applies contiguous Desktop patches immediately and ignores stale revisions", () => {
    const bridge = new DesktopIpcBridge(false);
    const snapshots: Array<Record<string, unknown>> = [];
    bridge.on("snapshot", (thread) => snapshots.push(thread));
    const handleFrame = (bridge as unknown as { handleFrame(frame: unknown): void }).handleFrame.bind(bridge);
    handleFrame({
      type: "broadcast",
      method: "thread-stream-following-changed",
      version: 1,
      sourceClientId: "owner",
      params: { conversationId: "thread-1", hostId: "local", following: true },
    });
    handleFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner",
      params: {
        conversationId: "thread-1",
        hostId: "local",
        change: {
          type: "snapshot",
          revision: 4,
          conversationState: {
            id: "thread-1",
            threadRuntimeStatus: { type: "active", activeFlags: [] },
            turnHistory: {
              history: {
                entitiesByKey: { active: { id: "turn-1", status: "inProgress", items: [{ id: "item-1", text: "a" }] } },
                islands: [{ entries: [{ value: "active" }] }],
              },
            },
          },
        },
      },
    });
    handleFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner",
      params: {
        conversationId: "thread-1",
        hostId: "local",
        change: {
          type: "patches",
          baseRevision: 4,
          revision: 5,
          patches: [
            { op: "replace", path: ["turnHistory", "history", "entitiesByKey", "active", "items", 0, "text"], value: "streamed" },
            { op: "add", path: ["turnHistory", "history", "entitiesByKey", "active", "items", 1], value: { id: "item-2", text: "next" } },
          ],
        },
      },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)?.turns).toEqual([
      { id: "turn-1", status: "inProgress", items: [{ id: "item-1", text: "streamed" }, { id: "item-2", text: "next" }] },
    ]);
    handleFrame({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner",
      params: {
        conversationId: "thread-1",
        change: { type: "patches", baseRevision: 4, revision: 5, patches: [] },
      },
    });
    expect(snapshots).toHaveLength(2);
  });

});
