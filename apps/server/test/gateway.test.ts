import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MobileGateway, desktopAttachmentPaths, isAbsoluteHostPath, projectDesktopLiveThread } from "../src/gateway.js";
import type { ServerConfig } from "../src/config.js";
import { PromptQueueStore } from "../src/prompt-queue.js";


describe("Desktop live turn projection", () => {
  it("deduplicates the same active turn when Desktop exposes turnId without id", () => {
    const projected = projectDesktopLiveThread({
      id: "thread-1",
      turns: [
        { turnId: "turn-old", status: "completed", startedAt: 1, items: [{ id: "user-old", type: "userMessage" }] },
        { turnId: "turn-active", status: "inProgress", startedAt: 2, items: [{ id: "assistant-active", type: "agentMessage", text: "working" }] },
      ],
    });
    const turns = projected.turns as Array<Record<string, unknown>>;
    expect(turns.map((turn) => turn.id)).toEqual(["turn-old", "turn-active"]);
    expect(turns.filter((turn) => turn.id === "turn-active")).toHaveLength(1);
  });

  it("keeps the freshest fields and merges items for duplicate canonical turns", () => {
    const projected = projectDesktopLiveThread({
      id: "thread-1",
      turns: [
        { turnId: "turn-active", status: "inProgress", startedAt: 2, items: [{ itemId: "shared", type: "agentMessage", text: "old" }, { id: "first", type: "reasoning" }] },
        { turnId: "turn-active", status: "inProgress", startedAt: 2, updatedAt: 3, items: [{ itemId: "shared", type: "agentMessage", text: "new" }, { id: "second", type: "commandExecution" }] },
      ],
    });
    const turns = projected.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: "turn-active", turnId: "turn-active", updatedAt: 3 });
    expect(turns[0]?.items).toEqual([
      { itemId: "shared", id: "shared", type: "agentMessage", text: "new" },
      { id: "first", type: "reasoning" },
      { id: "second", type: "commandExecution" },
    ]);
  });
});

class FakeBridge extends EventEmitter {
  ready = true;
  calls: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: string | number; result: unknown }> = [];
  threadListData: Array<Record<string, unknown>> = [
    { id: "thread-1", name: "Test", preview: "Hello", cwd: "/tmp", modelProvider: "custom", updatedAt: 1, status: { type: "notLoaded" }, parentThreadId: null, agentNickname: null, agentRole: null, source: "appServer" },
    { id: "agent-1", name: "Agent", preview: "Review", cwd: "/tmp", modelProvider: "custom", updatedAt: 2, status: { type: "notLoaded" }, source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", agent_nickname: "Meitner", agent_role: "reviewer" } } } },
  ];
  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/list") {
      return { data: this.threadListData, nextCursor: null };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-1", name: "Test", cwd: "/tmp", turns: [] } };
    }
    if (method === "thread/turns/list") {
      const cursor = (params as { cursor?: string }).cursor;
      return cursor
        ? { data: [{ id: "turn-old", status: "completed", items: [] }], nextCursor: null, backwardsCursor: "newer" }
        : { data: [{ id: "turn-new", status: "completed", items: [] }], nextCursor: "older", backwardsCursor: null };
    }
    if (method === "model/list") {
      return { data: [{ id: "model-1", model: "model-1", displayName: "Model One", description: "Test model", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }] }] };
    }
    if (method === "skills/list") {
      return { data: [{ cwd: "/tmp", skills: [{ name: "review", description: "Review code", shortDescription: "Review", path: "/skills/review/SKILL.md", scope: "user", enabled: true }], errors: [] }] };
    }
    return {};
  }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  respondError(): void {}
}

class FakeDesktop extends EventEmitter {
  owner = true;
  steerError: Error | null = null;
  conversation: Record<string, unknown> = { id: "thread-1", threadRuntimeStatus: { type: "active", activeFlags: [] }, turns: [{ id: "turn-active", status: "inProgress", items: [] }] };
  calls: Array<{ method: string; threadId: string; params: Record<string, unknown> }> = [];
  hasOwner(): boolean { return this.owner; }
  getConversation(): Record<string, unknown> { return this.conversation; }
  async steerTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "steer", threadId, params });
    if (this.steerError) throw this.steerError;
    return { id: "steered" };
  }
  async startTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "start", threadId, params });
    return { id: "started" };
  }
}

