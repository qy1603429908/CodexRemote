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
import { SubmissionLedger } from "../src/submission-ledger.js";


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
  errors: unknown[] = [];
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
  respondError(...args: unknown[]): void { this.errors.push(args); }
}

class FakeDesktop extends EventEmitter {
  owner = true;
  ready = true;
  supported = true;
  steerError: Error | null = null;
  replyError: Error | null = null;
  identity = "owner-generation-1";
  conversation: Record<string, unknown> = { id: "thread-1", threadRuntimeStatus: { type: "active", activeFlags: [] }, turns: [{ id: "turn-active", status: "inProgress", items: [] }] };
  calls: Array<{ method: string; threadId: string; params: Record<string, unknown> }> = [];
  hasOwner(): boolean { return this.owner; }
  controlIdentity(): string | null { return this.ready && this.owner ? this.identity : null; }
  getConversation(): Record<string, unknown> { return this.conversation; }
  async openConversation(): Promise<Record<string, unknown> | null> {
    return this.owner ? this.conversation : null;
  }
  async steerTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "steer", threadId, params });
    if (this.steerError) throw this.steerError;
    return { id: "steered" };
  }
  async startTurn(threadId: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: "start", threadId, params });
    return { id: "started" };
  }
  async replyUserInput(threadId: string, requestId: string | number, response: unknown): Promise<void> {
    this.calls.push({ method: "reply", threadId, params: { requestId, response } });
    if (this.replyError) throw this.replyError;
  }
  async interruptTurn(threadId: string, mode: "user" | "system"): Promise<unknown> {
    this.calls.push({ method: "interrupt", threadId, params: { mode } });
    return {};
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

async function start(desktop?: FakeDesktop, promptQueue?: PromptQueueStore, ledger?: SubmissionLedger) {
  const bridge = new FakeBridge();
  const gateway = new MobileGateway(bridge as never, config, desktop as never, undefined, promptQueue, ledger);
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
  async function inputClient(desktop?: FakeDesktop, ledger?: SubmissionLedger) {
    const started = await start(desktop, undefined, ledger);
    const ws = new WebSocket(`ws://127.0.0.1:${started.port}/ws`, ["codex-mobile-v1", `token.${Buffer.from(token).toString("base64url")}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    closers.push(async () => { ws.close(); });
    return { ...started, ws, messages };
  }
  const nativeRequest = { id: 42, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-active", itemId: "item-input", questions: [{ id: "q", header: "Pick", question: "Choose?", isOther: true, options: [{ label: "A", description: "First" }] }] } };
  const asyncConversation = () => ({ id: "thread-1", cwd: "D:\\project", threadRuntimeStatus: { type: "active" }, turns: [{ id: "turn-active", status: "inProgress", items: [{ id: "agent-question", type: "agentMessage", questions: [{ title: "Choose?", options: ["A", "B"] }] }] }] });
  const asyncId = '["async","turn-active","agent-question",["[\\"request_user_input_async\\",\\"agent-question\\",0]"]]';
  const asyncQuestionId = '["request_user_input_async","agent-question",0]';
  const answerMessage = (inputId = asyncId, answers = { [asyncQuestionId]: ["A"] }, clientUserMessageId = "answer-1") => ({ type: "user-input.answer", requestId: clientUserMessageId, threadId: "thread-1", inputId, answers, clientUserMessageId });

  it("publishes async questions and sends a trusted reply through Desktop exactly once", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation();
    const { ws, messages, bridge } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "list" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    expect(messages.find(m => m.requestId === "list")).toMatchObject({ requests: [{ id: asyncId, questions: [{ id: asyncQuestionId, allowFreeform: true, options: [{ label: "A" }, { label: "B" }] }] }] });
    ws.send(JSON.stringify({ ...answerMessage(), question: "untrusted override" }));
    ws.send(JSON.stringify(answerMessage()));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted"));
    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]).toMatchObject({ method: "steer", params: { input: [{ type: "text", text: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",0]","question":"Choose?","answer":"A"}]\n</send_user_message_question_reply>' }] } });
    expect(bridge.calls.some(c => c.method.startsWith("turn/"))).toBe(false);
    expect(messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests).toEqual([]);
  });

  it("routes Desktop native requests separately and clears them when the desktop answers", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = { ...asyncConversation(), requests: [nativeRequest] };
    const { ws, messages, bridge } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "thread.open", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    ws.send(JSON.stringify(answerMessage('["tool","desktop","turn-active","number",42]', { q: ["A"] })));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted"));
    expect(desktop.calls).toEqual([{ method: "reply", threadId: "thread-1", params: { requestId: 42, response: { answers: { q: { answers: ["A"] } } } } }]);
    expect(bridge.responses).toEqual([]);
    desktop.conversation = { id: "thread-1", turns: [], requests: [] }; desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests instanceof Array && (messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests as unknown[]).length === 0);
  });

  it("accepts only the helper's own native callback and keeps command approvals", async () => {
    const { ws, messages, bridge } = await inputClient();
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    bridge.emit("serverRequest", nativeRequest);
    bridge.emit("serverRequest", { id: 43, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", command: "echo hi" } });
    await waitFor(() => messages.some(m => m.type === "approval"));
    expect(bridge.errors).toEqual([]);
    ws.send(JSON.stringify(answerMessage('["tool","appServer","turn-active","number",42]', { q: ["A"] })));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted"));
    expect(bridge.responses).toEqual([{ id: 42, result: { answers: { q: { answers: ["A"] } } } }]);
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 43, decision: "decline" }));
    await waitFor(() => bridge.responses.length === 2);
    expect(bridge.responses[1]).toEqual({ id: 43, result: { decision: "decline" } });
  });

  it("rejects stale IDs and invalid answers before delivery", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation();
    const { ws, messages } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    ws.send(JSON.stringify(answerMessage(asyncId, { unknown: ["A"] }, "invalid")));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "invalid"));
    desktop.conversation = { id: "thread-1", turns: [] }; desktop.emit("snapshot", desktop.conversation);
    ws.send(JSON.stringify(answerMessage(asyncId, undefined, "stale")));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "stale"));
    expect(desktop.calls).toEqual([]);
  });

  it("rechecks the owner and pending request after durable reservation", async () => {
    for (const race of ["owner", "answered"]) {
      const desktop = new FakeDesktop(); desktop.conversation = asyncConversation();
      const ledger = { reserve: async () => { if (race === "owner") desktop.identity = "replacement"; else desktop.conversation = { id: "thread-1", turns: [] }; } } as unknown as SubmissionLedger;
      const { ws, messages } = await inputClient(desktop, ledger);
      ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
      await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
      ws.send(JSON.stringify(answerMessage()));
      await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "answer-1"));
      expect(desktop.calls).toEqual([]);
    }
  });

  it("never retries an uncertain question submission with a fresh message ID", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation(); desktop.steerError = new Error("Desktop IPC connection closed");
    const { ws, messages, bridge } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    ws.send(JSON.stringify(answerMessage()));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "answer-1"));
    ws.send(JSON.stringify(answerMessage(asyncId, undefined, "answer-2")));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "answer-2"));
    expect(desktop.calls).toHaveLength(1);
    expect(messages.find(m => m.requestId === "answer-1" && m.type === "error")?.code).toBe("submission_state_unknown");
    expect(bridge.calls.some(c => c.method.startsWith("turn/"))).toBe(false);
  });

  it("only starts an async reply after Desktop explicitly reports an inactive turn", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation(); desktop.steerError = new Error("SteerTurnInactiveError");
    const { ws, messages } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    ws.send(JSON.stringify(answerMessage()));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted"));
    expect(desktop.calls.map(c => c.method)).toEqual(["steer", "start"]);
  });

  it("reserves an authoritative input once across concurrent device message IDs", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation();
    let release!: () => void;
    const disk = new Promise<void>(resolve => { release = resolve; });
    let reservations = 0;
    const ledger = { reserve: async () => { reservations += 1; await disk; }, reserveBatch: async () => ({ release: async () => {} }) } as unknown as SubmissionLedger;
    const { ws, messages } = await inputClient(desktop, ledger);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    ws.send(JSON.stringify(answerMessage()));
    ws.send(JSON.stringify(answerMessage(asyncId, undefined, "other-device-answer")));
    await waitFor(() => reservations === 2);
    release();
    await waitFor(() => messages.filter(m => m.type === "user-input.submitted").length === 2);
    expect(desktop.calls).toHaveLength(1);
    expect(reservations).toBe(3); // two message IDs plus the one authoritative input
  });

  it("rejects an old native form when Desktop reuses its RPC ID in a later turn", async () => {
    const desktop = new FakeDesktop();
    desktop.conversation = { ...asyncConversation(), requests: [nativeRequest] };
    const { ws, messages } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    const oldInput = (messages.find(m => m.type === "user-input.snapshot")!.requests as Array<{ id: string; kind: string }>).find(input => input.kind === "tool")!;
    desktop.conversation = { id: "thread-1", turns: [], requests: [{ ...nativeRequest, params: { ...nativeRequest.params, turnId: "turn-later" } }] };
    desktop.emit("snapshot", desktop.conversation);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "later-turn" }));
    await waitFor(() => messages.some(m => m.requestId === "later-turn"));
    const newInput = (messages.find(m => m.requestId === "later-turn")!.requests as Array<{ id: string }>)[0]!;
    expect(newInput.id).not.toBe(oldInput.id);
    ws.send(JSON.stringify(answerMessage(oldInput.id, { q: ["A"] }, "old-native-form")));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "old-native-form"));
    expect(messages.find(m => m.requestId === "old-native-form")?.code).toBe("user_input_stale");
    expect(desktop.calls).toEqual([]);
    ws.send(JSON.stringify(answerMessage(newInput.id, { q: ["A"] }, "new-native-form")));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted" && m.requestId === "new-native-form"));
    expect(desktop.calls).toEqual([{ method: "reply", threadId: "thread-1", params: { requestId: 42, response: { answers: { q: { answers: ["A"] } } } } }]);
  });

  it("allows remaining async questions after Desktop partially answers during durable reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-partial-input-ledger-"));
    closers.unshift(async () => { await rm(directory, { recursive: true, force: true }); });
    const durable = await SubmissionLedger.create(join(directory, "submissions.json"));
    const desktop = new FakeDesktop();
    const conversation = asyncConversation();
    conversation.turns[0]!.items[0]!.questions.push({ title: "Second?", options: ["Yes", "No"] });
    desktop.conversation = conversation;
    let reservations = 0;
    const ledger = { reserve: async (key: string, fingerprint: string) => {
      await durable.reserve(key, fingerprint);
      reservations += 1;
      if (reservations === 2) {
        const reply = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",0]","question":"Choose?","answer":"A"}]\n</send_user_message_question_reply>';
        desktop.conversation = { ...conversation, turns: [{ ...conversation.turns[0], items: [...conversation.turns[0]!.items, { type: "userMessage", content: [{ type: "text", text: reply }] }] }] };
        desktop.emit("snapshot", desktop.conversation);
      }
    }, reserveBatch: durable.reserveBatch.bind(durable) } as unknown as SubmissionLedger;
    const { ws, messages } = await inputClient(desktop, ledger);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    const oldInput = (messages.find(m => m.type === "user-input.snapshot")!.requests as Array<{ id: string }>)[0]!;
    const secondQuestionId = '["request_user_input_async","agent-question",1]';
    ws.send(JSON.stringify(answerMessage(oldInput.id, { [asyncQuestionId]: ["A"], [secondQuestionId]: ["Yes"] }, "full-answer")));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "full-answer"));
    expect(messages.find(m => m.requestId === "full-answer")?.code).toBe("user_input_stale");
    expect(desktop.calls).toEqual([]);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "remaining" }));
    await waitFor(() => messages.some(m => m.requestId === "remaining"));
    const remaining = (messages.find(m => m.requestId === "remaining")!.requests as Array<{ id: string; questions: Array<{ id: string }> }>)[0]!;
    expect(remaining.questions.map(question => question.id)).toEqual([secondQuestionId]);
    expect(remaining.id).not.toBe(oldInput.id);
    ws.send(JSON.stringify(answerMessage(remaining.id, { [secondQuestionId]: ["Yes"] }, "remaining-answer")));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted" && m.requestId === "remaining-answer"));
    expect(desktop.calls).toHaveLength(1);
    expect(desktop.calls[0]).toMatchObject({ method: "steer", params: { input: [{ type: "text", text: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",1]","question":"Second?","answer":"Yes"}]\n</send_user_message_question_reply>' }] } });
  });

  it("never resends an attempted question after an uncertain group answer and partial Desktop reply, including restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-attempted-input-ledger-"));
    closers.unshift(async () => { await rm(directory, { recursive: true, force: true }); });
    const filename = join(directory, "submissions.json");
    const desktop = new FakeDesktop();
    const conversation = asyncConversation();
    conversation.turns[0]!.items[0]!.questions.push({ title: "Second?", options: ["Yes", "No"] });
    desktop.conversation = conversation;
    desktop.steerError = new Error("Desktop IPC request timed out: thread-follower-steer-turn");
    const first = await inputClient(desktop, await SubmissionLedger.create(filename));
    first.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => first.messages.some(m => m.type === "user-input.snapshot"));
    const full = (first.messages.find(m => m.type === "user-input.snapshot")!.requests as Array<{ id: string }>)[0]!;
    const secondQuestionId = '["request_user_input_async","agent-question",1]';
    first.ws.send(JSON.stringify(answerMessage(full.id, { [asyncQuestionId]: ["A"], [secondQuestionId]: ["Yes"] }, "uncertain-full")));
    await waitFor(() => first.messages.some(m => m.type === "error" && m.requestId === "uncertain-full"));
    expect(first.messages.find(m => m.requestId === "uncertain-full")?.code).toBe("submission_state_unknown");
    expect(desktop.calls).toHaveLength(1);
    const reply = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",0]","question":"Choose?","answer":"A"}]\n</send_user_message_question_reply>';
    desktop.conversation = { ...conversation, turns: [{ ...conversation.turns[0], items: [...conversation.turns[0]!.items, { type: "userMessage", content: [{ type: "text", text: reply }] }] }] };
    desktop.steerError = null; desktop.emit("snapshot", desktop.conversation);
    first.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "partial-remaining" }));
    await waitFor(() => first.messages.some(m => m.requestId === "partial-remaining"));
    const remaining = (first.messages.find(m => m.requestId === "partial-remaining")!.requests as Array<{ id: string }>)[0]!;
    expect(remaining.id).not.toBe(full.id);
    first.ws.send(JSON.stringify(answerMessage(remaining.id, { [secondQuestionId]: ["Yes"] }, "overlap-live")));
    await waitFor(() => first.messages.some(m => m.requestId === "overlap-live"));
    expect(first.messages.find(m => m.requestId === "overlap-live")).toMatchObject({ type: "error", code: "submission_state_unknown" });
    const restarted = await inputClient(desktop, await SubmissionLedger.create(filename));
    restarted.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => restarted.messages.some(m => m.type === "user-input.snapshot"));
    restarted.ws.send(JSON.stringify(answerMessage(remaining.id, { [secondQuestionId]: ["Yes"] }, "overlap-restarted")));
    await waitFor(() => restarted.messages.some(m => m.requestId === "overlap-restarted"));
    expect(restarted.messages.find(m => m.requestId === "overlap-restarted")).toMatchObject({ type: "error", code: "submission_state_unknown" });
    expect(desktop.calls).toHaveLength(1);
  });

  it("releases question reservations only when final preflight aborts before delivery, including restart", async () => {
    for (const restart of [false, true]) {
      const directory = await mkdtemp(join(tmpdir(), "cmr-final-preflight-input-"));
      closers.unshift(async () => { await rm(directory, { recursive: true, force: true }); });
      const filename = join(directory, "submissions.json");
      const durable = await SubmissionLedger.create(filename);
      const desktop = new FakeDesktop();
      const conversation = asyncConversation();
      conversation.turns[0]!.items[0]!.questions.push({ title: "Second?", options: ["Yes", "No"] });
      desktop.conversation = conversation;
      let reservedQuestions = false;
      const ledger = { reserve: durable.reserve.bind(durable), reserveBatch: async (keys: readonly string[], fingerprint: string) => {
        const reservation = await durable.reserveBatch(keys, fingerprint);
        if (!reservedQuestions) {
          reservedQuestions = true;
          const reply = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-question\\",0]","question":"Choose?","answer":"A"}]\n</send_user_message_question_reply>';
          desktop.conversation = { ...conversation, turns: [{ ...conversation.turns[0], items: [...conversation.turns[0]!.items, { type: "userMessage", content: [{ type: "text", text: reply }] }] }] };
          desktop.emit("snapshot", desktop.conversation);
        }
        return reservation;
      } } as unknown as SubmissionLedger;
      const first = await inputClient(desktop, ledger);
      first.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
      await waitFor(() => first.messages.some(m => m.type === "user-input.snapshot"));
      const full = (first.messages.find(m => m.type === "user-input.snapshot")!.requests as Array<{ id: string }>)[0]!;
      const secondQuestionId = '["request_user_input_async","agent-question",1]';
      first.ws.send(JSON.stringify(answerMessage(full.id, { [asyncQuestionId]: ["A"], [secondQuestionId]: ["Yes"] }, "late-preflight-full")));
      await waitFor(() => first.messages.some(m => m.type === "error" && m.requestId === "late-preflight-full"));
      expect(first.messages.find(m => m.requestId === "late-preflight-full")?.code).toBe("user_input_stale");
      expect(desktop.calls).toEqual([]);
      const next = restart ? await inputClient(desktop, await SubmissionLedger.create(filename)) : first;
      next.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "after-proven-abort" }));
      await waitFor(() => next.messages.some(m => m.requestId === "after-proven-abort"));
      const remaining = (next.messages.find(m => m.requestId === "after-proven-abort")!.requests as Array<{ id: string }>)[0]!;
      next.ws.send(JSON.stringify(answerMessage(remaining.id, { [secondQuestionId]: ["Yes"] }, "safe-remaining-after-abort")));
      await waitFor(() => next.messages.some(m => m.type === "user-input.submitted" && m.requestId === "safe-remaining-after-abort"));
      expect(desktop.calls).toHaveLength(1);
    }
  });

  it("does not consume a fresh question when another question in its new group already had an uncertain delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-overlapping-question-group-"));
    closers.unshift(async () => { await rm(directory, { recursive: true, force: true }); });
    const desktop = new FakeDesktop();
    const conversation = asyncConversation();
    conversation.turns[0]!.items[0]!.questions.push({ title: "Second?", options: ["Yes", "No"] });
    desktop.conversation = conversation; desktop.steerError = new Error("Desktop IPC request timed out");
    const { ws, messages } = await inputClient(desktop, await SubmissionLedger.create(join(directory, "submissions.json")));
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    const full = (messages.find(m => m.type === "user-input.snapshot")!.requests as Array<{ id: string }>)[0]!;
    const q2 = '["request_user_input_async","agent-question",1]', q3 = '["request_user_input_async","agent-question",2]';
    ws.send(JSON.stringify(answerMessage(full.id, { [asyncQuestionId]: ["A"], [q2]: ["Yes"] }, "attempt-q1-q2")));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "attempt-q1-q2"));
    conversation.turns[0]!.items[0]!.questions.push({ title: "Third?", options: ["Go", "Stop"] });
    const replyItem = (questionId: string) => ({ type: "userMessage", content: [{ type: "text", text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questionId, question: "Desktop answer", answer: "accepted" }])}\n</send_user_message_question_reply>` }] });
    desktop.conversation = { ...conversation, turns: [{ ...conversation.turns[0], items: [...conversation.turns[0]!.items, replyItem(asyncQuestionId)] }] };
    desktop.steerError = null;
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "q2-q3" }));
    await waitFor(() => messages.some(m => m.requestId === "q2-q3"));
    const overlap = (messages.find(m => m.requestId === "q2-q3")!.requests as Array<{ id: string }>)[0]!;
    ws.send(JSON.stringify(answerMessage(overlap.id, { [q2]: ["Yes"], [q3]: ["Go"] }, "blocked-q2-q3")));
    await waitFor(() => messages.some(m => m.requestId === "blocked-q2-q3"));
    expect(messages.find(m => m.requestId === "blocked-q2-q3")).toMatchObject({ type: "error", code: "submission_state_unknown" });
    desktop.conversation = { ...conversation, turns: [{ ...conversation.turns[0], items: [...conversation.turns[0]!.items, replyItem(asyncQuestionId), replyItem(q2)] }] };
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1", requestId: "q3-only" }));
    await waitFor(() => messages.some(m => m.requestId === "q3-only"));
    const fresh = (messages.find(m => m.requestId === "q3-only")!.requests as Array<{ id: string }>)[0]!;
    ws.send(JSON.stringify(answerMessage(fresh.id, { [q3]: ["Go"] }, "fresh-q3")));
    await waitFor(() => messages.some(m => m.type === "user-input.submitted" && m.requestId === "fresh-q3"));
    expect(desktop.calls).toHaveLength(2);
  });

  it("retains durable per-input protection after restart even with a new message ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cmr-input-ledger-"));
    closers.unshift(async () => { await rm(directory, { recursive: true, force: true }); });
    const filename = join(directory, "submissions.json");
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation();
    const first = await inputClient(desktop, await SubmissionLedger.create(filename));
    first.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => first.messages.some(m => m.type === "user-input.snapshot"));
    first.ws.send(JSON.stringify(answerMessage()));
    await waitFor(() => first.messages.some(m => m.type === "user-input.submitted"));
    const second = await inputClient(desktop, await SubmissionLedger.create(filename));
    second.ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => second.messages.some(m => m.type === "user-input.snapshot"));
    second.ws.send(JSON.stringify(answerMessage(asyncId, undefined, "after-restart")));
    await waitFor(() => second.messages.some(m => m.type === "error" && m.requestId === "after-restart"));
    expect(second.messages.find(m => m.type === "error" && m.requestId === "after-restart")?.code).toBe("submission_state_unknown");
    expect(desktop.calls).toHaveLength(1);
  });

  it("clears forms on Desktop disconnection and refuses helper fallback", async () => {
    const desktop = new FakeDesktop(); desktop.conversation = asyncConversation();
    const { ws, messages, bridge } = await inputClient(desktop);
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    desktop.ready = false; desktop.emit("offline");
    await waitFor(() => messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests instanceof Array && (messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests as unknown[]).length === 0);
    ws.send(JSON.stringify(answerMessage()));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "answer-1"));
    expect(desktop.calls).toEqual([]);
    expect(bridge.calls.some(c => c.method.startsWith("turn/"))).toBe(false);
  });

  it("expires a helper native callback on serverRequest/resolved without answering it", async () => {
    const { ws, messages, bridge } = await inputClient();
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    bridge.emit("serverRequest", nativeRequest);
    await waitFor(() => (messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests as unknown[])?.length === 1);
    bridge.emit("notification", { method: "serverRequest/resolved", params: { requestId: 42 } });
    await waitFor(() => (messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests as unknown[])?.length === 0);
    ws.send(JSON.stringify(answerMessage('["tool","appServer","turn-active","number",42]', { q: ["A"] })));
    await waitFor(() => messages.some(m => m.type === "error" && m.requestId === "answer-1"));
    expect(bridge.responses).toEqual([]);
  });

  it("does not expire a newer turn's native question when an older turn completes", async () => {
    const { ws, messages, bridge } = await inputClient();
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    bridge.emit("serverRequest", nativeRequest);
    bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-older", status: "completed" } } });
    ws.send(JSON.stringify({ type: "user-input.list", requestId: "after-old-turn", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.requestId === "after-old-turn"));
    expect(messages.find(m => m.requestId === "after-old-turn")?.requests).toMatchObject([{ turnId: "turn-active" }]);
  });


  it("reconnects with a fresh authoritative input snapshot without replaying older forms", async () => {
    const { ws, messages, bridge } = await inputClient();
    await waitFor(() => messages.some(m => m.type === "welcome"));
    const welcome = messages.find(m => m.type === "welcome")!;
    ws.send(JSON.stringify({ type: "user-input.list", threadId: "thread-1" }));
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    bridge.emit("serverRequest", nativeRequest);
    await waitFor(() => (messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests as unknown[])?.length === 1);
    bridge.emit("notification", { method: "serverRequest/resolved", params: { requestId: 42 } });
    await waitFor(() => (messages.filter(m => m.type === "user-input.snapshot").at(-1)?.requests as unknown[])?.length === 0);
    messages.splice(0);
    ws.send(JSON.stringify({ type: "sync.resume", requestId: "reconnect", syncVersion: welcome.syncVersion, cursor: welcome.latestCursor, threadIds: ["thread-1"] }));
    await waitFor(() => messages.some(m => m.type === "sync.replay"));
    const replay = messages.find(m => m.type === "sync.replay")!;
    expect((replay.events as Array<{ type: string }>).some(m => m.type === "user-input.snapshot")).toBe(false);
    await waitFor(() => messages.some(m => m.type === "user-input.snapshot"));
    expect(messages.find(m => m.type === "user-input.snapshot")?.requests).toEqual([]);
  });
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
    await waitFor(() => messages.some((message) => {
      if (message.type !== "event" || message.method !== "desktop/threadSnapshot") return false;
      const params = message.params as { thread?: { status?: { type?: string } } } | undefined;
      return params?.thread?.status?.type === "active";
    }));

    const desktopSnapshot = messages.findLast((message) => {
      if (message.type !== "event" || message.method !== "desktop/threadSnapshot") return false;
      const params = message.params as { thread?: { status?: { type?: string } } } | undefined;
      return params?.thread?.status?.type === "active";
    });
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

  it("streams Desktop snapshots only to sockets subscribed to the active task", async () => {
    const desktop = new FakeDesktop();
    desktop.conversation = {
      id: "thread-1",
      cwd: process.platform === "win32" ? "C:\\Users\\alice\\project" : "/tmp/project",
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-live", status: "inProgress", items: [{ id: "item-1", type: "agentMessage", text: "one" }] }],
    };
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const subscribed = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const observer = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const subscribedMessages: Array<Record<string, unknown>> = [];
    const observerMessages: Array<Record<string, unknown>> = [];
    subscribed.on("message", (data) => subscribedMessages.push(JSON.parse(data.toString())));
    observer.on("message", (data) => observerMessages.push(JSON.parse(data.toString())));
    await Promise.all([
      new Promise<void>((resolve, reject) => { subscribed.once("open", resolve); subscribed.once("error", reject); }),
      new Promise<void>((resolve, reject) => { observer.once("open", resolve); observer.once("error", reject); }),
    ]);
    subscribed.send(JSON.stringify({ type: "thread.open", requestId: "desktop-open", threadId: "thread-1", historyLimit: 20 }));
    await waitFor(() => subscribedMessages.some((message) => message.type === "thread" && message.requestId === "desktop-open"));

    desktop.conversation = {
      ...desktop.conversation,
      turns: [{ id: "turn-live", status: "inProgress", items: [
        { id: "item-1", type: "agentMessage", text: "one" },
        { id: "item-2", type: "commandExecution", status: "inProgress" },
      ] }],
    };
    desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => subscribedMessages.some((message) => message.type === "event" && message.method === "desktop/threadSnapshot"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observerMessages.some((message) => message.type === "event" && message.method === "desktop/threadSnapshot")).toBe(false);
    const snapshot = subscribedMessages.findLast((message) => message.type === "event" && message.method === "desktop/threadSnapshot");
    const thread = (snapshot?.params as { thread?: { turns?: Array<{ items?: unknown[] }> } } | undefined)?.thread;
    expect(thread?.turns?.at(-1)?.items).toHaveLength(2);
    subscribed.close();
    observer.close();
  });

  it("drops stale Desktop active state when IPC goes offline", async () => {
    const desktop = new FakeDesktop();
    const { bridge, port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    desktop.emit("snapshot", desktop.conversation);
    await waitFor(() => messages.some((message) => message.type === "threads.delta"));
    bridge.threadListData = [{
      id: "thread-1", name: "Test", preview: "Hello", cwd: "/tmp", modelProvider: "custom", updatedAt: 10, status: { type: "notLoaded" }, source: "appServer",
    }];
    desktop.emit("offline");
    await waitFor(() => messages.some((message) => message.type === "threads.snapshot"));
    const refreshed = messages.findLast((message) => message.type === "threads.snapshot");
    const threads = refreshed?.threads as Array<{ id: string; status: unknown }>;
    expect(threads.find((thread) => thread.id === "thread-1")?.status).toEqual({ type: "notLoaded" });
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

  it("sends an authoritative approval snapshot on reconnect", async () => {
    const { port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    await waitFor(() => messages.some((message) => message.type === "approvals.snapshot"));
    expect(messages.find((message) => message.type === "approvals.snapshot")).toMatchObject({ approvals: [] });
    ws.close();
  });

  it("suppresses mirrored app-server command approvals for Desktop-owned tasks but keeps MCP elicitations", async () => {
    const desktop = new FakeDesktop();
    const { bridge, gateway } = await start(desktop);
    desktop.emit("snapshot", desktop.conversation);
    bridge.emit("serverRequest", {
      id: 81,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-active", itemId: "command-1", command: "echo mirrored" },
    });
    bridge.emit("serverRequest", {
      id: 82,
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1", turnId: "turn-active", message: "Allow Computer Use?" },
    });
    const approvals = (gateway as unknown as { approvals: Map<string | number, unknown> }).approvals;
    await waitFor(() => approvals.has(82));
    expect(approvals.has(81)).toBe(false);
    expect(approvals.has(82)).toBe(true);
  });

  it("clears an app-server approval when the corresponding item completes", async () => {
    const { bridge, gateway } = await start();
    bridge.emit("serverRequest", {
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", command: "echo hi" },
    });
    const approvals = (gateway as unknown as { approvals: Map<string | number, unknown> }).approvals;
    await waitFor(() => approvals.has(91));
    bridge.emit("notification", {
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: { id: "command-1", status: "failed" } },
    });
    await waitFor(() => !approvals.has(91));
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
    await waitFor(() => bridge.responses.length === 1);
    bridge.emit("notification", { method: "serverRequest/resolved", params: { requestId: 42 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.responses).toEqual([{ id: 42, result: { decision: "accept" } }]);
    expect(messages.filter((message) =>
      message.type === "approval.resolved" && message.approvalRequestId === 42
    )).toHaveLength(1);
    ws.close();
  });

  it("routes native Computer Use MCP elicitations through the phone approval flow", async () => {
    const { bridge, port } = await start();
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const elicitation = {
      id: 47,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "t1",
        turnId: "turn1",
        serverName: "node_repl",
        message: 'Allow Computer Use to use "Finder"?',
        _meta: {
          connector_name: "Computer Use",
          persist: ["session", "always"],
          tool_params: { app: "com.apple.finder" },
        },
      },
    };
    bridge.emit("serverRequest", elicitation);
    bridge.emit("serverRequest", elicitation);
    await waitFor(() => messages.some((message) => message.type === "approval"));
    expect(messages.filter((message) => message.type === "approval")).toHaveLength(1);
    const approval = messages.find((message) => message.type === "approval")?.approval as {
      title: string;
      detail: string;
      availableDecisions: unknown[];
    };
    expect(approval).toMatchObject({
      title: "允许 Computer Use 操作？",
      detail: 'Allow Computer Use to use "Finder"?',
    });
    expect(approval.availableDecisions).toEqual(["decline", "accept", "acceptForSession"]);
    ws.send(JSON.stringify({ type: "approval.resolve", approvalRequestId: 47, decision: "acceptForSession" }));
    await waitFor(() => bridge.responses.length === 1);
    expect(bridge.responses).toEqual([{
      id: 47,
      result: {
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      },
    }]);
    ws.close();
  });
  it("keeps Desktop approvals pending when only app-server goes offline", async () => {
    const desktop = new FakeDesktop();
    const { bridge, gateway } = await start(desktop);
    desktop.emit("snapshot", {
      ...desktop.conversation,
      requests: [{
        id: "desktop-command",
        method: "item/commandExecution/requestApproval",
        params: { command: "echo desktop" },
      }],
    });
    bridge.emit("serverRequest", {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { command: "echo app-server" },
    });
    const approvals = (gateway as unknown as { approvals: Map<string | number, unknown> }).approvals;
    await waitFor(() => approvals.size === 2);
    bridge.emit("offline", new Error("app-server stopped"));
    expect(approvals.has(42)).toBe(false);
    expect(approvals.has("desktop:thread-1:desktop-command")).toBe(true);
  });

  it("rejects a stale Desktop interrupt turn id", async () => {
    const desktop = new FakeDesktop();
    const { port } = await start(desktop);
    const encoded = Buffer.from(token).toString("base64url");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["codex-mobile-v1", `token.${encoded}`], { origin: "capacitor://localhost" });
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "turn.interrupt", requestId: "stale-interrupt", threadId: "thread-1", turnId: "turn-old" }));
    await waitFor(() => messages.some((message) => message.type === "error" && message.requestId === "stale-interrupt"));
    expect(desktop.calls.filter((call) => call.method === "interrupt")).toHaveLength(0);
    ws.send(JSON.stringify({ type: "turn.interrupt", requestId: "current-interrupt", threadId: "thread-1", turnId: "turn-active" }));
    await waitFor(() => desktop.calls.some((call) => call.method === "interrupt"));
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
