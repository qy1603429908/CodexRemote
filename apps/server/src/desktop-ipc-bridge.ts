import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { createConnection, type Socket } from "node:net";

interface IpcFrame {
  type?: string;
  requestId?: string;
  method?: string;
  version?: number;
  sourceClientId?: string;
  targetClientIds?: string[] | null;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  resultType?: string;
  handledByClientId?: string;
  error?: unknown;
}

export interface DesktopConversation extends Record<string, unknown> {
  id?: string;
  hostId?: string;
  turns?: unknown[];
  requests?: unknown[];
  threadRuntimeStatus?: unknown;
}

interface FollowTarget {
  conversationId: string;
  hostId: string;
  ownerClientId?: string;
}

interface PendingRequest {
  method: string;
  ownerClientId: string;
  generation: number;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function conversationIsActive(conversation: DesktopConversation | null | undefined): boolean {
  if (!conversation) return false;
  const runtimeStatus = record(conversation.threadRuntimeStatus) ?? record(conversation.status);
  if (String(runtimeStatus?.type ?? "").toLowerCase() === "active") return true;
  const latestTurn = record(canonicalTurns(conversation).at(-1));
  return String(latestTurn?.status ?? "").toLowerCase().includes("progress");
}

export function activeConversationTurnId(conversation: DesktopConversation | null | undefined): string | null {
  if (!conversationIsActive(conversation)) return null;
  const latestTurn = record(canonicalTurns(conversation ?? {}).at(-1));
  return stringField(latestTurn?.id) ?? stringField(latestTurn?.turnId);
}

export function isExplicitInactiveSteerError(error: unknown): boolean {
  const text = errorText(error);
  return /SteerTurnInactiveError|active turn already ended|NoActiveTurn|no active turn|without an active turn id/i.test(
    text,
  );
}

export function isUncertainDesktopSubmissionError(error: unknown): boolean {
  const text = errorText(error);
  return /timed out|connection closed|socket.*closed|owner.*disconnected|not the active owner/i.test(
    text,
  );
}

const IPC_VERSION: Record<string, number> = {
  "thread-stream-state-changed": 11,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "ipc-connection-reset": 1,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-queued-followups-changed": 1,
  "thread-read-state-changed": 2,
  "thread-follower-start-turn": 1,
  "thread-follower-load-complete-history": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 3,
  "thread-follower-update-thread-settings": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-edit-last-user-turn": 2,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
};

export function defaultDesktopIpcEndpoint(
  platform: NodeJS.Platform = process.platform,
  homeDirectory = homedir(),
): string {
  return platform === "win32"
    ? "\\\\.\\pipe\\codex-ipc"
    : posix.join(homeDirectory, ".codex", "ipc", "ipc.sock");
}

export function isWindowsNamedPipeEndpoint(value: string): boolean {
  const prefix = "\\\\.\\pipe\\";
  if (!value.toLowerCase().startsWith(prefix)) return false;
  return /^[A-Za-z0-9._-]+$/.test(value.slice(prefix.length));
}

/**
 * Adapter for the desktop GUI's local Codex IPC router.
 *
 * The socket protocol is a 4-byte little-endian length followed by UTF-8 JSON.
 * Mobile joins the desktop-owned thread stream as a follower. History, turns,
 * settings, interrupts and approval decisions therefore pass through the same
 * owner that feeds the desktop GUI instead of opening a second app-server view.
 */
export class DesktopIpcBridge extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private clientId: string | null = null;
  private disposed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private initializeTimer: NodeJS.Timeout | null = null;
  private initializeRequestId: string | null = null;
  private connectionGeneration = 0;
  private readonly follows = new Map<string, FollowTarget>();
  private readonly conversations = new Map<string, DesktopConversation>();
  private readonly revisions = new Map<string, number>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly followWaiters = new Map<
    string,
    Set<(conversation: DesktopConversation | null) => void>
  >();
  private readonly pendingRequests = new Map<string, PendingRequest>();