const token = "correct-token-which-is-at-least-32-chars";
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  token,
  tokenDigest: createHash("sha256").update(token).digest(),
  allowedOrigins: new Set(["capacitor://localhost"]),
  codexBin: "codex",
  codexHome: "/tmp/.codex",
  serverId: "test-server",
  desktopIpc: true,
  fileRoots: ["/tmp"],
  uploadDirectory: "/tmp",
  promptQueueFile: "/tmp/cmr-test-prompt-queue.json",
};

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()?.(); });

async function start(desktop?: FakeDesktop, promptQueue?: PromptQueueStore) {
  const bridge = new FakeBridge();
  const gateway = new MobileGateway(bridge as never, config, desktop as never, undefined, promptQueue);
  const server = createServer();
  server.on("upgrade", (request, socket, head) => gateway.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  closers.push(async () => {
    gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { bridge, gateway, port: address.port };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}



describe("Host path validation", () => {
  it("accepts absolute paths for the current Server platform", () => {
    if (process.platform === "win32") {
      expect(isAbsoluteHostPath("C:\\Users\\alice\\project")).toBe(true);
      expect(isAbsoluteHostPath("\\\\server\\share\\project")).toBe(true);
    } else {
      expect(isAbsoluteHostPath("/tmp/project")).toBe(true);
      expect(isAbsoluteHostPath("C:\\Users\\alice\\project")).toBe(false);
    }
  });

  it("rejects relative and drive-relative paths", () => {
    expect(isAbsoluteHostPath("project/file.txt")).toBe(false);
    expect(isAbsoluteHostPath("C:project\\file.txt")).toBe(false);
  });
});

describe("Desktop attachment extraction", () => {
  it("trusts only canonical user attachment fields, not arbitrary tool output paths", () => {
    expect(desktopAttachmentPaths({
      turns: [{ items: [
        { type: "steeringUserMessage", input: [{ type: "text", text: "hello" }, { type: "localImage", path: "/tmp/screen.png" }], attachments: [{ fsPath: "/tmp/screen.png" }], restoreMessage: { context: { imageAttachments: [{ localPath: "/tmp/screen.png" }] } } },
        { type: "commandExecution", output: "/etc/passwd", path: "/etc/passwd" },
      ] }],
    })).toEqual(["/tmp/screen.png"]);
  });

  it.skipIf(process.platform !== "win32")("accepts canonical Windows attachment paths", () => {
    expect(desktopAttachmentPaths({
      turns: [{ items: [{
        type: "steeringUserMessage",
        attachments: [{ fsPath: "C:\\Users\\alice\\screen.png" }],
      }] }],
    })).toEqual(["C:\\Users\\alice\\screen.png"]);
  });
});

describe("MobileGateway", () => {
  it("authenticates and sends thread data", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await waitFor(() => messages.some((message) => message.type === "welcome"));
    expect(bridge.calls.some((call) => call.method === "thread/list")).toBe(false);
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial-sync" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));
    const threadsMessage = messages.find((message) => message.type === "threads.snapshot");
    const threads = threadsMessage?.threads as Array<{ id: string; parentThreadId: string | null; agentNickname: string | null }>;
    expect(threads.find((thread) => thread.id === "agent-1")).toMatchObject({ parentThreadId: "thread-1", agentNickname: "Meitner" });
    const listCall = bridge.calls.find((call) => call.method === "thread/list");
    expect(listCall?.params).toMatchObject({ sourceKinds: expect.arrayContaining(["appServer", "subAgent", "subAgentThreadSpawn"]) });
    ws.close();
  });



  it("refreshes an initially empty thread index after app-server reconnects", async () => {
    const { bridge, port } = await start();
    bridge.threadListData = [];
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    ws.send(JSON.stringify({ type: "threads.sync", requestId: "empty-index" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot" && message.requestId === "empty-index"));
    expect((messages.find((message) => message.requestId === "empty-index")?.threads as unknown[])).toHaveLength(0);

    bridge.threadListData = [{
      id: "windows-thread",
      name: "Windows task",
      preview: "Recovered",
      cwd: process.platform === "win32" ? "C:\\Users\\alice\\project" : "/tmp/project",
      modelProvider: "custom",
      updatedAt: 3,
      status: { type: "notLoaded" },
      source: "appServer",
    }];
    bridge.emit("ready");
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "recovered-index" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot" && message.requestId === "recovered-index"));
    expect((messages.find((message) => message.requestId === "recovered-index")?.threads as Array<{ id: string }>)).toMatchObject([{ id: "windows-thread" }]);
    ws.close();
  });

  it("keeps an app-server turn active when Desktop has not loaded the task", async () => {
    const desktop = new FakeDesktop();
    desktop.conversation = {
      id: "thread-1",
      threadRuntimeStatus: { type: "notLoaded" },
      turns: [],
    };
    const { bridge, port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial-sync" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));
    const welcome = messages.find((message) => message.type === "welcome");
    ws.send(JSON.stringify({ type: "sync.resume", requestId: "subscribe", syncVersion: welcome?.syncVersion, cursor: welcome?.latestCursor, threadIds: ["thread-1"] }));
    await waitFor(() => messages.some((message) => message.type === "sync.replay" && message.requestId === "subscribe"));

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-running", status: "inProgress" } },
    });
    desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => messages.some((message) => message.type === "event" && message.method === "desktop/threadSnapshot"));

    const desktopSnapshot = messages.findLast((message) => message.type === "event" && message.method === "desktop/threadSnapshot");
    const desktopParams = desktopSnapshot?.params as { thread?: { status?: unknown; threadRuntimeStatus?: unknown } } | undefined;
    expect(desktopParams?.thread?.status).toEqual({ type: "active", activeFlags: [] });
    expect(desktopParams?.thread?.threadRuntimeStatus).toEqual({ type: "active", activeFlags: [] });

    ws.send(JSON.stringify({ type: "threads.list", requestId: "active-after-not-loaded" }));
    await waitFor(() => messages.some((message) => message.type === "threads" && message.requestId === "active-after-not-loaded"));
    const activeThreadsMessage = messages.find((message) => message.type === "threads" && message.requestId === "active-after-not-loaded");
    const activeThreads = activeThreadsMessage?.threads as Array<{ id: string; status: unknown }>;
    expect(activeThreads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "active", activeFlags: [] });

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-running", status: "completed" } },
    });
    ws.send(JSON.stringify({ type: "threads.list", requestId: "idle-after-completed" }));
    await waitFor(() => messages.some((message) => message.type === "threads" && message.requestId === "idle-after-completed"));
    const idleThreadsMessage = messages.find((message) => message.type === "threads" && message.requestId === "idle-after-completed");
    const idleThreads = idleThreadsMessage?.threads as Array<{ id: string; status: unknown }>;
    expect(idleThreads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "idle" });
    ws.close();
  });

  it("does not let an inactive status notification override a known running turn", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    bridge.emit("notification", {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-new", status: "inProgress" } },
    });
    bridge.emit("notification", {
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "notLoaded" } },
    });
    await waitFor(() => messages.some((message) => message.type === "event" && message.method === "thread/status/changed"));
    const statusEvent = messages.findLast((message) => message.type === "event" && message.method === "thread/status/changed");
    expect((statusEvent?.params as { status?: unknown } | undefined)?.status).toEqual({ type: "active", activeFlags: [] });

    bridge.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-old", status: "completed" } },
    });
    ws.send(JSON.stringify({ type: "threads.list", requestId: "stale-completion" }));
    await waitFor(() => messages.some((message) => message.type === "threads" && message.requestId === "stale-completion"));
    const threadsMessage = messages.find((message) => message.type === "threads" && message.requestId === "stale-completion");
    const threads = threadsMessage?.threads as Array<{ id: string; status: unknown }>;
    expect(threads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "active", activeFlags: [] });
    ws.close();
  });

  it("opens recent history and pages older turns without a full resume payload", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    ws.send(JSON.stringify({ type: "thread.open", requestId: "open-page", threadId: "thread-1", historyLimit: 20 }));
    await waitFor(() => messages.some((message) => message.type === "thread" && message.requestId === "open-page"));
    expect(bridge.calls).toContainEqual({ method: "thread/resume", params: { threadId: "thread-1", excludeTurns: true } });
    expect(bridge.calls).toContainEqual({ method: "thread/turns/list", params: { threadId: "thread-1", limit: 20, sortDirection: "desc", itemsView: "full" } });
    expect(messages.find((message) => message.requestId === "open-page")?.history).toMatchObject({ nextCursor: "older", hasMore: true });

    ws.send(JSON.stringify({ type: "thread.history", requestId: "older-page", threadId: "thread-1", cursor: "older", limit: 20 }));
    await waitFor(() => messages.some((message) => message.type === "thread.history" && message.requestId === "older-page"));
    expect(bridge.calls).toContainEqual({ method: "thread/turns/list", params: { threadId: "thread-1", cursor: "older", limit: 20, sortDirection: "desc", itemsView: "full" } });
    expect(messages.find((message) => message.requestId === "older-page")?.history).toMatchObject({ nextCursor: null, hasMore: false });
    ws.close();
  });

  it("lists models and workspace skills", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "models.list", requestId: "models-1" }));
    ws.send(JSON.stringify({ type: "skills.list", requestId: "skills-1", cwd: "/tmp" }));
    await waitFor(() => messages.some((message) => message.type === "models") && messages.some((message) => message.type === "skills"));
    const models = messages.find((message) => message.type === "models")?.models as Array<{ model: string }>;
    const skills = messages.find((message) => message.type === "skills")?.skills as Array<{ name: string; cwd: string }>;
    expect(models[0]?.model).toBe("model-1");
    expect(skills[0]).toMatchObject({ name: "review", cwd: "/tmp" });
    expect(bridge.calls).toContainEqual({ method: "skills/list", params: { cwds: ["/tmp"] } });
    ws.close();
  });

  it("never widens workspace permissions to filesystem root", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "threads.sync", requestId: "initial-sync" }));
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));

    ws.send(JSON.stringify({ type: "thread.settings", requestId: "safe-cwd", threadId: "thread-1", permissionMode: "auto" }));
    await waitFor(() => bridge.calls.some((call) => call.method === "thread/settings/update"));
    expect(bridge.calls.find((call) => call.method === "thread/settings/update")?.params).toMatchObject({
      threadId: "thread-1",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp"] },
    });

    ws.send(JSON.stringify({ type: "thread.settings", requestId: "missing-cwd", threadId: "unknown-thread", permissionMode: "auto" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "missing-cwd"));
    expect(bridge.calls.filter((call) => call.method === "thread/settings/update")).toHaveLength(1);
    ws.close();
  });

  it("routes compact and model-aware turn requests", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "thread.compact", requestId: "compact-1", threadId: "thread-1" }));
    ws.send(JSON.stringify({ type: "thread.settings", requestId: "settings-1", threadId: "thread-1", model: "model-1", effort: "high", summary: "concise" }));
    ws.send(JSON.stringify({ type: "turn.start", requestId: "turn-1", threadId: "thread-1", text: "Review", model: "model-1", effort: "high", summary: "concise", skill: { name: "review", path: "/skills/review/SKILL.md" } }));
    await waitFor(() => messages.some((message) => message.type === "thread.compaction.accepted") && messages.some((message) => message.type === "thread.settings.updated") && messages.some((message) => message.type === "turn.started"));
    expect(bridge.calls).toContainEqual({ method: "thread/compact/start", params: { threadId: "thread-1" } });
    expect(bridge.calls).toContainEqual({ method: "thread/settings/update", params: { threadId: "thread-1", model: "model-1", effort: "high", summary: "concise" } });
    expect(bridge.calls).toContainEqual({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "skill", name: "review", path: "/skills/review/SKILL.md" }, { type: "text", text: "Review", text_elements: [] }],
        model: "model-1",
        effort: "high",
        summary: "concise",
      },
    });
    ws.close();
  });

  it("routes command approvals back to app-server", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    bridge.emit("serverRequest", { id: 42, method: "item/commandExecution/requestApproval", params: { command: "echo hi", cwd: "/tmp" } });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 42, decision: "accept" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.responses).toEqual([{ id: 42, result: { decision: "accept" } }]);
    ws.close();
  });
  it("routes permission approvals with granted profile and scope", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const permissions = { network: { enabled: true }, fileSystem: null };
    bridge.emit("serverRequest", { id: 43, method: "item/permissions/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1", permissions } });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 43, decision: "acceptForSession" }));
    await waitFor(() => bridge.responses.length === 1);
    expect(bridge.responses).toEqual([{ id: 43, result: { permissions: { network: { enabled: true } }, scope: "session" } }]);
    ws.close();
  });

  it("steers an active Desktop-owned turn and preserves the client correlation id", async () => {
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "mobile-turn", threadId: "thread-1", text: "steer me", clientUserMessageId: "client-message-1" }));
    await waitFor(() => desktop.calls.length === 1 && messages.some((message) => message.type === "turn.started"));
    expect(desktop.calls[0]).toMatchObject({ method: "steer", threadId: "thread-1", params: { clientUserMessageId: "client-message-1" } });
    expect(bridge.calls.some((call) => call.method === "turn/start")).toBe(false);
    ws.close();
  });

  it("falls back to start only after Desktop explicitly reports an inactive turn", async () => {
    const desktop = new FakeDesktop();
    desktop.steerError = new Error("SteerTurnInactiveError: Cannot steer conversation thread-1 because its active turn already ended");
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "idle-turn", threadId: "thread-1", text: "start me", clientUserMessageId: "client-message-idle" }));
    await waitFor(() => messages.some((message) => message.type === "turn.started"));
    expect(desktop.calls.map((call) => call.method)).toEqual(["steer", "start"]);
    ws.close();
  });

  it("does not start a second turn when Desktop steer has an uncertain outcome", async () => {
    const desktop = new FakeDesktop();
    desktop.steerError = new Error("Desktop IPC request timed out: thread-follower-steer-turn");
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "uncertain-turn", threadId: "thread-1", text: "only once", clientUserMessageId: "client-message-uncertain" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "uncertain-turn"));
    expect(desktop.calls.map((call) => call.method)).toEqual(["steer"]);
    expect(messages.find((message) => message.requestId === "uncertain-turn")).toMatchObject({ type: "error", code: "submission_state_unknown" });
    ws.close();
  });

  it("coalesces duplicate turn submissions with the same client message id", async () => {
    const desktop = new FakeDesktop();
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const base = { type: "turn.start", threadId: "thread-1", text: "same logical submission", clientUserMessageId: "client-message-same" };
    ws.send(JSON.stringify({ ...base, requestId: "duplicate-a" }));
    ws.send(JSON.stringify({ ...base, requestId: "duplicate-b" }));
    await waitFor(() => messages.filter((message) => message.type === "turn.started" && String(message.requestId).startsWith("duplicate-")).length === 2);
    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]?.method).toBe("steer");
    ws.close();
  });

  it("rejects reuse of a client message id for different content", async () => {
    const desktop = new FakeDesktop();
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "conflict-a", threadId: "thread-1", text: "first", clientUserMessageId: "client-message-conflict" }));
    await waitFor(() => messages.some((message) => message.type === "turn.started" && message.requestId === "conflict-a"));
    ws.send(JSON.stringify({ type: "turn.start", requestId: "conflict-b", threadId: "thread-1", text: "second", clientUserMessageId: "client-message-conflict" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "conflict-b"));
    expect(desktop.calls).toHaveLength(1);
    expect(messages.find((message) => message.requestId === "conflict-b")).toMatchObject({ type: "error", code: "idempotency_conflict" });
    ws.close();
  });

  it("keeps a Host prompt queued after idle while Desktop owns the conversation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-queue-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const desktop = new FakeDesktop();
    const { port } = await start(desktop, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "queue-a", threadId: "thread-1", text: "next turn", clientUserMessageId: "queued-client-1", deliveryMode: "queue" }));
    await waitFor(() => messages.some((message) => message.type === "prompt.queued"));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ text: "next turn", status: "queued" }]);

    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [{ id: "turn-active", status: "completed", items: [] }] };
    desktop.emit("snapshot", desktop.conversation);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ status: "queued", error: expect.stringContaining("不会自动启动") }]);
    ws.close();
  });

  it("auto-drains through app-server when no Desktop owner exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-appserver-queue-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const { bridge, port } = await start(undefined, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "appserver-queued", threadId: "thread-1", text: "next", clientUserMessageId: "appserver-q1", deliveryMode: "queue" }));
    await waitFor(() => bridge.calls.some((call) => call.method === "turn/start") && queue.list("thread-1").length === 0);
    ws.close();
  });

  it("does not treat a Desktop native empty broadcast as permission to auto-start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-desktop-queue-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const desktop = new FakeDesktop();
    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [] };
    const { port } = await start(desktop, queue);
    desktop.emit("queuedFollowUps", { conversationId: "thread-1", messages: [{ id: "desktop-q1", text: "desktop next" }] });

    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.start", requestId: "host-queued", threadId: "thread-1", text: "host next", clientUserMessageId: "host-q1", deliveryMode: "queue" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ text: "host next", status: "queued" }]);

    desktop.emit("queuedFollowUps", { conversationId: "thread-1", messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toHaveLength(1);
    ws.close();
  });

  it("pauses queued prompts after an interrupted turn and resumes only on explicit request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-pause-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop, queue);
    await queue.enqueue({ threadId: "thread-1", clientUserMessageId: "paused-client", text: "after interrupt", turnParams: { threadId: "thread-1", clientUserMessageId: "paused-client", input: [{ type: "text", text: "after interrupt" }] } });
    bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-active", status: "interrupted" } } });
    await waitFor(() => queue.list("thread-1")[0]?.status === "paused");
    expect(desktop.calls).toHaveLength(0);

    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [{ id: "turn-active", status: "interrupted", items: [] }] };
    desktop.emit("snapshot", desktop.conversation);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "prompt.queue.resume", requestId: "resume-a", threadId: "thread-1" }));
    await waitFor(() => queue.list("thread-1")[0]?.status === "queued");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(desktop.calls).toHaveLength(0);
    ws.close();
  });

  it("rejects promoting an idle Desktop-owned prompt without a shared queue lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-idle-promote-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const queued = await queue.enqueue({ threadId: "thread-1", clientUserMessageId: "idle-promote-client", text: "start later", turnParams: { threadId: "thread-1", clientUserMessageId: "idle-promote-client", input: [{ type: "text", text: "start later" }] } });
    const desktop = new FakeDesktop();
    desktop.conversation = { id: "thread-1", threadRuntimeStatus: { type: "idle" }, turns: [] };
    const { port } = await start(desktop, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "prompt.queue.promote", requestId: "idle-promote", itemId: queued.id }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "idle-promote"));
    expect(messages.find((message) => message.requestId === "idle-promote")).toMatchObject({ type: "error", code: "desktop_queue_coordination_required" });
    expect(desktop.calls).toHaveLength(0);
    expect(queue.list("thread-1")).toMatchObject([{ id: queued.id, status: "queued" }]);
    ws.close();
  });

  it("promotes a queued prompt into the active turn on explicit user action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-gateway-promote-"));
    closers.push(async () => rm(directory, { recursive: true, force: true }));
    const queue = await PromptQueueStore.create(join(directory, "queue.json"));
    const queued = await queue.enqueue({ threadId: "thread-1", clientUserMessageId: "promote-client", text: "guide now", turnParams: { threadId: "thread-1", clientUserMessageId: "promote-client", input: [{ type: "text", text: "guide now" }] } });
    const desktop = new FakeDesktop();
    const { port } = await start(desktop, queue);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "prompt.queue.promote", requestId: "promote-a", itemId: queued.id }));
    await waitFor(() => messages.some((message) => message.type === "turn.started" && message.requestId === "promote-a"));
    expect(desktop.calls.map((call) => call.method)).toEqual(["steer"]);
    expect(queue.list()).toHaveLength(0);
    ws.close();
  });

  it("refreshes a pending file approval when its diff arrives later", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

    bridge.emit("serverRequest", {
      id: 45,
      method: "item/fileChange/requestApproval",
      params: { threadId: "t1", turnId: "turn1", itemId: "i1" },
    });
    await waitFor(() => messages.filter((message) => message.type === "approval").length === 1);

    const diff = "diff --git a/demo.txt b/demo.txt\n+review me";
    bridge.emit("notification", { method: "turn/diff/updated", params: { threadId: "t1", turnId: "turn1", diff } });
    await waitFor(() => messages.filter((message) => message.type === "approval").length === 2);

    const approvals = messages.filter((message) => message.type === "approval");
    expect((approvals.at(-1)?.approval as { detail?: string }).detail).toBe(diff);
    ws.close();
  });

  it("clears approvals when app-server reports serverRequest/resolved", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    bridge.emit("serverRequest", { id: 44, method: "item/fileChange/requestApproval", params: { threadId: "t1", turnId: "turn1", itemId: "i1" } });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    bridge.emit("notification", { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 44 } });
    await waitFor(() => messages.some((message) => message.type === "approval.resolved" && message.approvalRequestId === 44));
    ws.close();
  });

  it("routes structured command approval amendments", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const amendment = { command_prefix: ["npm", "test"] };
    bridge.emit("serverRequest", {
      id: 46,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }, "decline"],
      },
    });
    await waitFor(() => messages.some((message) => message.type === "approval"));
    const approval = messages.find((message) => message.type === "approval")?.approval as { availableDecisions: unknown[] };
    expect(approval.availableDecisions).toContainEqual({ kind: "acceptWithExecpolicyAmendment", execpolicyAmendment: amendment });
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 46, decision: { kind: "acceptWithExecpolicyAmendment", execpolicyAmendment: amendment } }));
    await waitFor(() => bridge.responses.length === 1);
    expect(bridge.responses).toEqual([{ id: 46, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } } }]);
    ws.close();
  });

});
