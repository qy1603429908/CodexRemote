import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  WIRE_PROTOCOL,
  type ApprovalDecision,
  type ApprovalRequest,
  type ClientMessage,
  type ModelOption,
  type ServerMessage,
  type SkillOption,
  type ThreadSummary,
} from "@codex-mobile/protocol";
import { authenticateUpgrade, selectedProtocol } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { AppServerBridge } from "./app-server-bridge.js";
import {
  DesktopIpcBridge,
  canonicalTurns,
  conversationIsActive,
  isExplicitInactiveSteerError,
  isUncertainDesktopSubmissionError,
} from "./desktop-ipc-bridge.js";
import type { FileTransferManager } from "./file-transfer.js";
import { GitDiffError, readGitDiff, type GitDiffSnapshot } from "./git-diff.js";
import { PromptQueueStore, type StoredPromptQueueItem } from "./prompt-queue.js";
import { SyncJournal, ThreadIndexStore } from "./sync-state.js";

interface RpcEnvelope {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface ThreadListResult {
  data?: Array<Record<string, unknown>>;
  nextCursor?: string | null;
}

interface ThreadTurnsListResult {
  data?: Array<Record<string, unknown>>;
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

interface ModelListResult {
  data?: Array<Record<string, unknown>>;
}

interface SkillsListResult {
  data?: Array<{ cwd?: unknown; skills?: Array<Record<string, unknown>> }>;
}

interface TurnSubmissionEntry {
  fingerprint: string;
  createdAt: number;
  promise: Promise<unknown>;
}

class GatewayRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

const TURN_SUBMISSION_TTL_MS = 10 * 60_000;
const MAX_TURN_SUBMISSIONS = 1_000;
const THREAD_SOURCE_KINDS = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview",
  "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
];

export class MobileGateway {
  private readonly wss: WebSocketServer;
  private readonly approvals = new Map<number | string, RpcEnvelope>();
  private readonly desktopApprovalKeys = new Set<number | string>();
  private readonly turnDiffs = new Map<string, string>();
  private readonly desktopThreads = new Map<string, Record<string, unknown>>();
  private readonly threadCwds = new Map<string, string>();
  private readonly failedAuth = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly turnSubmissions = new Map<string, TurnSubmissionEntry>();
  private readonly appServerThreadStatuses = new Map<string, unknown>();
  private readonly appServerCurrentTurnIds = new Map<string, string>();
  private readonly queueDrains = new Map<string, Promise<void>>();
  private readonly desktopQueuedFollowUps = new Map<string, number>();
  private readonly gitDiffs = new Map<string, GitDiffSnapshot>();
  private readonly syncJournal = new SyncJournal();
  private readonly threadIndex = new ThreadIndexStore();
  private readonly socketThreads = new WeakMap<WebSocket, Set<string>>();
  private threadIndexLoad: Promise<void> | null = null;

  constructor(
    private readonly bridge: AppServerBridge,
    private readonly config: ServerConfig,
    private readonly desktopIpc?: DesktopIpcBridge,
    private readonly files?: FileTransferManager,
    private readonly promptQueue?: PromptQueueStore,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: selectedProtocol,
    });
    this.wss.on("connection", (socket) => this.onConnection(socket));
    bridge.on("ready", () =>
      this.broadcast({ type: "status", codexReady: true }),
    );
    bridge.on("offline", (error: Error) => {
      for (const requestId of this.approvals.keys()) {
        this.broadcast({
          type: "approval.resolved",
          approvalRequestId: requestId,
        });
      }
      this.approvals.clear();
      this.turnDiffs.clear();
      this.appServerThreadStatuses.clear();
      this.appServerCurrentTurnIds.clear();
      this.broadcast({
        type: "status",
        codexReady: false,
        detail: error.message,
      });
    });
    bridge.on(
      "notification",
      (message: { method: string; params?: unknown }) => {
        const params = asRecord(message.params);
        if (
          message.method === "thread/status/changed" &&
          typeof params?.threadId === "string"
        ) {
          this.rememberAppServerThreadStatus(params.threadId, params.status);
        }
        if (message.method === "turn/started" && typeof params?.threadId === "string") {
          this.rememberAppServerStartedTurn(params.threadId, params.turn);
        }
        if (
          message.method === "turn/diff/updated" &&
          typeof params?.threadId === "string" &&
          typeof params.turnId === "string" &&
          typeof params.diff === "string"
        ) {
          this.turnDiffs.set(
            turnKey(params.threadId, params.turnId),
            params.diff,
          );
          for (const pending of this.approvals.values()) {
            const approvalParams = pending.params ?? {};
            const matchesTurn =
              approvalParams.threadId === params.threadId &&
              approvalParams.turnId === params.turnId;
            const isFileApproval =
              pending.method === "item/fileChange/requestApproval" ||
              pending.method === "applyPatchApproval";
            if (matchesTurn && isFileApproval) {
              this.broadcast({
                type: "approval",
                approval: normalizeApproval(pending, params.diff),
              });
            }
          }
        }
        if (
          message.method === "turn/completed" &&
          typeof params?.threadId === "string"
        ) {
          const turn = asRecord(params.turn);
          if (typeof turn?.id === "string") this.turnDiffs.delete(turnKey(params.threadId, turn.id));
          this.rememberAppServerCompletedTurn(params.threadId, turn);
          const completedStatus = String(turn?.status ?? params.status ?? "").toLowerCase();
          if (completedStatus.includes("interrupt")) {
            void this.pausePromptQueue(params.threadId, "队列因当前 turn 被中断而暂停；确认后可恢复。");
          } else {
            this.scheduleQueueDrain(params.threadId);
          }
          void this.refreshThreadDiff(params.threadId, true);
        }
        if (
          message.method === "serverRequest/resolved" &&
          (typeof params?.requestId === "string" ||
            typeof params?.requestId === "number")
        ) {
          this.approvals.delete(params.requestId);
          this.broadcast({
            type: "approval.resolved",
            approvalRequestId: params.requestId,
          });
        }
        this.updateThreadIndexFromNotification(message.method, params);
        const eventParams = message.method === "thread/status/changed" && typeof params?.threadId === "string"
          ? { ...params, status: this.mergedThreadStatus(params.threadId, params.status) }
          : message.params ?? null;
        const eventMessage: ServerMessage = {
          type: "event",
          method: message.method,
          params: eventParams,
        };
        const contentThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        if (contentThreadId && isThreadContentEvent(message.method)) this.broadcastThread(contentThreadId, eventMessage);
        else this.broadcast(eventMessage);
      },
    );
    bridge.on("serverRequest", (message: RpcEnvelope) =>
      this.onServerRequest(message),
    );
    desktopIpc?.on("snapshot", (thread: Record<string, unknown>) => {
      const id = typeof thread.id === "string" ? thread.id : null;
      if (!id) return;
      const wasDesktopActive = conversationIsActive(this.desktopThreads.get(id));
      this.desktopThreads.set(id, thread);
      if (!conversationIsActive(thread)) {
        const latestTurn = asRecord(canonicalTurns(thread).at(-1));
        const latestStatus = String(latestTurn?.status ?? "").toLowerCase();
        if (wasDesktopActive && latestStatus.includes("interrupt")) {
          void this.pausePromptQueue(id, "队列因当前 turn 被中断而暂停；确认后可恢复。");
        } else if (!this.isThreadActive(id)) {
          this.scheduleQueueDrain(id);
        }
        if (wasDesktopActive && !this.isThreadActive(id)) void this.refreshThreadDiff(id, true);
      }
      if (typeof thread.cwd === "string" && thread.cwd.startsWith("/")) this.threadCwds.set(id, thread.cwd);
      this.upsertThreadSummary({ ...toThreadSummary(thread), status: this.mergedThreadStatus(id, thread.threadRuntimeStatus ?? thread.status) });
      this.syncDesktopApprovals(id, thread);
      const liveThread = projectDesktopLiveThread(this.projectThreadRuntimeStatus(thread));
      void this.trustDesktopAttachments(liveThread).then(() => {
        if (this.desktopThreads.get(id) !== thread) return;
        this.broadcastThread(id, {
          type: "event",
          method: "desktop/threadSnapshot",
          params: { thread: liveThread },
        });
      });
    });
    desktopIpc?.on("queuedFollowUps", (event: { conversationId?: unknown; messages?: unknown }) => {
      if (typeof event.conversationId !== "string" || !Array.isArray(event.messages)) return;
      this.desktopQueuedFollowUps.set(event.conversationId, event.messages.length);
      if (event.messages.length === 0) this.scheduleQueueDrain(event.conversationId);
    });
    desktopIpc?.on("offline", () => {
      this.desktopThreads.clear();
      this.desktopQueuedFollowUps.clear();
      for (const wireId of [...this.desktopApprovalKeys]) {
        this.desktopApprovalKeys.delete(wireId);
        if (this.approvals.delete(wireId))
          this.broadcast({
            type: "approval.resolved",
            approvalRequestId: wireId,
          });
      }
    });
    desktopIpc?.on("diagnostic", (error: unknown) =>
      console.warn("[desktop-ipc]", error),
    );
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    if (this.isRateLimited(remoteAddress)) {
      this.rejectUpgrade(socket, 429, "Too Many Requests");
      return;
    }
    if (request.url !== "/ws") {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const auth = authenticateUpgrade(request, this.config);
    if (!auth.ok) {
      this.recordAuthFailure(remoteAddress);
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    this.failedAuth.delete(remoteAddress);
    this.wss.handleUpgrade(request, socket, head, (ws) =>
      this.wss.emit("connection", ws, request),
    );
  }

  close(): void {
    for (const socket of this.wss.clients)
      socket.close(1001, "server shutdown");
    this.wss.close();
  }

  private onConnection(socket: WebSocket): void {
    this.socketThreads.set(socket, new Set());
    socket.on("error", () => undefined);
    socket.on("message", (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data.toString()) > 1_000_000) {
        this.send(socket, {
          type: "error",
          code: "invalid_message",
          message: "Only JSON messages up to 1 MB are accepted.",
        });
        return;
      }
      void this.handleClientMessage(socket, data.toString("utf8"));
    });
    socket.on(
      "pong",
      () => ((socket as WebSocket & { isAlive?: boolean }).isAlive = true),
    );
    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;