  constructor(
    private readonly enabled: boolean,
    private readonly socketPath = defaultDesktopIpcEndpoint(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    super();
  }

  get ready(): boolean {
    return this.clientId !== null && this.socket?.writable === true;
  }

  get supported(): boolean {
    return this.enabled && !this.disposed;
  }

  async start(): Promise<void> {
    if (!this.supported) return;
    if (!(await this.isSafeSocket())) {
      this.emit(
        "unavailable",
        new Error(
          "Desktop Codex IPC endpoint is unavailable or failed its local security check.",
        ),
      );
      this.scheduleReconnect();
      return;
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.initializeTimer) clearTimeout(this.initializeTimer);
    this.initializeTimer = null;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.rejectPending(new Error("Desktop IPC bridge stopped."));
    this.resolveAllFollowWaiters(null);
    this.socket?.destroy();
    this.socket = null;
    this.clientId = null;
  }

  getConversation(id: string): DesktopConversation | null {
    return this.conversations.get(id) ?? null;
  }

  hasOwner(id: string): boolean {
    return Boolean(this.follows.get(id)?.ownerClientId);
  }

  async openConversation(
    conversationId: string,
    hostId = "local",
    timeoutMs = 2_500,
    loadCompleteHistory = true,
  ): Promise<DesktopConversation | null> {
    const conversation = await this.followConversation(
      conversationId,
      hostId,
      timeoutMs,
    );
    if (!conversation) return null;
    if (!loadCompleteHistory) return this.hasOwner(conversationId)
      ? (this.conversations.get(conversationId) ?? conversation)
      : null;
    try {
      const response = await this.requestFollower(
        conversationId,
        "thread-follower-load-complete-history",
        { conversationId },
        305_000,
      );
      const revision =
        numberField(response.revision) ??
        numberField(record(response.result)?.revision);
      if (revision != null)
        await this.waitForRevision(conversationId, revision, 10_000);
    } catch (error) {
      this.emit("diagnostic", error);
      return null;
    }
    return this.hasOwner(conversationId)
      ? (this.conversations.get(conversationId) ?? conversation)
      : null;
  }

  async startTurn(
    conversationId: string,
    turnStartParams: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.requestFollower(
      conversationId,
      "thread-follower-start-turn",
      {
        conversationId,
        turnStartParams: {
          ...turnStartParams,
          clientUserMessageId:
            typeof turnStartParams.clientUserMessageId === "string"
              ? turnStartParams.clientUserMessageId
              : randomUUID(),
        },
      },
      120_000,
    );
    return result.result ?? result;
  }

  async steerTurn(
    conversationId: string,
    turnStartParams: Record<string, unknown>,
  ): Promise<unknown> {
    const clientUserMessageId =
      typeof turnStartParams.clientUserMessageId === "string"
        ? turnStartParams.clientUserMessageId
        : randomUUID();
    const input = Array.isArray(turnStartParams.input)
      ? turnStartParams.input
      : [];
    const text = input
      .map((value) => {
        const item = record(value);
        return item?.type === "text" && typeof item.text === "string"
          ? item.text
          : "";
      })
      .filter(Boolean)
      .join("\n");
    const conversation = this.conversations.get(conversationId);
    const cwd = typeof conversation?.cwd === "string" ? conversation.cwd : "";
    const restoreMessage = {
      id: randomUUID(),
      text,
      context: {
        prompt: text,
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments: [],
        workspaceRoots: cwd ? [cwd] : [],
      },
      cwd,
      createdAt: Date.now(),
    };
    const result = await this.requestFollower(
      conversationId,
      "thread-follower-steer-turn",
      {
        conversationId,
        clientUserMessageId,
        input,
        serviceTier: turnStartParams.serviceTier ?? null,
        attachments: [],
        additionalContext: null,
        restoreMessage,
      },
      120_000,
    );
    return result.result ?? result;
  }

  async updateThreadSettings(
    conversationId: string,
    threadSettings: Record<string, unknown>,
  ): Promise<void> {
    await this.requestFollower(
      conversationId,
      "thread-follower-update-thread-settings",
      { conversationId, threadSettings },
    );
  }

  async compactThread(conversationId: string): Promise<void> {
    await this.requestFollower(
      conversationId,
      "thread-follower-compact-thread",
      { conversationId },
      120_000,
    );
  }

  async interruptTurn(
    conversationId: string,
    mode: "user" | "system" = "user",
  ): Promise<unknown> {
    return this.requestFollower(
      conversationId,
      "thread-follower-interrupt-turn",
      { conversationId, mode },
    );
  }

  async resolveApproval(
    conversationId: string,
    method: string,
    requestId: string | number,
    result: unknown,
  ): Promise<void> {
    const payload = record(result) ?? {};
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      await this.requestFollower(
        conversationId,
        "thread-follower-command-approval-decision",
        {
          conversationId,
          requestId,
          decision: payload.decision,
        },
      );
      return;
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      await this.requestFollower(
        conversationId,
        "thread-follower-file-approval-decision",
        {
          conversationId,
          requestId,
          decision: payload.decision,
        },
      );
      return;
    }
    if (method === "item/permissions/requestApproval") {
      await this.requestFollower(
        conversationId,
        "thread-follower-permissions-request-approval-response",
        {
          conversationId,
          requestId,
          response: payload,
        },
      );
      return;
    }
    throw new Error(`Unsupported Desktop IPC approval method: ${method}`);
  }

