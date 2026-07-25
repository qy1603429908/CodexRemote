import { describe, expect, it } from "vitest";
import { DesktopIpcBridge, canonicalTurns, isExplicitInactiveSteerError, isUncertainDesktopSubmissionError, normalizeDesktopConversation } from "../src/desktop-ipc-bridge.js";

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

  it("emits per-conversation native queued-follow-up broadcasts", () => {
    const bridge = new DesktopIpcBridge(false);
    let observed: unknown;
    bridge.on("queuedFollowUps", (event) => { observed = event; });
    (bridge as unknown as { handleFrame(frame: unknown): void }).handleFrame({
      type: "broadcast",
      method: "thread-queued-followups-changed",
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

  it("reports whether Desktop IPC is supported on the current host", () => {
    expect(new DesktopIpcBridge(true).supported).toBe(process.platform !== "win32");
    expect(new DesktopIpcBridge(false).supported).toBe(false);
  });

});