    this.send(socket, {
      type: "welcome",
      version: "0.3.2",
      serverId: this.config.serverId,
      codexReady: this.bridge.ready,
      syncVersion: this.syncJournal.version,
      latestCursor: this.syncJournal.latestCursor,
      threadIndexVersion: this.threadIndex.currentVersion,
    });
    for (const approval of this.approvals.values()) {
      const params = approval.params ?? {};
      const diff =
        typeof params.threadId === "string" && typeof params.turnId === "string"
          ? this.turnDiffs.get(turnKey(params.threadId, params.turnId))
          : undefined;
      this.send(socket, {
        type: "approval",
        approval: normalizeApproval(approval, diff),
      });
    }
    // Large task indexes and histories are client-requested after welcome so a
    // reconnect can resume from its persisted cursor without a duplicate dump.
  }

  startHeartbeat(): NodeJS.Timeout {
    const timer = setInterval(() => {
      for (const socket of this.wss.clients) {
        const tracked = socket as WebSocket & { isAlive?: boolean };
        if (tracked.isAlive === false) {
          socket.terminate();
          continue;
        }
        tracked.isAlive = false;
        socket.ping();
      }
    }, 30_000);
    timer.unref();
    return timer;
  }

  private async handleClientMessage(
    socket: WebSocket,
    raw: string,
  ): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(socket, {
        type: "error",
        code: "invalid_json",
        message: "Message must be valid JSON.",
      });
      return;
    }

    try {
      switch (message.type) {
        case "ping":
          this.send(socket, { type: "pong", id: message.id });
          break;
        case "sync.resume": {
          const afterCursor = typeof message.cursor === "number" ? message.cursor : undefined;
          const threadIds = Array.isArray(message.threadIds)
            ? message.threadIds.filter((value): value is string => typeof value === "string").slice(0, 20)
            : [];
          const subscriptions = this.socketThreads.get(socket);
          for (const threadId of threadIds) subscriptions?.add(threadId);
          const replay = this.syncJournal.replay(message.syncVersion, afterCursor, threadIds);
          if (replay.reset) {
            this.send(socket, {
              type: "sync.reset",
              requestId: message.requestId,
              syncVersion: this.syncJournal.version,
              latestCursor: replay.latestCursor,
              reason: "服务器同步版本已变化或断线期间事件超出保留窗口。",
            });
          } else {
            this.send(socket, {
              type: "sync.replay",
              requestId: message.requestId,
              syncVersion: this.syncJournal.version,
              fromCursor: afterCursor ?? 0,
              toCursor: replay.latestCursor,
              events: replay.events,
            });
          }
          break;
        }
        case "threads.sync":
          await this.syncThreads(socket, message.requestId, message.knownVersion);
          break;
        case "threads.list":
          await this.listThreads(socket, message.requestId, message.limit);
          break;
        case "models.list": {
          const result = (await this.bridge.request("model/list", {
            limit: 100,
            includeHidden: false,
          })) as ModelListResult;
          this.send(socket, {
            type: "models",
            requestId: message.requestId,
            models: (result.data ?? []).map(toModelOption),
          });
          break;
        }
        case "skills.list": {
          const cwd =
            typeof message.cwd === "string" && message.cwd.trim()
              ? requiredAbsolutePath(message.cwd, "cwd")
              : undefined;
          const result = (await this.bridge.request(
            "skills/list",
            cwd ? { cwds: [cwd] } : {},
          )) as SkillsListResult;
          this.send(socket, {
            type: "skills",
            requestId: message.requestId,
            skills: flattenSkills(result),
          });
          break;
        }
        case "thread.open": {
          const threadId = requiredString(message.threadId, "threadId");
          this.socketThreads.get(socket)?.add(threadId);
          await this.openThreadPage(
            socket,
            threadId,
            message.requestId,
            message.historyLimit,
            message.knownTurnIds,
          );
          break;
        }
        case "thread.close": {
          const threadId = requiredString(message.threadId, "threadId");
          this.socketThreads.get(socket)?.delete(threadId);
          break;
        }
        case "thread.history": {
          const threadId = requiredString(message.threadId, "threadId");
          this.socketThreads.get(socket)?.add(threadId);
          await this.sendThreadHistoryPage(
            socket,
            threadId,
            message.requestId,
            message.cursor,
            message.limit,
            message.knownTurnIds,
          );
          break;
        }
        case "thread.start": {
          const cwd = requiredAbsolutePath(message.cwd, "cwd");
          const result = await this.bridge.request("thread/start", {
            cwd,
            ...(message.model ? { model: message.model } : {}),
            ...(message.modelProvider
              ? { modelProvider: message.modelProvider }
              : {}),
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            threadSource: "codex-mobile-remote",
          });
          const startedThread = asRecord(asRecord(result)?.thread);
          const startedId =
            typeof startedThread?.id === "string" ? startedThread.id : null;
          if (startedId) this.threadCwds.set(startedId, cwd);
          this.send(socket, {
            type: "thread",
            requestId: message.requestId,
            thread: result,
          });
          break;
        }
        case "thread.compact": {
          const threadId = requiredString(message.threadId, "threadId");
          if (this.desktopIpc?.hasOwner(threadId))
            await this.desktopIpc.compactThread(threadId);
          else await this.bridge.request("thread/compact/start", { threadId });
          this.send(socket, {
            type: "thread.compaction.accepted",
            requestId: message.requestId,
            threadId,
          });
          break;
        }
        case "thread.settings": {
          const threadId = requiredString(message.threadId, "threadId");
          const threadSettings = {
            ...(message.model ? { model: message.model } : {}),
            ...(message.effort ? { effort: message.effort } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.permissionMode
              ? permissionSettings(
                  message.permissionMode,
                  this.permissionCwd(threadId, message.permissionMode),
                )
              : {}),
            ...(message.collaborationMode
              ? { collaborationMode: message.collaborationMode }
              : {}),
          };
          if (this.desktopIpc?.hasOwner(threadId))
            await this.desktopIpc.updateThreadSettings(
              threadId,
              threadSettings,
            );
          else
            await this.bridge.request("thread/settings/update", {
              threadId,
              ...threadSettings,
            });
          this.send(socket, {
            type: "thread.settings.updated",
            requestId: message.requestId,
            threadId,
          });
          break;
        }
        case "thread.diff.get": {
          const threadId = requiredString(message.threadId, "threadId");
          const snapshot = await this.refreshThreadDiff(threadId, false);
          this.send(socket, { type: "thread.diff", requestId: message.requestId, snapshot });
          break;
        }
        case "prompt.queue.list": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const threadId = typeof message.threadId === "string" ? requiredString(message.threadId, "threadId") : undefined;
          this.send(socket, { type: "prompt.queue", requestId: message.requestId, items: this.promptQueue.list(threadId) });
          break;
        }
        case "prompt.queue.resume": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const threadId = requiredString(message.threadId, "threadId");
          await this.promptQueue.resumeThread(threadId);
          this.broadcastQueue(threadId);
          this.scheduleQueueDrain(threadId);
          break;
        }
        case "prompt.queue.cancel": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const itemId = requiredString(message.itemId, "itemId");
          const stored = this.promptQueue.get(itemId);
          if (!stored) throw new GatewayRequestError("queue_item_not_found", "排队提示词不存在或已经投递。");
          if (stored.status === "sending") throw new GatewayRequestError("queue_item_sending", "提示词正在投递，不能取消。");
          await this.promptQueue.cancel(itemId);
          this.releaseQueueUploads(stored);
          this.send(socket, { type: "prompt.queue.cancelled", requestId: message.requestId, threadId: stored.threadId, itemId });
          this.broadcastQueue(stored.threadId);
          break;
        }
        case "prompt.queue.promote": {
          if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
          const itemId = requiredString(message.itemId, "itemId");
          const stored = this.promptQueue.get(itemId);
          if (!stored) throw new GatewayRequestError("queue_item_not_found", "排队提示词不存在或已经投递。");
          if (stored.status === "sending") throw new GatewayRequestError("queue_item_sending", "提示词正在投递。");
          if (stored.status === "paused") throw new GatewayRequestError("queue_paused", "队列已暂停，请先恢复队列。");
          if (this.desktopIpc?.hasOwner(stored.threadId) && !this.isThreadActive(stored.threadId)) {
            throw new GatewayRequestError("desktop_queue_coordination_required", "电脑端 GUI 正在管理该空闲会话；当前协议没有共享队列锁，不能安全地从手机强制启动下一轮。请在任务执行中使用立即引导，或关闭电脑端会话后再发送。");
          }
          const item = await this.promptQueue.claim(itemId);
          if (!item) throw new GatewayRequestError("queue_item_not_found", "排队提示词不存在或已经投递。");
          this.broadcastQueue(item.threadId);
          this.turnSubmissions.delete(`${item.threadId}:${item.clientUserMessageId}`);
          const result = await this.deliverClaimedQueueItem(item, "promote");
          const turnResult = asRecord(result);
          this.send(socket, { type: "turn.started", requestId: message.requestId, threadId: item.threadId, turn: turnResult?.turn ?? result });
          break;
        }
        case "turn.start": {
          const threadId = requiredString(message.threadId, "threadId");
          const text = requiredString(message.text, "text");
          const input: Array<Record<string, unknown>> = [];
          const queuedUploadIds: string[] = [];
          const queuedFileNames: string[] = [];
          const queuedFilePaths: string[] = [];
          if (message.skill) {
            input.push({
              type: "skill",
              name: requiredString(message.skill.name, "skill.name"),
              path: requiredAbsolutePath(message.skill.path, "skill.path"),
            });
          }
          for (const attachment of message.attachments ?? []) {
            if (!this.files) throw new Error("File transfer is unavailable.");
            const uploadId = requiredString(attachment.uploadId, "attachment.uploadId");
            const upload = await this.files.getUpload(uploadId);
            queuedUploadIds.push(uploadId);
            queuedFileNames.push(upload.fileName);
            queuedFilePaths.push(upload.path);
            if (
              attachment.type === "image" ||
              upload.mimeType.startsWith("image/")
            ) {
              input.push({ type: "localImage", path: upload.path });
            } else {
              input.push({
                type: "mention",
                name: upload.fileName,
                path: upload.path,
              });
            }
          }
          input.push({ type: "text", text, text_elements: [] });
          const turnParams = {
            threadId,
            input,
            ...(message.clientUserMessageId
              ? {
                  clientUserMessageId: requiredString(
                    message.clientUserMessageId,
                    "clientUserMessageId",
                  ),
                }
              : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(message.effort ? { effort: message.effort } : {}),
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.permissionMode
              ? permissionSettings(
                  message.permissionMode,
                  this.permissionCwd(threadId, message.permissionMode),
                )
              : {}),
            ...(message.collaborationMode
              ? { collaborationMode: message.collaborationMode }
              : {}),
          };
          const clientUserMessageId = typeof turnParams.clientUserMessageId === "string"
            ? turnParams.clientUserMessageId
            : undefined;
          const deliveryMode = message.deliveryMode ?? "auto";
          if (deliveryMode === "queue") {
            if (!this.promptQueue || !clientUserMessageId) throw new GatewayRequestError("queue_unavailable", "提示词队列不可用或缺少 clientUserMessageId。");
            for (const uploadId of queuedUploadIds) this.files?.pinUpload(uploadId);
            let item: StoredPromptQueueItem;
            try {
              item = await this.promptQueue.enqueue({
                threadId,
                clientUserMessageId,
                text,
                turnParams,
                fileNames: queuedFileNames,
                filePaths: queuedFilePaths,
                uploadIds: queuedUploadIds,
              });
            } catch (error) {
              for (const uploadId of queuedUploadIds) this.files?.releaseUpload(uploadId);
              if (String(error).includes("idempotency_conflict")) {
                throw new GatewayRequestError("idempotency_conflict", "同一个 clientUserMessageId 被用于不同的排队内容。");
              }
              throw error;
            }
            if (this.desktopIpc?.hasOwner(threadId)) {
              await this.promptQueue.requeue(item.id, "电脑端 GUI 正在作为会话 owner。当前 Desktop IPC 没有可供外部 follower 参与的原生队列锁；为避免双 start，手机队列不会自动启动。执行中可点“立即引导”。");
            }
            this.send(socket, { type: "prompt.queued", requestId: message.requestId, threadId, item: this.promptQueue.list(threadId).find((candidate) => candidate.id === item.id)! });
            this.broadcastQueue(threadId);
            this.scheduleQueueDrain(threadId);
            break;
          }
          const result = await this.submitPreparedTurn(threadId, turnParams, deliveryMode);
          const turnResult = asRecord(result);
          this.send(socket, {
            type: "turn.started",
            requestId: message.requestId,
            threadId,
            turn: turnResult?.turn ?? result,
          });
          break;
        }
        case "turn.interrupt": {
          const threadId = requiredString(message.threadId, "threadId");
          if (this.desktopIpc?.hasOwner(threadId))
            await this.desktopIpc.interruptTurn(threadId, "user");
          else
            await this.bridge.request("turn/interrupt", {
              threadId,
              turnId: requiredString(message.turnId, "turnId"),
            });
          break;
        }
        case "approval.resolve":
          await this.resolveApproval(
            socket,
            message.approvalRequestId,
            message.decision,
            message.requestId,
          );
          break;
        default:
          this.send(socket, {
            type: "error",
            code: "unknown_message",
            message: "Unsupported message type.",
          });
      }
    } catch (error) {
      this.send(socket, {
        type: "error",
        requestId: "requestId" in message ? message.requestId : undefined,
        code:
          error instanceof GatewayRequestError ? error.code : "request_failed",
        message: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  private async refreshThreadDiff(threadId: string, broadcast: boolean): Promise<GitDiffSnapshot> {
    const cwd = this.threadCwds.get(threadId)
      ?? (typeof this.desktopThreads.get(threadId)?.cwd === "string" ? this.desktopThreads.get(threadId)!.cwd as string : undefined);
    if (!cwd) {
      const snapshot = emptyGitDiff(threadId, "", "任务工作目录尚未同步。");
      if (broadcast) this.broadcastThread(threadId, { type: "thread.diff", snapshot });
      return snapshot;
    }
    try {
      const snapshot = await readGitDiff(threadId, cwd);
      this.gitDiffs.set(threadId, snapshot);
      if (broadcast) this.broadcastThread(threadId, { type: "thread.diff", snapshot });
      return snapshot;
    } catch (error) {
      const message = error instanceof GitDiffError ? error.message : `读取 Git Diff 失败：${error instanceof Error ? error.message : String(error)}`;
      const snapshot = emptyGitDiff(threadId, cwd, message);
      this.gitDiffs.set(threadId, snapshot);
      if (broadcast) this.broadcastThread(threadId, { type: "thread.diff", snapshot });
      return snapshot;
    }
  }

  private async submitPreparedTurn(
    threadId: string,
    turnParams: Record<string, unknown>,
    deliveryMode: "auto" | "steer",
  ): Promise<unknown> {
    const clientUserMessageId = typeof turnParams.clientUserMessageId === "string" ? turnParams.clientUserMessageId : undefined;
    const desktopOwned = this.desktopIpc?.hasOwner(threadId) === true;
    const result = await this.submitTurnIdempotently(threadId, clientUserMessageId, JSON.stringify(turnParams), async () => {
      if (deliveryMode === "steer") return this.steerCurrentTurn(threadId, turnParams);
      if (!desktopOwned) return this.bridge.request("turn/start", turnParams);
      try {
        return await this.desktopIpc.steerTurn(threadId, turnParams);
      } catch (error) {
        if (isExplicitInactiveSteerError(error)) return this.desktopIpc.startTurn(threadId, turnParams);
        if (isUncertainDesktopSubmissionError(error)) {
          throw new GatewayRequestError(
            "submission_state_unknown",
            "提交结果不确定：Desktop IPC 未确认响应。为避免重复消息，未自动新建 turn；请刷新任务历史确认。",
          );
        }
        throw error;
      }
    });
    if (deliveryMode !== "steer" && !desktopOwned) this.rememberAppServerStartedTurn(threadId, result);
    return result;
  }

  private async steerCurrentTurn(threadId: string, turnParams: Record<string, unknown>): Promise<unknown> {
    if (this.desktopIpc?.hasOwner(threadId)) {
      try {
        return await this.desktopIpc.steerTurn(threadId, turnParams);
      } catch (error) {
        if (isExplicitInactiveSteerError(error)) throw new GatewayRequestError("no_active_turn", "当前 turn 已结束，无法引导；请选择普通发送或排队下一轮。");
        if (isUncertainDesktopSubmissionError(error)) {
          throw new GatewayRequestError("submission_state_unknown", "引导结果不确定：Desktop IPC 未确认响应。请刷新任务历史确认，避免重复发送。");
        }
        throw error;
      }
    }
    const expectedTurnId = this.appServerCurrentTurnIds.get(threadId);
    if (!expectedTurnId) throw new GatewayRequestError("no_active_turn", "尚未确认当前 turnId，无法安全引导。");
    return this.bridge.request("turn/steer", {
      threadId,
      clientUserMessageId: turnParams.clientUserMessageId,
      input: turnParams.input,
      expectedTurnId,
    });
  }

  private rememberAppServerStartedTurn(threadId: string, value: unknown): void {
    const outer = asRecord(value);
    const turn = asRecord(outer?.turn) ?? outer;
    const turnId = typeof turn?.id === "string" ? turn.id : typeof turn?.turnId === "string" ? turn.turnId : null;
    if (turnId) this.appServerCurrentTurnIds.set(threadId, turnId);
    const previous = asRecord(this.appServerThreadStatuses.get(threadId));
    this.appServerThreadStatuses.set(threadId, {
      type: "active",
      activeFlags: activeFlags(previous),
    });
  }

  private rememberAppServerCompletedTurn(threadId: string, turn: Record<string, unknown> | null): void {
    const completedTurnId = typeof turn?.id === "string"
      ? turn.id
      : typeof turn?.turnId === "string"
        ? turn.turnId
        : null;
    const currentTurnId = this.appServerCurrentTurnIds.get(threadId);
    if (currentTurnId && completedTurnId && currentTurnId !== completedTurnId) return;
    this.appServerCurrentTurnIds.delete(threadId);
    this.appServerThreadStatuses.set(threadId, { type: "idle" });
  }

  private rememberAppServerThreadStatus(threadId: string, status: unknown): void {
    const normalized = asRecord(status);
    if (!normalized || typeof normalized.type !== "string") return;
    this.appServerThreadStatuses.set(threadId, normalized);
  }

  private appServerThreadIsActive(threadId: string): boolean {
    if (this.appServerCurrentTurnIds.has(threadId)) return true;
    return statusType(this.appServerThreadStatuses.get(threadId)) === "active";
  }

  private isThreadActive(threadId: string): boolean {
    if (this.appServerThreadIsActive(threadId)) return true;
    return this.desktopIpc?.hasOwner(threadId) === true && conversationIsActive(this.desktopIpc.getConversation(threadId));
  }

  private mergedThreadStatus(threadId: string, fallback: unknown): unknown {
    const appServerStatus = this.appServerThreadStatuses.get(threadId);
    const desktopThread = this.desktopThreads.get(threadId);
    const desktopStatus = desktopThread?.threadRuntimeStatus ?? desktopThread?.status;
    const appServerActive = this.appServerThreadIsActive(threadId);
    const desktopActive = conversationIsActive(desktopThread);
    if (appServerActive || desktopActive) {
      return {
        type: "active",
        activeFlags: [...new Set([
          ...activeFlags(appServerStatus),
          ...activeFlags(desktopStatus),
        ])],
      };
    }
    if (isLoadedStatus(appServerStatus)) return appServerStatus;
    if (isLoadedStatus(desktopStatus)) return desktopStatus;
    return appServerStatus ?? desktopStatus ?? fallback;
  }

  private projectThreadRuntimeStatus(thread: Record<string, unknown>): Record<string, unknown> {
    const status = this.mergedThreadStatus(String(thread.id ?? ""), thread.threadRuntimeStatus ?? thread.status);
    return { ...thread, status, threadRuntimeStatus: status };
  }

  private scheduleQueueDrain(threadId: string): void {
    if (!this.promptQueue || this.queueDrains.has(threadId)) return;
    const drain = Promise.resolve().then(() => this.drainPromptQueue(threadId)).catch((error) => {
      console.warn("[prompt-queue] drain", threadId, error);
    }).finally(() => {
      this.queueDrains.delete(threadId);
    });
    this.queueDrains.set(threadId, drain);
  }

  private async drainPromptQueue(threadId: string): Promise<void> {
    if (!this.promptQueue || this.isThreadActive(threadId)) return;
    // Strict single-owner rule: Desktop native queue and Host queue cannot share
    // an atomic lock. Never auto-start while Desktop owns the conversation.
    if (this.desktopIpc?.hasOwner(threadId)) return;
    const item = await this.promptQueue.claimNext(threadId);
    if (!item) return;
    this.broadcastQueue(threadId);
    await this.deliverClaimedQueueItem(item, "queue");
  }

  private async deliverClaimedQueueItem(item: StoredPromptQueueItem, mode: "queue" | "promote"): Promise<unknown> {
    if (!this.promptQueue) throw new GatewayRequestError("queue_unavailable", "提示词队列未启用。");
    try {
      if (mode === "queue" && this.isThreadActive(item.threadId)) {
        await this.promptQueue.requeue(item.id, "检测到新的活动 turn，继续等待下一轮，未创建竞争 turn。");
        this.broadcastQueue(item.threadId);
        return {};
      }
      const result = mode === "queue"
        ? await this.startQueuedTurn(item.threadId, item.turnParams)
        : this.isThreadActive(item.threadId)
          ? await this.submitPreparedTurn(item.threadId, item.turnParams, "steer")
          : await this.startQueuedTurn(item.threadId, item.turnParams);
      await this.promptQueue.complete(item.id);
      this.releaseQueueUploads(item);
      this.broadcastQueue(item.threadId);
      return result;
    } catch (error) {
      if (mode === "queue" && error instanceof GatewayRequestError && error.code === "queue_turn_active") {
        await this.promptQueue.requeue(item.id, error.message);
        this.broadcastQueue(item.threadId);
        return {};
      }
      const uncertain = error instanceof GatewayRequestError && error.code === "submission_state_unknown";
      await this.promptQueue.fail(item.id, error instanceof Error ? error.message : String(error), uncertain);
      this.broadcastQueue(item.threadId);
      throw error;
    }
  }

  private async startQueuedTurn(threadId: string, turnParams: Record<string, unknown>): Promise<unknown> {
    if (this.isThreadActive(threadId)) throw new GatewayRequestError("queue_turn_active", "检测到新的活动 turn，队列继续等待，未创建竞争 turn。");
    const clientUserMessageId = typeof turnParams.clientUserMessageId === "string" ? turnParams.clientUserMessageId : undefined;
    const desktopOwned = this.desktopIpc?.hasOwner(threadId) === true;
    const result = await this.submitTurnIdempotently(threadId, clientUserMessageId, JSON.stringify(turnParams), async () => {
      try {
        return desktopOwned
          ? await this.desktopIpc!.startTurn(threadId, turnParams)
          : await this.bridge.request("turn/start", turnParams);
      } catch (error) {
        if (isUncertainDesktopSubmissionError(error)) {
          throw new GatewayRequestError("submission_state_unknown", "排队提示词的启动结果不确定；已暂停自动重试，请刷新历史确认。");
        }
        throw error;
      }
    });
    if (!desktopOwned) this.rememberAppServerStartedTurn(threadId, result);
    return result;
  }

  private async pausePromptQueue(threadId: string, reason: string): Promise<void> {
    if (!this.promptQueue) return;
    if (await this.promptQueue.pauseThread(threadId, reason)) this.broadcastQueue(threadId);
  }

  private async trustDesktopAttachments(thread: Record<string, unknown>): Promise<void> {
    if (!this.files) return;
    const paths = desktopAttachmentPaths(thread);
    await Promise.all(paths.map(async (path) => {
      try {
        await this.files!.trustDesktopAttachment(path);
      } catch (error) {
        console.warn("[desktop-attachment]", path, error instanceof Error ? error.message : error);
      }
    }));
  }

  private releaseQueueUploads(item: StoredPromptQueueItem): void {
    for (const uploadId of item.uploadIds) this.files?.releaseUpload(uploadId);
  }

  private broadcastQueue(threadId: string): void {
    if (this.promptQueue) this.broadcast({ type: "prompt.queue.updated", threadId, items: this.promptQueue.list(threadId) });
  }

  private submitTurnIdempotently(
    threadId: string,
    clientUserMessageId: string | undefined,
    fingerprint: string,
    submit: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!clientUserMessageId) return submit();
    this.pruneTurnSubmissions();
    const key = `${threadId}:${clientUserMessageId}`;
    const existing = this.turnSubmissions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new GatewayRequestError(
          "idempotency_conflict",
          "同一个 clientUserMessageId 被用于不同内容，已拒绝以避免重复或错配。",
        );
      }
      return existing.promise;
    }
    const promise = Promise.resolve().then(submit);
    this.turnSubmissions.set(key, {
      fingerprint,
      createdAt: Date.now(),
      promise,
    });
    return promise;
  }

  private pruneTurnSubmissions(now = Date.now()): void {
    for (const [key, entry] of this.turnSubmissions) {
      if (now - entry.createdAt > TURN_SUBMISSION_TTL_MS)
        this.turnSubmissions.delete(key);
    }
    while (this.turnSubmissions.size >= MAX_TURN_SUBMISSIONS) {
      const oldest = this.turnSubmissions.keys().next().value as
        string | undefined;
      if (!oldest) break;
      this.turnSubmissions.delete(oldest);
    }
  }

  private async ensureThreadIndex(): Promise<void> {
    if (this.threadIndex.isInitialized) return;
    if (this.threadIndexLoad) return this.threadIndexLoad;
    this.threadIndexLoad = (async () => {
      const data: Array<Record<string, unknown>> = [];
      let cursor: string | null | undefined;
      do {
        const result = (await this.bridge.request("thread/list", {
          limit: Math.min(100, 1_000 - data.length),
          ...(cursor ? { cursor } : {}),
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: THREAD_SOURCE_KINDS,
        })) as ThreadListResult;
        data.push(...(result.data ?? []));
        cursor = result.nextCursor;
        if ((result.data?.length ?? 0) === 0) break;
      } while (cursor && data.length < 1_000);
      const byId = new Map(data.map((thread) => {
        const summary = toThreadSummary(thread);
        return [summary.id, summary] as const;
      }));
      for (const desktopThread of this.desktopThreads.values()) {
        const summary = toThreadSummary(desktopThread);
        if (summary.id) byId.set(summary.id, summary);
      }
      this.threadIndex.replace([...byId.values()].map((thread) => ({
        ...thread,
        status: this.mergedThreadStatus(thread.id, thread.status),
      })));
      for (const thread of this.threadIndex.snapshot()) {
        if (thread.cwd.startsWith("/")) this.threadCwds.set(thread.id, thread.cwd);
      }
    })().finally(() => {
      this.threadIndexLoad = null;
    });
    return this.threadIndexLoad;
  }

  private async syncThreads(socket: WebSocket, requestId?: string, knownVersion?: number): Promise<void> {
    await this.ensureThreadIndex();
    if (typeof knownVersion === "number") {
      const delta = this.threadIndex.deltaAfter(knownVersion);
      if (delta) {
        this.send(socket, {
          type: "threads.delta",
          requestId,
          baseVersion: knownVersion,
          version: delta.version,
          upserts: delta.upserts,
          removedIds: delta.removedIds,
        });
        return;
      }
    }
    this.send(socket, {
      type: "threads.snapshot",
      requestId,
      version: this.threadIndex.currentVersion,
      threads: this.threadIndex.snapshot(),
    });
  }

  private async listThreads(
    socket: WebSocket,
    requestId?: string,
    requestedLimit?: number,
  ): Promise<void> {
    await this.ensureThreadIndex();
    const limit = Math.min(Math.max(requestedLimit ?? 1_000, 1), 1_000);
    this.send(socket, {
      type: "threads",
      requestId,
      threads: this.threadIndex.snapshot().slice(0, limit),
      nextCursor: null,
    });
  }

  private upsertThreadSummary(summary: ThreadSummary): void {
    if (!summary.id) return;
    if (summary.cwd.startsWith("/")) this.threadCwds.set(summary.id, summary.cwd);
    const change = this.threadIndex.upsert(summary);
    if (!change) return;
    this.broadcast({
      type: "threads.delta",
      baseVersion: change.version - 1,
      version: change.version,
      upserts: change.upserts,
      removedIds: change.removedIds,
    });
  }

  private updateThreadIndexFromNotification(method: string, params: Record<string, unknown> | null): void {
    if (!params) return;
    const nestedThread = asRecord(params.thread);
    if (method === "thread/started" && nestedThread) {
      const summary = toThreadSummary(nestedThread);
      this.upsertThreadSummary({ ...summary, status: this.mergedThreadStatus(summary.id, summary.status) });
      return;
    }
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    if (method === "thread/deleted" || method === "thread/archived") {
      const change = this.threadIndex.remove(threadId);
      if (change) this.broadcast({ type: "threads.delta", baseVersion: change.version - 1, version: change.version, upserts: [], removedIds: [threadId] });
      return;
    }
    const updatedAt = Math.floor(Date.now() / 1_000);
    const patch: Partial<ThreadSummary> = { updatedAt };
    if (method === "thread/status/changed") patch.status = this.mergedThreadStatus(threadId, params.status);
    else if (method === "turn/started") patch.status = { type: "active", activeFlags: [] };
    else if (method === "turn/completed") patch.status = this.mergedThreadStatus(threadId, { type: "idle" });
    else return;
    const change = this.threadIndex.patch(threadId, patch);
    if (change) this.broadcast({ type: "threads.delta", baseVersion: change.version - 1, version: change.version, upserts: change.upserts, removedIds: [] });
  }

  private async openThreadPage(
    socket: WebSocket,
    threadId: string,
    requestId?: string,
    requestedLimit?: number,
    knownTurnIds?: string[],
  ): Promise<void> {
    const limit = boundedHistoryLimit(requestedLimit);
    const desktopThread = await this.desktopIpc?.openConversation(threadId, "local", 2_500, false);
    let metadataPayload: unknown;
    if (desktopThread && this.desktopIpc?.hasOwner(threadId)) {
      this.desktopThreads.set(threadId, desktopThread);
      metadataPayload = { thread: projectDesktopLiveThread(desktopThread) };
    } else {
      metadataPayload = await this.bridge.request("thread/resume", { threadId, excludeTurns: true });
    }
    this.rememberThreadCwd(threadId, metadataPayload);
    const page = await this.readTurnsPage(threadId, null, limit, knownTurnIds);
    const metadata = threadMetadataFromPayload(metadataPayload, threadId);
    const liveTurns = desktopThread ? canonicalTurns(projectDesktopLiveThread(desktopThread)) : [];
    const turns = mergeTurns(page.turns, liveTurns);
    const thread = { ...metadata, turns };
    await this.trustDesktopAttachments(thread);
    const summary = toThreadSummary(thread);
    this.upsertThreadSummary({ ...summary, status: this.mergedThreadStatus(threadId, summary.status) });
    this.send(socket, {
      type: "thread",
      requestId,
      thread: { thread },
      history: page.history,
    });
    this.scheduleQueueDrain(threadId);
  }

  private async sendThreadHistoryPage(
    socket: WebSocket,
    threadId: string,
    requestId?: string,
    cursor?: string | null,
    requestedLimit?: number,
    knownTurnIds?: string[],
  ): Promise<void> {
    const page = await this.readTurnsPage(threadId, cursor ?? null, boundedHistoryLimit(requestedLimit), knownTurnIds);
    this.send(socket, {
      type: "thread.history",
      requestId,
      threadId,
      turns: page.turns,
      history: page.history,
    });
  }

  private async readTurnsPage(
    threadId: string,
    cursor: string | null,
    limit: number,
    knownTurnIds?: string[],
  ): Promise<{ turns: Array<Record<string, unknown>>; history: { nextCursor: string | null; backwardsCursor: string | null; hasMore: boolean; legacyFullHistory?: boolean } }> {
    try {
      const result = (await this.bridge.request("thread/turns/list", {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit,
        sortDirection: "desc",
        itemsView: "full",
      })) as ThreadTurnsListResult;
      const known = new Set((knownTurnIds ?? []).slice(0, 500));
      const turns = [...(result.data ?? [])]
        .filter((turn) => !known.has(String(turn.id ?? "")) || turnInProgress(turn))
        .reverse();
      return {
        turns,
        history: {
          nextCursor: result.nextCursor ?? null,
          backwardsCursor: result.backwardsCursor ?? null,
          hasMore: Boolean(result.nextCursor),
        },
      };
    } catch (error) {
      if (!isMethodUnavailable(error)) throw error;
      const result = await this.bridge.request("thread/read", { threadId, includeTurns: true });
      const metadata = threadMetadataFromPayload(result, threadId);
      const allTurns = Array.isArray(metadata.turns) ? metadata.turns.filter((turn): turn is Record<string, unknown> => Boolean(asRecord(turn))) : [];
      const known = new Set((knownTurnIds ?? []).slice(0, 500));
      return {
        turns: allTurns.filter((turn) => !known.has(String(turn.id ?? "")) || turnInProgress(turn)),
        history: { nextCursor: null, backwardsCursor: null, hasMore: false, legacyFullHistory: true },
      };
    }
  }

  private rememberThreadCwd(threadId: string, payload: unknown): void {
    const outer = asRecord(payload);
    const thread = asRecord(outer?.thread) ?? outer;
    if (typeof thread?.cwd === "string" && thread.cwd.startsWith("/"))
      this.threadCwds.set(threadId, thread.cwd);
  }

  private permissionCwd(
    threadId: string,
    mode:
      "auto" | "granular" | "read-only" | "guardian-approvals" | "full-access",
  ): string | undefined {
    if (mode === "read-only" || mode === "full-access") return undefined;
    const desktopCwd = this.desktopThreads.get(threadId)?.cwd;
    const cwd =
      typeof desktopCwd === "string"
        ? desktopCwd
        : this.threadCwds.get(threadId);
    if (!cwd || !cwd.startsWith("/"))
      throw new Error(
        "Task working directory is unavailable; refusing to widen workspace permissions.",
      );
    return cwd;
  }

  private syncDesktopApprovals(
    threadId: string,
    thread: Record<string, unknown>,
  ): void {
    const activeKeys = new Set<number | string>();
    const requests = Array.isArray(thread.requests) ? thread.requests : [];
    for (const value of requests) {
      const request = asRecord(value);
      if (!request || !isApprovalMethod(String(request.method ?? ""))) continue;
      const originalId =
        typeof request.id === "string" || typeof request.id === "number"
          ? request.id
          : null;
      if (originalId == null) continue;
      const wireId = `desktop:${threadId}:${String(originalId)}`;
      activeKeys.add(wireId);
      const params = {
        ...(asRecord(request.params) ?? {}),
        threadId,
        _desktopRequestId: originalId,
        _desktopOrigin: true,
      };
      const envelope: RpcEnvelope = {
        id: wireId,
        method: String(request.method),
        params,
      };
      const wasPending = this.approvals.has(wireId);
      this.approvals.set(wireId, envelope);
      this.desktopApprovalKeys.add(wireId);
      if (!wasPending)
        this.broadcast({
          type: "approval",
          approval: normalizeApproval(envelope),
        });
    }
    for (const wireId of [...this.desktopApprovalKeys]) {
      if (
        !String(wireId).startsWith(`desktop:${threadId}:`) ||
        activeKeys.has(wireId)
      )
        continue;
      this.desktopApprovalKeys.delete(wireId);
      if (this.approvals.delete(wireId))
        this.broadcast({
          type: "approval.resolved",
          approvalRequestId: wireId,
        });
    }
  }

  private onServerRequest(message: RpcEnvelope): void {
    if (!isApprovalMethod(message.method)) {
      this.bridge.respondError(
        message.id,
        -32601,
        `Unsupported client callback: ${message.method}`,
      );
      return;
    }
    this.approvals.set(message.id, message);
    const params = message.params ?? {};
    const diff =
      typeof params.threadId === "string" && typeof params.turnId === "string"
        ? this.turnDiffs.get(turnKey(params.threadId, params.turnId))
        : undefined;
    this.broadcast({
      type: "approval",
      approval: normalizeApproval(message, diff),
    });
  }

  private async resolveApproval(
    socket: WebSocket,
    approvalRequestId: number | string,
    decision: ApprovalDecision,
    requestId?: string,
  ): Promise<void> {
    const pending = this.approvals.get(approvalRequestId);
    if (!pending) throw new Error("Approval request is no longer pending.");
    const result = approvalResult(pending.method, decision, pending.params);
    if (pending.params?._desktopOrigin === true) {
      const threadId = requiredString(pending.params.threadId, "threadId");
      const originalId = pending.params._desktopRequestId;
      if (typeof originalId !== "string" && typeof originalId !== "number")
        throw new Error("Desktop approval request ID is invalid.");
      await this.desktopIpc?.resolveApproval(
        threadId,
        pending.method,
        originalId,
        result,
      );
      this.desktopApprovalKeys.delete(approvalRequestId);
    } else {
      this.bridge.respond(approvalRequestId, result);
    }
    this.approvals.delete(approvalRequestId);
    const notification: ServerMessage = {
      type: "approval.resolved",
      requestId,
      approvalRequestId,
    };
    this.broadcast(notification);
  }

  private broadcast(message: ServerMessage): void {
    const synced = this.syncJournal.append(message);
    const payload = JSON.stringify(synced);
    for (const socket of this.wss.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  private broadcastThread(threadId: string, message: ServerMessage): void {
    const synced = this.syncJournal.append(message, threadId);
    const payload = JSON.stringify(synced);
    for (const socket of this.wss.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (this.socketThreads.get(socket)?.has(threadId)) socket.send(payload);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  private isRateLimited(address: string): boolean {
    const entry = this.failedAuth.get(address);
    if (!entry) return false;
    if (Date.now() >= entry.resetAt) {
      this.failedAuth.delete(address);
      return false;
    }
    return entry.count >= 10;
  }

  private recordAuthFailure(address: string): void {
    const now = Date.now();
    const entry = this.failedAuth.get(address);
    if (!entry || now >= entry.resetAt) {
      this.failedAuth.set(address, { count: 1, resetAt: now + 60_000 });
    } else {
      entry.count += 1;
    }
  }
}

export function desktopAttachmentPaths(thread: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("/")) paths.add(value);
  };
  for (const turnValue of canonicalTurns(thread)) {
    const turn = asRecord(turnValue);
    for (const itemValue of Array.isArray(turn?.items) ? turn.items : []) {
      const item = asRecord(itemValue);
      if (!item || !String(item.type ?? "").toLowerCase().includes("user")) continue;
      for (const inputValue of Array.isArray(item.input) ? item.input : []) {
        const input = asRecord(inputValue);
        const type = String(input?.type ?? "").toLowerCase();
        if (type.includes("image") || type.includes("file") || type.includes("mention")) add(input?.path);
      }
      for (const attachmentValue of Array.isArray(item.attachments) ? item.attachments : []) {
        const attachment = asRecord(attachmentValue);
        add(attachment?.fsPath);
        add(attachment?.path);
      }
      const restore = asRecord(item.restoreMessage);
      const context = asRecord(restore?.context);
      for (const key of ["imageAttachments", "fileAttachments"]) {
        for (const attachmentValue of Array.isArray(context?.[key]) ? context[key] as unknown[] : []) {
          const attachment = asRecord(attachmentValue);
          add(attachment?.localPath);
          add(attachment?.fsPath);
          add(attachment?.path);
        }
      }
    }
  }
  return [...paths];
}

export function projectDesktopLiveThread(thread: Record<string, unknown>): Record<string, unknown> {
  const { turnHistory: _turnHistory, turns: _turns, ...metadata } = thread;
  const turns = canonicalTurns(thread);
  const active = turns.filter((turn) => turnInProgress(asRecord(turn) ?? {}));
  const recent = turns.slice(-2);
  return { ...metadata, turns: mergeTurns(recent.filter((turn): turn is Record<string, unknown> => Boolean(asRecord(turn))), active.filter((turn): turn is Record<string, unknown> => Boolean(asRecord(turn)))) };
}

function threadMetadataFromPayload(payload: unknown, threadId: string): Record<string, unknown> {
  const outer = asRecord(payload) ?? {};
  const nested = asRecord(outer.thread) ?? outer;
  const latestThreadSettings = {
    ...(asRecord(nested.latestThreadSettings) ?? {}),
    ...(typeof outer.model === "string" ? { model: outer.model } : {}),
    ...(typeof outer.reasoningEffort === "string" ? { effort: outer.reasoningEffort } : {}),
    ...(outer.sandbox != null ? { sandboxPolicy: outer.sandbox } : {}),
    ...(outer.approvalPolicy != null ? { approvalPolicy: outer.approvalPolicy } : {}),
    ...(outer.approvalsReviewer != null ? { approvalsReviewer: outer.approvalsReviewer } : {}),
  };
  return {
    ...nested,
    id: typeof nested.id === "string" ? nested.id : threadId,
    ...(typeof outer.cwd === "string" ? { cwd: outer.cwd } : {}),
    ...(typeof outer.modelProvider === "string" ? { modelProvider: outer.modelProvider } : {}),
    latestThreadSettings,
    turns: Array.isArray(nested.turns) ? nested.turns : [],
  };
}

function mergeTurns(...groups: unknown[][]): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  let fallback = 0;
  for (const group of groups) {
    for (const value of group) {
      const turn = asRecord(value);
      if (!turn) continue;
      const canonicalId = typeof turn.id === "string"
        ? turn.id
        : typeof turn.turnId === "string"
          ? turn.turnId
          : `turn_${fallback++}`;
      const previous = byId.get(canonicalId);
      byId.set(canonicalId, {
        ...previous,
        ...turn,
        id: canonicalId,
        ...(previous || Array.isArray(turn.items)
          ? { items: mergeTurnItems(previous?.items, turn.items) }
          : {}),
      });
    }
  }
  return [...byId.values()].sort((a, b) => turnTimestamp(a) - turnTimestamp(b));
}