  private async followConversation(
    conversationId: string,
    hostId: string,
    timeoutMs: number,
  ): Promise<DesktopConversation | null> {
    const current = this.conversations.get(conversationId);
    if (current && this.hasOwner(conversationId)) return current;
    this.follows.set(conversationId, {
      ...(this.follows.get(conversationId) ?? { conversationId, hostId }),
      conversationId,
      hostId,
    });
    return new Promise((resolve) => {
      const waiters = this.followWaiters.get(conversationId) ?? new Set();
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (conversation: DesktopConversation | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(finish);
        if (waiters.size === 0) this.followWaiters.delete(conversationId);
        resolve(conversation);
      };
      waiters.add(finish);
      this.followWaiters.set(conversationId, waiters);
      timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref();
      this.announceFollow(conversationId);
      const discovered = this.conversations.get(conversationId);
      if (discovered && this.hasOwner(conversationId)) finish(discovered);
    });
  }

  private async requestFollower(
    conversationId: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    let target = this.follows.get(conversationId);
    if (!target?.ownerClientId) {
      await this.followConversation(
        conversationId,
        target?.hostId ?? "local",
        Math.min(timeoutMs, 3_000),
      );
      target = this.follows.get(conversationId);
    }
    if (!this.clientId || !target?.ownerClientId)
      throw new Error("Desktop GUI is not the active owner of this task.");
    if (!this.socket?.writable)
      throw new Error("Desktop IPC connection closed.");
    const requestId = randomUUID();
    const ownerClientId = target.ownerClientId;
    const generation = this.connectionGeneration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Desktop IPC request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pendingRequests.set(requestId, {
        method,
        ownerClientId,
        generation,
        resolve,
        reject,
        timer,
      });
      this.write({
        type: "request",
        requestId,
        method,
        version: IPC_VERSION[method] ?? 0,
        sourceClientId: this.clientId,
        targetClientIds: [ownerClientId],
        params,
      });
    });
  }

  private async isSafeSocket(): Promise<boolean> {
    if (this.platform === "win32") return isWindowsNamedPipeEndpoint(this.socketPath);
    try {
      const stat = await lstat(this.socketPath);
      const uid = process.getuid?.();
      return (
        stat.isSocket() &&
        (uid == null || stat.uid === uid) &&
        (stat.mode & 0o077) === 0
      );
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.socket || this.disposed) return;
    this.reconnectTimer = null;
    this.buffer = Buffer.alloc(0);
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    this.connectionGeneration += 1;
    socket.on("connect", () => {
      if (this.initializeTimer) clearTimeout(this.initializeTimer);
      this.initializeTimer = setTimeout(() => {
        if (this.socket !== socket || this.clientId) return;
        this.emit("diagnostic", new Error("Desktop IPC initialize timed out."));
        socket.destroy();
      }, 10_000);
      this.initializeTimer.unref();
      const requestId = randomUUID();
      this.initializeRequestId = requestId;
      this.write({
        type: "request",
        requestId,
        method: "initialize",
        params: { clientType: "codex-mobile-remote" },
      });
    });
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.emit("diagnostic", error));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clientId = null;
      this.initializeRequestId = null;
      this.connectionGeneration += 1;
      this.buffer = Buffer.alloc(0);
      if (this.initializeTimer) clearTimeout(this.initializeTimer);
      this.initializeTimer = null;
      this.rejectPending(new Error("Desktop IPC connection closed."));
      this.resolveAllFollowWaiters(null);
      for (const target of this.follows.values()) delete target.ownerClientId;
      this.conversations.clear();
      this.revisions.clear();
      this.emit("offline");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.supported || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, 1_000);
    this.reconnectTimer.unref();
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > 256 * 1024 * 1024) {
        this.emit(
          "diagnostic",
          new Error(`Invalid Desktop IPC frame length: ${length}`),
        );
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        this.handleFrame(JSON.parse(body.toString("utf8")) as IpcFrame);
      } catch (error) {
        this.emit("diagnostic", error);
        this.socket?.destroy();
        return;
      }
    }
  }

  private handleFrame(frame: IpcFrame): void {
    if (
      frame.type === "response" &&
      frame.method === "initialize" &&
      frame.requestId === this.initializeRequestId &&
      typeof frame.result?.clientId === "string"
    ) {
      this.clientId = frame.result.clientId;
      this.initializeRequestId = null;
      if (this.initializeTimer) clearTimeout(this.initializeTimer);
      this.initializeTimer = null;
      this.requestFollowingStatus();
      for (const conversationId of this.follows.keys())
        this.announceFollow(conversationId);
      this.emit("ready");
      return;
    }
    if (frame.type === "response" && typeof frame.requestId === "string") {
      const pending = this.pendingRequests.get(frame.requestId);
      if (!pending) return;
      if (pending.generation !== this.connectionGeneration) return;
      if (frame.method && frame.method !== pending.method) return;
      if (frame.handledByClientId && frame.handledByClientId !== pending.ownerClientId) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(frame.requestId);
      if (frame.error != null || frame.resultType === "error" || frame.result?.resultType === "error") {
        pending.reject(
          new Error(
            errorText(
              frame.error ?? frame.result?.error ?? `${pending.method} failed`,
            ),
          ),
        );
      } else {
        pending.resolve(frame.result ?? {});
      }
      return;
    }
    if (
      frame.type === "client-discovery-request" &&
      typeof frame.requestId === "string"
    ) {
      this.write({
        type: "client-discovery-response",
        requestId: frame.requestId,
        response: { canHandle: false },
      });
      return;
    }
    if (frame.type !== "broadcast" || !frame.method || !frame.params) return;
    if (
      Array.isArray(frame.targetClientIds) &&
      (!this.clientId || !frame.targetClientIds.includes(this.clientId))
    )
      return;
    const expectedVersion = IPC_VERSION[frame.method];
    if (expectedVersion != null && (frame.version ?? 0) !== expectedVersion) {
      this.emit(
        "diagnostic",
        new Error(
          `Unsupported Desktop IPC ${frame.method} version ${frame.version ?? 0}; expected ${expectedVersion}.`,
        ),
      );
      return;
    }

    if (frame.method === "ipc-connection-reset") {
      this.connectionGeneration += 1;
      this.rejectPending(new Error("Desktop IPC connection reset."));
      for (const target of this.follows.values()) delete target.ownerClientId;
      this.conversations.clear();
      this.revisions.clear();
      this.emit("reset");
      for (const conversationId of this.follows.keys())
        this.announceFollow(conversationId);
      return;
    }

    if (frame.method === "thread-stream-following-status-requested") {
      const requestedConversationId = stringField(frame.params.conversationId);
      if (requestedConversationId) {
        const hostId = stringField(frame.params.hostId) ?? "local";
        this.follows.set(requestedConversationId, {
          ...(this.follows.get(requestedConversationId) ?? {
            conversationId: requestedConversationId,
            hostId,
          }),
          conversationId: requestedConversationId,
          hostId,
        });
        this.announceFollow(requestedConversationId, frame.sourceClientId);
      } else {
        for (const conversationId of this.follows.keys())
          this.announceFollow(conversationId, frame.sourceClientId);
      }
      return;
    }

    if (frame.method === "thread-archived") {
      this.emit("threadArchived", frame.params);
      return;
    }

    if (frame.method === "thread-unarchived") {
      this.emit("threadUnarchived", frame.params);
      return;
    }

    if (frame.method === "thread-queued-followups-changed") {
      const conversationId = stringField(frame.params.conversationId);
      const messages = Array.isArray(frame.params.messages) ? frame.params.messages : null;
      if (conversationId && messages) this.emit("queuedFollowUps", { conversationId, messages });
      return;
    }

    if (frame.method === "thread-stream-following-changed") {
      const conversationId = stringField(frame.params.conversationId);
      const hostId = stringField(frame.params.hostId) ?? "local";
      if (!conversationId || frame.sourceClientId === this.clientId) return;
      if (frame.params.following === true) {
        this.follows.set(conversationId, {
          ...(this.follows.get(conversationId) ?? { conversationId, hostId }),
          conversationId,
          hostId,
        });
        this.announceFollow(conversationId);
      } else if (frame.params.following === false) {
        const target = this.follows.get(conversationId);
        if (target && target.ownerClientId === frame.sourceClientId) {
          delete target.ownerClientId;
          this.conversations.delete(conversationId);
          this.revisions.delete(conversationId);
          this.emit("ownerLost", conversationId);
        }
      }
      return;
    }

    if (frame.method === "thread-stream-state-changed") {
      const conversationId = stringField(frame.params.conversationId);
      const hostId = stringField(frame.params.hostId) ?? "local";
      const change = record(frame.params.change);
      if (
        !conversationId ||
        !change ||
        typeof frame.sourceClientId !== "string"
      )
        return;
      if (change.type === "snapshot") {
        const conversation = record(change.conversationState);
        if (!conversation) return;
        const revision = numberField(change.revision);
        const currentRevision = this.revisions.get(conversationId);
        if (revision != null && currentRevision != null && revision < currentRevision) return;
        const existingTarget = this.follows.get(conversationId);
        if (!existingTarget) {
          this.emit(
            "diagnostic",
            new Error(`Desktop IPC ignored unsolicited snapshot for ${conversationId}.`),
          );
          return;
        }
        if (
          existingTarget.ownerClientId &&
          existingTarget.ownerClientId !== frame.sourceClientId
        ) {
          this.emit(
            "diagnostic",
            new Error(
              `Desktop IPC ignored owner replacement for ${conversationId}: ${existingTarget.ownerClientId} -> ${frame.sourceClientId}.`,
            ),
          );
          return;
        }
        existingTarget.ownerClientId = frame.sourceClientId;
        this.follows.set(conversationId, existingTarget);
        const normalized = normalizeDesktopConversation(
          conversationId,
          hostId,
          conversation,
        );
        this.conversations.set(conversationId, normalized);
        if (revision != null) {
          this.revisions.set(conversationId, revision);
          this.emit(`revision:${conversationId}`, revision);
        }
        this.resolveFollowWaiters(conversationId, normalized);
        this.emit("snapshot", normalized);
      } else if (change.type === "patches") {
        const target = this.follows.get(conversationId);
        if (target?.ownerClientId !== frame.sourceClientId) return;
        const baseRevision = numberField(change.baseRevision);
        const revision = numberField(change.revision);
        const currentRevision = this.revisions.get(conversationId);
        const current = this.conversations.get(conversationId);
        const patches = Array.isArray(change.patches) ? change.patches : null;
        if (revision != null && currentRevision != null && revision <= currentRevision) return;
        if (
          !current ||
          !patches ||
          baseRevision == null ||
          revision == null ||
          currentRevision == null ||
          baseRevision !== currentRevision
        ) {
          this.scheduleRefresh(conversationId);
          return;
        }
        try {
          const patched = applyDesktopPatches(current, patches);
          const normalized = normalizeDesktopConversation(
            conversationId,
            hostId,
            patched,
          );
          this.conversations.set(conversationId, normalized);
          this.revisions.set(conversationId, revision);
          this.emit(`revision:${conversationId}`, revision);
          this.emit("snapshot", normalized);
        } catch (error) {
          this.emit("diagnostic", error);
          this.scheduleRefresh(conversationId);
        }
      }
    }
  }

  private scheduleRefresh(conversationId: string): void {
    if (this.refreshTimers.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(conversationId);
      this.announceFollow(conversationId);
    }, 120);
    timer.unref();
    this.refreshTimers.set(conversationId, timer);
  }

  private waitForRevision(
    conversationId: string,
    revision: number,
    timeoutMs: number,
  ): Promise<void> {
    if ((this.revisions.get(conversationId) ?? -1) >= revision)
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const event = `revision:${conversationId}`;
      const onRevision = (current: number) => {
        if (current < revision) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Desktop IPC snapshot revision ${revision} timed out.`),
        );
      }, timeoutMs);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        this.off(event, onRevision);
      };
      this.on(event, onRevision);
      const current = this.revisions.get(conversationId);
      if (current != null) onRevision(current);
    });
  }


  private requestFollowingStatus(): void {
    if (!this.clientId) return;
    this.write({
      type: "broadcast",
      method: "thread-stream-following-status-requested",
      sourceClientId: this.clientId,
      targetClientIds: null,
      version: IPC_VERSION["thread-stream-following-status-requested"],
      params: {},
    });
  }

  private announceFollow(
    conversationId: string,
    requestedByClientId?: string,
  ): void {
    const target = this.follows.get(conversationId);
    if (!this.clientId || !target) return;
    this.write({
      type: "broadcast",
      method: "thread-stream-following-changed",
      sourceClientId: this.clientId,
      targetClientIds: requestedByClientId
        ? [requestedByClientId]
        : target.ownerClientId
          ? [target.ownerClientId]
          : null,
      version: IPC_VERSION["thread-stream-following-changed"],
      params: { conversationId, hostId: target.hostId, following: true },
    });
  }

  private resolveFollowWaiters(
    conversationId: string,
    conversation: DesktopConversation,
  ): void {
    const waiters = this.followWaiters.get(conversationId);
    if (!waiters) return;
    this.followWaiters.delete(conversationId);
    for (const resolve of waiters) resolve(conversation);
  }

  private resolveAllFollowWaiters(
    conversation: DesktopConversation | null,
  ): void {
    for (const waiters of this.followWaiters.values())
      for (const resolve of waiters) resolve(conversation);
    this.followWaiters.clear();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private write(frame: unknown): void {
    const socket = this.socket;
    if (!socket || !socket.writable) return;
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([header, body]));
  }
}

interface DesktopPatch {
  op?: unknown;
  path?: unknown;
  value?: unknown;
}

export function applyDesktopPatches(
  conversation: DesktopConversation,
  values: unknown[],
): Record<string, unknown> {
  const next = structuredClone(conversation) as Record<string, unknown>;
  for (const value of values) {
    const patch = record(value) as DesktopPatch | null;
    if (!patch || !Array.isArray(patch.path) || patch.path.length === 0)
      throw new Error("Desktop IPC patch path is invalid.");
    const path = patch.path as Array<string | number>;
    let parent: unknown = next;
    for (const segment of path.slice(0, -1))
      parent = patchChild(parent, segment);
    applyDesktopPatchOperation(parent, path.at(-1)!, String(patch.op ?? ""), patch.value);
  }
  return next;
}

function patchChild(parent: unknown, segment: string | number): unknown {
  if (Array.isArray(parent)) {
    const index = patchArrayIndex(segment, parent.length, false);
    const child = parent[index];
    if (child == null || typeof child !== "object")
      throw new Error("Desktop IPC patch traversed a missing array value.");
    return child;
  }
  const object = record(parent);
  if (!object) throw new Error("Desktop IPC patch traversed a non-object value.");
  const child = object[String(segment)];
  if (child == null || typeof child !== "object")
    throw new Error("Desktop IPC patch traversed a missing object value.");
  return child;
}

function applyDesktopPatchOperation(
  parent: unknown,
  segment: string | number,
  operation: string,
  value: unknown,
): void {
  if (!['add', 'replace', 'remove'].includes(operation))
    throw new Error(`Unsupported Desktop IPC patch operation: ${operation}`);
  if (Array.isArray(parent)) {
    const index = patchArrayIndex(segment, parent.length, operation === "add");
    if (operation === "add") parent.splice(index, 0, value);
    else if (operation === "replace") parent[index] = value;
    else parent.splice(index, 1);
    return;
  }
  const object = record(parent);
  if (!object) throw new Error("Desktop IPC patch parent is not an object.");
  const key = String(segment);
  if (operation === "remove") delete object[key];
  else object[key] = value;
}

function patchArrayIndex(
  segment: string | number,
  length: number,
  allowEnd: boolean,
): number {
  if (allowEnd && segment === "-") return length;
  const index = typeof segment === "number" ? segment : Number(segment);
  const maximum = allowEnd ? length : length - 1;
  if (!Number.isInteger(index) || index < 0 || index > maximum)
    throw new Error(`Desktop IPC patch array index is invalid: ${String(segment)}`);
  return index;
}

export function normalizeDesktopConversation(
  conversationId: string,
  hostId: string,
  conversation: Record<string, unknown>,
): DesktopConversation {
  const existingSource = record(conversation.source);
  const originalSource = existingSource?.desktopIpc === true
    && Object.prototype.hasOwnProperty.call(existingSource, "original")
    ? existingSource.original
    : conversation.source ?? null;
  return {
    ...conversation,
    id: stringField(conversation.id) ?? conversationId,
    hostId,
    turns: canonicalTurns(conversation),
    status: conversation.threadRuntimeStatus ?? { type: "notLoaded" },
    source: { desktopIpc: true, original: originalSource },
  };
}

export function canonicalTurns(
  conversation: Record<string, unknown>,
): unknown[] {
  const legacy = Array.isArray(conversation.turns) ? conversation.turns : [];
  const turnHistory = record(conversation.turnHistory);
  const history = record(turnHistory?.history);
  const entities = record(history?.entitiesByKey);
  const islands = Array.isArray(history?.islands) ? history.islands : [];
  if (!entities || islands.length === 0) return legacy;

  const turns: unknown[] = [];
  const seenKeys = new Set<string>();
  const seenTurns = new Set<string>();
  const append = (value: unknown) => {
    const entity = record(value);
    if (!entity || !Array.isArray(entity.items)) return;
    const identity = stringField(entity.id) ?? stringField(entity.turnId);
    if (identity && seenTurns.has(identity)) return;
    if (identity) seenTurns.add(identity);
    turns.push(value);
  };

  for (const islandValue of islands) {
    const island = record(islandValue);
    const entries = Array.isArray(island?.entries) ? island.entries : [];
    for (const entryValue of entries) {
      const entry = record(entryValue);
      const key = stringField(entry?.value) ?? stringField(entry?.key);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      append(entities[key]);
    }
  }

  // Desktop may expose the live tail in `turns` before it lands in canonical
  // history. Keep canonical order, then append only genuinely new live turns.
  for (const turn of legacy) append(turn);
  return turns.length > 0 ? turns : legacy;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  const value = record(error);
  if (value) {
    const nested = value.error ?? value.message ?? value.detail ?? value.code;
    if (nested !== undefined && nested !== error) return errorText(nested);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(error);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