function mergeTurnItems(previousValue: unknown, nextValue: unknown): unknown[] {
  const previous = Array.isArray(previousValue) ? previousValue : [];
  const next = Array.isArray(nextValue) ? nextValue : [];
  const merged: unknown[] = [];
  const indexById = new Map<string, number>();
  for (const value of [...previous, ...next]) {
    const item = asRecord(value);
    const id = typeof item?.id === "string"
      ? item.id
      : typeof item?.itemId === "string"
        ? item.itemId
        : undefined;
    if (!id) {
      merged.push(value);
      continue;
    }
    const existingIndex = indexById.get(id);
    if (existingIndex == null) {
      indexById.set(id, merged.length);
      merged.push(value);
      continue;
    }
    const existing = asRecord(merged[existingIndex]);
    merged[existingIndex] = existing && item ? { ...existing, ...item, id } : value;
  }
  return merged;
}

function turnTimestamp(turn: Record<string, unknown>): number {
  const value = turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs ?? 0;
  return typeof value === "number" ? value : 0;
}

function turnInProgress(turn: Record<string, unknown>): boolean {
  return String(turn.status ?? "").toLowerCase().includes("progress");
}

function boundedHistoryLimit(value: unknown): number {
  return Math.min(Math.max(typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 20, 5), 50);
}

function isMethodUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /method not found|unknown method|unsupported method|-32601/i.test(text);
}

function isThreadContentEvent(method: string): boolean {
  return method.startsWith("item/")
    || method.includes("/delta")
    || method === "turn/diff/updated"
    || method === "thread/tokenUsage/updated";
}

function emptyGitDiff(threadId: string, cwd: string, error: string): GitDiffSnapshot {
  return { threadId, cwd, repositoryRoot: "", diff: "", files: 0, additions: 0, deletions: 0, truncated: false, generatedAt: Date.now(), error };
}


function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusType(value: unknown): string {
  return String(asRecord(value)?.type ?? "").toLowerCase();
}

function activeFlags(value: unknown): string[] {
  const flags = asRecord(value)?.activeFlags;
  return Array.isArray(flags) ? flags.map(String) : [];
}

function isLoadedStatus(value: unknown): boolean {
  const type = statusType(value);
  return type === "idle" || type === "systemerror";
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required.`);
  return value;
}

function requiredAbsolutePath(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (!text.startsWith("/"))
    throw new Error(`${name} must be an absolute path.`);
  return text;
}

function toThreadSummary(thread: Record<string, unknown>): ThreadSummary {
  const source = asRecord(thread.source);
  const subAgent = asRecord(source?.subAgent ?? source?.sub_agent);
  const threadSpawn = asRecord(subAgent?.thread_spawn ?? subAgent?.threadSpawn);
  return {
    id: String(thread.id ?? ""),
    name:
      typeof thread.name === "string"
        ? thread.name
        : typeof thread.title === "string"
          ? thread.title
          : null,
    preview:
      typeof thread.preview === "string"
        ? thread.preview
        : typeof thread.title === "string"
          ? thread.title
          : "",
    cwd: typeof thread.cwd === "string" ? thread.cwd : "",
    modelProvider:
      typeof thread.modelProvider === "string" ? thread.modelProvider : "",
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : 0,
    status: thread.status ?? thread.threadRuntimeStatus ?? null,
    parentThreadId:
      typeof thread.parentThreadId === "string"
        ? thread.parentThreadId
        : typeof threadSpawn?.parent_thread_id === "string"
          ? threadSpawn.parent_thread_id
          : typeof threadSpawn?.parentThreadId === "string"
            ? threadSpawn.parentThreadId
            : null,
    agentNickname:
      typeof thread.agentNickname === "string"
        ? thread.agentNickname
        : typeof threadSpawn?.agent_nickname === "string"
          ? threadSpawn.agent_nickname
          : typeof threadSpawn?.agentNickname === "string"
            ? threadSpawn.agentNickname
            : null,
    agentRole:
      typeof thread.agentRole === "string"
        ? thread.agentRole
        : typeof threadSpawn?.agent_role === "string"
          ? threadSpawn.agent_role
          : typeof threadSpawn?.agentRole === "string"
            ? threadSpawn.agentRole
            : null,
    source: thread.source ?? null,
  };
}

function toModelOption(model: Record<string, unknown>): ModelOption {
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
        const entry = asRecord(value);
        const reasoningEffort =
          typeof entry?.reasoningEffort === "string"
            ? entry.reasoningEffort
            : typeof entry?.effort === "string"
              ? entry.effort
              : null;
        return reasoningEffort
          ? [
              {
                reasoningEffort,
                ...(typeof entry?.description === "string"
                  ? { description: entry.description }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    id: String(model.id ?? model.model ?? ""),
    model: String(model.model ?? model.id ?? ""),
    displayName:
      typeof model.displayName === "string"
        ? model.displayName
        : String(model.model ?? model.id ?? ""),
    description: typeof model.description === "string" ? model.description : "",
    hidden: model.hidden === true,
    isDefault: model.isDefault === true,
    defaultReasoningEffort:
      typeof model.defaultReasoningEffort === "string"
        ? model.defaultReasoningEffort
        : null,
    supportedReasoningEfforts: efforts,
  };
}

function flattenSkills(result: SkillsListResult): SkillOption[] {
  return (result.data ?? []).flatMap((entry) => {
    const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
    return (entry.skills ?? []).map((skill) => ({
      cwd,
      name: String(skill.name ?? ""),
      description:
        typeof skill.description === "string" ? skill.description : "",
      ...(typeof skill.shortDescription === "string"
        ? { shortDescription: skill.shortDescription }
        : {}),
      path: typeof skill.path === "string" ? skill.path : "",
      scope: skill.scope ?? null,
      enabled: skill.enabled !== false,
    }));
  });
}

function isApprovalMethod(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ].includes(method);
}

function normalizeApprovalDecision(value: unknown): ApprovalDecision | null {
  if (
    ["accept", "acceptForSession", "decline", "cancel"].includes(String(value))
  ) {
    return value as ApprovalDecision;
  }
  const decision = asRecord(value);
  const execpolicy = asRecord(decision?.acceptWithExecpolicyAmendment);
  if (execpolicy && "execpolicy_amendment" in execpolicy) {
    return {
      kind: "acceptWithExecpolicyAmendment",
      execpolicyAmendment: execpolicy.execpolicy_amendment,
    };
  }
  const network = asRecord(decision?.applyNetworkPolicyAmendment);
  if (network && "network_policy_amendment" in network) {
    return {
      kind: "applyNetworkPolicyAmendment",
      networkPolicyAmendment: network.network_policy_amendment,
    };
  }
  return null;
}

function normalizeApproval(
  message: RpcEnvelope,
  diff?: string,
): ApprovalRequest {
  const params = message.params ?? {};
  const command =
    typeof params.command === "string"
      ? params.command
      : Array.isArray(params.command)
        ? params.command.map(String).join(" ")
        : undefined;
  const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  const isFileChange =
    message.method.includes("fileChange") ||
    message.method === "applyPatchApproval";
  const isPermissions = message.method === "item/permissions/requestApproval";
  const rawDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.flatMap((value) => {
        const normalized = normalizeApprovalDecision(value);
        return normalized ? [normalized] : [];
      })
    : undefined;

  return {
    requestId: message.id,
    method: message.method,
    threadId:
      typeof params.threadId === "string"
        ? params.threadId
        : typeof params.conversationId === "string"
          ? params.conversationId
          : undefined,
    turnId: typeof params.turnId === "string" ? params.turnId : undefined,
    itemId:
      typeof params.itemId === "string"
        ? params.itemId
        : typeof params.callId === "string"
          ? params.callId
          : undefined,
    title: isPermissions
      ? "允许额外权限？"
      : isFileChange
        ? "允许修改文件？"
        : "允许执行命令？",
    detail:
      diff ??
      command ??
      reason ??
      (isPermissions
        ? JSON.stringify(params.permissions ?? {}, null, 2)
        : undefined),
    command,
    cwd,
    reason,
    availableDecisions: rawDecisions?.length
      ? rawDecisions
      : ["accept", "acceptForSession", "decline"],
    raw: params,
  };
}

function permissionSettings(
  mode:
    "auto" | "granular" | "read-only" | "guardian-approvals" | "full-access",
  cwd?: string,
): Record<string, unknown> {
  if (mode === "full-access")
    return {
      activePermissionProfile: { id: ":danger-full-access", extends: null },
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  if (mode === "read-only")
    return {
      activePermissionProfile: { id: ":read-only", extends: null },
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  if (!cwd || !cwd.startsWith("/"))
    throw new Error(
      "A verified task working directory is required for workspace permissions.",
    );
  return {
    activePermissionProfile: { id: ":workspace", extends: null },
    approvalPolicy:
      mode === "granular"
        ? {
            granular: {
              sandbox_approval: false,
              rules: false,
              skill_approval: false,
              request_permissions: true,
              mcp_elicitations: false,
            },
          }
        : "on-request",
    approvalsReviewer:
      mode === "guardian-approvals" ? "guardian_subagent" : "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
    },
  };
}

function approvalResult(
  method: string,
  decision: ApprovalDecision,
  params?: Record<string, unknown>,
): unknown {
  if (method === "item/permissions/requestApproval") {
    const requested = asRecord(params?.permissions) ?? {};
    const accepted = decision === "accept" || decision === "acceptForSession";
    const permissions = accepted
      ? Object.fromEntries(
          Object.entries(requested).filter(([, value]) => value != null),
        )
      : {};
    return {
      permissions,
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    if (typeof decision === "object") {
      return {
        decision:
          decision.kind === "acceptWithExecpolicyAmendment"
            ? {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: decision.execpolicyAmendment,
                },
              }
            : {
                applyNetworkPolicyAmendment: {
                  network_policy_amendment: decision.networkPolicyAmendment,
                },
              },
      };
    }
    return { decision };
  }
  const legacyDecision: string =
    decision === "accept"
      ? "approved"
      : decision === "acceptForSession"
        ? "approved_for_session"
        : decision === "decline"
          ? "denied"
          : "abort";
  return { decision: legacyDecision };
}
