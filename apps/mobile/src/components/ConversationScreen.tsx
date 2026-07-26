import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision, ApprovalRequest, CompactionStatus, ConnectionPhase, GitDiffSnapshot, ModelOption, PermissionMode, PromptDeliveryMode, PromptQueueItem, RemoteMessage, RemoteThread, SkillOption } from '../types/protocol';
import { ApprovalCard } from './ApprovalCard';
import { CompactionStatusBar } from './CompactionStatusBar';
import { Composer } from './Composer';
import { ConnectionStatus } from './ConnectionStatus';
import { ConversationContextPanel, isContextMessage, latestReasoning } from './ConversationContextPanel';
import { ArrowLeftIcon } from './Icons';
import { MessageBubble } from './MessageBubble';
import { GitDiffPanel } from './GitDiffPanel';
import { PromptQueuePanel } from './PromptQueuePanel';
import { TransientActivity } from './TransientActivity';
import { ElapsedTime } from './ElapsedTime';

interface ConversationScreenProps {
  thread: RemoteThread;
  messages: RemoteMessage[];
  subagents: RemoteThread[];
  approvals: ApprovalRequest[];
  compaction: CompactionStatus | null;
  promptQueue: PromptQueueItem[];
  gitDiff: GitDiffSnapshot | null;
  models: ModelOption[];
  skills: SkillOption[];
  selectedModel: string;
  selectedEffort: string;
  selectedPermissionMode: PermissionMode;
  phase: ConnectionPhase;
  phaseDetail: string;
  running: boolean;
  canInterrupt: boolean;
  currentTurnId?: string;
  historyHasMore: boolean;
  historyLoading: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onBack: () => void;
  onLoadOlderHistory: () => void;
  onReconnect: () => void;
  onSend: (content: string, files: File[] | undefined, deliveryMode: PromptDeliveryMode) => Promise<boolean> | boolean;
  onCancelQueuedPrompt: (itemId: string) => void;
  onPromoteQueuedPrompt: (itemId: string) => void;
  onResumePromptQueue: () => void;
  onRefreshGitDiff: () => void;
  onInterrupt: () => void;
  onSelectModel: (model: string) => void;
  onSelectEffort: (effort: string) => void;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  onResolveApproval: (approvalId: string, decision: ApprovalDecision) => void;
  onDismissCompaction: () => void;
  onOpenThread: (threadId: string) => void;
  onLoadAttachment: (path: string) => Promise<{ url: string; fileName: string; mimeType: string; size: number }>;
  onDownloadAttachment: (path: string) => void;
}


type AgentTarget = { id: string; label: string; state: string };

type UnknownRecord = Record<string, unknown>;
function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

const EMPTY_AGENT_TARGETS: AgentTarget[] = [];
const agentTargetsByMessage = new WeakMap<RemoteMessage, AgentTarget[]>();

function terminalRank(state: string): number {
  const normalized = state.toLowerCase();
  if (/fail|failed|error|errored|cancel|interrupt|shutdown|notfound/.test(normalized)) return 3;
  if (/complete|completed|idle/.test(normalized)) return 2;
  return 1;
}

function mergeAgentTarget(agents: Map<string, AgentTarget>, next: AgentTarget): void {
  const current = agents.get(next.id);
  if (current && terminalRank(current.state) >= terminalRank(next.state)) {
    agents.set(next.id, { ...current, label: current.label !== next.id.slice(0, 8) ? current.label : next.label });
    return;
  }
  agents.set(next.id, { ...next, label: current?.label && current.label !== next.id.slice(0, 8) ? current.label : next.label });
}

export function subagentsFromMessage(message: RemoteMessage): AgentTarget[] {
  const cached = agentTargetsByMessage.get(message);
  if (cached) return cached;
  const type = message.itemType?.toLowerCase() ?? '';
  const name = message.toolName?.toLowerCase() ?? '';
  if (!type.includes('collabagent') && !type.includes('subagent') && !name.includes('subagent')) {
    agentTargetsByMessage.set(message, EMPTY_AGENT_TARGETS);
    return EMPTY_AGENT_TARGETS;
  }

  const agents = new Map<string, AgentTarget>();
  const detail = record(message.detail);
  const states = record(detail?.agentsStates) ?? record(record(detail?.item)?.agentsStates);
  if (states) {
    for (const [id, value] of Object.entries(states)) {
      const agent = record(value);
      mergeAgentTarget(agents, { id, label: String(agent?.nickname ?? agent?.name ?? id.slice(0, 8)), state: String(agent?.status ?? 'active') });
    }
  }
  const receiverIds = detail?.receiverThreadIds ?? record(detail?.item)?.receiverThreadIds;
  if (Array.isArray(receiverIds)) for (const value of receiverIds) {
    const id = String(value);
    if (!agents.has(id)) mergeAgentTarget(agents, { id, label: id.slice(0, 8), state: message.status === 'streaming' ? 'active' : 'unknown' });
  }

  // Compact mobile caches intentionally drop bulky raw event details. Recover stable
  // thread IDs from collaboration text after a restart or Desktop snapshot replace.
  const lines = message.content.split('\n');
  const ids = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const isActivity = type.includes('subagentactivity') || name === 'subagent 活动';
    const isBareActivityId = isActivity && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
    if (!trimmed.startsWith('Agent:') && !/^[0-9a-f]{8}-[0-9a-f-]{27}:\s/i.test(trimmed) && !isBareActivityId) continue;
    for (const match of trimmed.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) ids.add(match[0]!);
  }
  for (const id of ids) {
    const stateLine = lines.find((line) => line.trimStart().startsWith(`${id}:`));
    const state = stateLine?.slice(stateLine.indexOf(':') + 1).split('—')[0]?.trim();
    mergeAgentTarget(agents, { id, label: id.slice(0, 8), state: state || (message.status === 'streaming' ? 'active' : 'unknown') });
  }
  const result = agents.size > 0 ? [...agents.values()] : EMPTY_AGENT_TARGETS;
  agentTargetsByMessage.set(message, result);
  return result;
}

export function subagentsFromMessages(messages: RemoteMessage[]): AgentTarget[] {
  const agents = new Map<string, AgentTarget>();
  for (const message of messages) for (const agent of subagentsFromMessage(message)) mergeAgentTarget(agents, agent);
  return agents.size > 0 ? [...agents.values()] : EMPTY_AGENT_TARGETS;
}

export function agentStatePresentation(state: string): { className: string; label: string } {
  const normalized = state.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (/complete|completed|idle/.test(normalized)) return { className: 'complete', label: '完成' };
  if (/fail|failed|error|errored|notfound/.test(normalized)) return { className: 'failed', label: '失败' };
  if (/interrupt|cancel|shutdown/.test(normalized)) return { className: 'stopped', label: '已停止' };
  if (/waiting[_-]?approval/.test(normalized)) return { className: 'waiting', label: '待审批' };
  if (/waiting[_-]?(input|user)/.test(normalized)) return { className: 'waiting', label: '待输入' };
  if (/not[_-]?loaded/.test(normalized)) return { className: 'not-loaded', label: '未载入' };
  if (/unknown/.test(normalized)) return { className: 'unknown', label: '待同步' };
  return { className: 'active', label: '进行中' };
}

const BOTTOM_FOLLOW_DISTANCE = 96;


function nearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_FOLLOW_DISTANCE;
}

export type ConversationEntry =
  | { type: 'message'; message: RemoteMessage; agentTargets: AgentTarget[] }
  | { type: 'tool-group'; id: string; messages: RemoteMessage[]; agentTargets: AgentTarget[]; agentTargetsByMessage: Record<string, AgentTarget[]> };

export function groupConsecutiveToolMessages(messages: RemoteMessage[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  let pending: RemoteMessage[] = [];
  const messageEntry = (message: RemoteMessage): ConversationEntry => ({
    type: 'message', message, agentTargets: subagentsFromMessage(message),
  });
  const flush = () => {
    if (pending.length === 1) entries.push(messageEntry(pending[0]!));
    else if (pending.length > 1) {
      const targetsByMessage: Record<string, AgentTarget[]> = {};
      const targets = new Map<string, AgentTarget>();
      for (const message of pending) {
        const messageTargets = subagentsFromMessage(message);
        targetsByMessage[message.id] = messageTargets;
        for (const target of messageTargets) mergeAgentTarget(targets, target);
      }
      entries.push({
        type: 'tool-group', id: `tools:${pending[0]!.id}`, messages: pending,
        agentTargets: targets.size > 0 ? [...targets.values()] : EMPTY_AGENT_TARGETS,
        agentTargetsByMessage: targetsByMessage,
      });
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') pending.push(message);
    else { flush(); entries.push(messageEntry(message)); }
  }
  flush();
  return entries;
}

export function subagentsFromConversationEntries(entries: ConversationEntry[]): AgentTarget[] {
  const agents = new Map<string, AgentTarget>();
  for (const entry of entries) for (const agent of entry.agentTargets) mergeAgentTarget(agents, agent);
  return agents.size > 0 ? [...agents.values()] : EMPTY_AGENT_TARGETS;
}

export const DEFAULT_RENDERED_ENTRY_LIMIT = 80;
export const RENDERED_ENTRY_CHUNK = 80;

export function conversationEntryWindow(entries: ConversationEntry[], limit: number, end = entries.length): {
  entries: ConversationEntry[];
  hiddenCount: number;
  hiddenAfter: number;
  start: number;
  end: number;
} {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeEnd = Math.max(0, Math.min(entries.length, Math.floor(end)));
  const start = Math.max(0, safeEnd - safeLimit);
  return {
    entries: start === 0 && safeEnd === entries.length ? entries : entries.slice(start, safeEnd),
    hiddenCount: start,
    hiddenAfter: entries.length - safeEnd,
    start,
    end: safeEnd,
  };
}

const messageRevisionIds = new WeakMap<RemoteMessage, number>();
let nextMessageRevisionId = 1;
function messageRevisionId(message: RemoteMessage): number {
  const cached = messageRevisionIds.get(message);
  if (cached) return cached;
  const revision = nextMessageRevisionId++;
  messageRevisionIds.set(message, revision);
  return revision;
}

export function visibleConversationContentKey(
  entries: ConversationEntry[],
  expandedToolGroupIds: ReadonlySet<string>,
  approvals: ApprovalRequest[],
): string {
  const entryKey = entries.map((entry) => {
    if (entry.type === 'message') {
      const { message } = entry;
      return `message:${message.id}:${messageRevisionId(message)}:${message.status}:${message.content.length}`;
    }
    if (!expandedToolGroupIds.has(entry.id)) return `tool-group:${entry.id}:closed`;
    return `tool-group:${entry.id}:open:${entry.messages.map((message) => (
      `${message.id}:${messageRevisionId(message)}:${message.status}:${message.content.length}`
    )).join('|')}`;
  }).join('|');
  const approvalKey = approvals.map((approval) => `${approval.id}:${approval.description?.length ?? 0}:${approval.command?.length ?? 0}`).join('|');
  return `${entryKey}::${approvalKey}`;
}

export function ConversationScreen({ thread, messages, subagents: threadSubagents, approvals, compaction, promptQueue, gitDiff, models, skills, selectedModel, selectedEffort, selectedPermissionMode, phase, phaseDetail, running, canInterrupt, currentTurnId, historyHasMore, historyLoading, selectedAgentId, onSelectAgent, onBack, onLoadOlderHistory, onReconnect, onSend, onCancelQueuedPrompt, onPromoteQueuedPrompt, onResumePromptQueue, onRefreshGitDiff, onInterrupt, onSelectModel, onSelectEffort, onSelectPermissionMode, onResolveApproval, onDismissCompaction, onOpenThread, onLoadAttachment, onDownloadAttachment }: ConversationScreenProps) {
  const streamRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const initializedRef = useRef(false);
  const previousContentKeyRef = useRef('');
  const historyAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const suppressNextContentNotificationRef = useRef(false);
  const followScrollFrameRef = useRef<number | null>(null);
  const previousEntryCountRef = useRef(0);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [renderedEntryLimit, setRenderedEntryLimit] = useState(DEFAULT_RENDERED_ENTRY_LIMIT);
  const [frozenEntryEnd, setFrozenEntryEnd] = useState<number | null>(null);
  const [expandedToolGroupIds, setExpandedToolGroupIds] = useState<Set<string>>(() => new Set());

  const visibleMessages = useMemo(() => messages.filter((message) => !isContextMessage(message)), [messages]);
  const reasoning = useMemo(() => latestReasoning(messages, currentTurnId), [currentTurnId, messages]);
  const conversationEntries = useMemo(() => groupConsecutiveToolMessages(visibleMessages), [visibleMessages]);
  const historyEntryGrowth = historyAnchorRef.current
    ? Math.max(0, conversationEntries.length - previousEntryCountRef.current)
    : 0;
  const effectiveRenderedEntryLimit = renderedEntryLimit + historyEntryGrowth;
  const effectiveFrozenEntryEnd = frozenEntryEnd == null ? null : frozenEntryEnd + historyEntryGrowth;
  const renderedWindow = useMemo(
    () => conversationEntryWindow(
      conversationEntries,
      effectiveRenderedEntryLimit,
      effectiveFrozenEntryEnd ?? conversationEntries.length,
    ),
    [conversationEntries, effectiveFrozenEntryEnd, effectiveRenderedEntryLimit],
  );
  const parsedSubagents = useMemo(() => subagentsFromConversationEntries(conversationEntries), [conversationEntries]);
  const subagents = useMemo(() => {
    const combined = new Map<string, { id: string; label: string; state: string; thread?: RemoteThread }>();
    for (const agent of threadSubagents) {
      combined.set(agent.id, {
        id: agent.id,
        label: agent.agentNickname || agent.title || agent.id.slice(0, 8),
        state: agent.state === 'running' ? 'active' : agent.state === 'error' ? 'failed' : agent.state === 'idle' ? 'complete' : agent.state,
        thread: agent,
      });
    }
    for (const activity of parsedSubagents) {
      const existing = combined.get(activity.id);
      const activityTerminal = /complete|completed|fail|failed|error|errored|cancel|interrupt|shutdown|notfound/.test(activity.state.toLowerCase());
      const existingNeedsEvidence = existing?.state === 'not_loaded' || existing?.state === 'unknown';
      combined.set(activity.id, {
        ...activity,
        thread: existing?.thread,
        label: existing?.label || activity.label,
        state: !existing || (existingNeedsEvidence && activityTerminal) ? activity.state : existing.state,
      });
    }
    return [...combined.values()];
  }, [parsedSubagents, threadSubagents]);
  const displayedSubagents = agentsExpanded ? subagents : subagents.slice(0, 6);
  const hiddenSubagentCount = Math.max(0, subagents.length - displayedSubagents.length);
  const selectedAgent = subagents.find((agent) => agent.id === selectedAgentId) ?? null;

  const contentKey = useMemo(
    () => visibleConversationContentKey(renderedWindow.entries, expandedToolGroupIds, approvals),
    [approvals, expandedToolGroupIds, renderedWindow.entries],
  );

  useLayoutEffect(() => {
    previousEntryCountRef.current = conversationEntries.length;
    if (effectiveRenderedEntryLimit !== renderedEntryLimit) setRenderedEntryLimit(effectiveRenderedEntryLimit);
    if (effectiveFrozenEntryEnd !== frozenEntryEnd) setFrozenEntryEnd(effectiveFrozenEntryEnd);
  }, [conversationEntries.length, effectiveFrozenEntryEnd, effectiveRenderedEntryLimit, frozenEntryEnd, renderedEntryLimit]);

  useEffect(() => {
    if (renderedWindow.hiddenAfter > 0) setHasNewContent(true);
  }, [renderedWindow.hiddenAfter]);

  useLayoutEffect(() => {
    initializedRef.current = false;
    previousContentKeyRef.current = '';
    followingRef.current = true;
    setHasNewContent(false);
    setAgentsExpanded(false);
    setRenderedEntryLimit(DEFAULT_RENDERED_ENTRY_LIMIT);
    setFrozenEntryEnd(null);
    previousEntryCountRef.current = 0;
    setExpandedToolGroupIds(new Set());
    if (followScrollFrameRef.current != null) {
      window.cancelAnimationFrame(followScrollFrameRef.current);
      followScrollFrameRef.current = null;
    }
  }, [thread.id]);

  const scrollToBottom = () => {
    const stream = streamRef.current;
    if (!stream) return;
    if (followScrollFrameRef.current != null) {
      window.cancelAnimationFrame(followScrollFrameRef.current);
      followScrollFrameRef.current = null;
    }
    if (renderedEntryLimit !== DEFAULT_RENDERED_ENTRY_LIMIT) setRenderedEntryLimit(DEFAULT_RENDERED_ENTRY_LIMIT);
    if (frozenEntryEnd != null) setFrozenEntryEnd(null);
    stream.scrollTop = stream.scrollHeight;
    followingRef.current = true;
    setHasNewContent(false);
  };

  const scheduleFollowScroll = () => {
    if (followScrollFrameRef.current != null) return;
    followScrollFrameRef.current = window.requestAnimationFrame(() => {
      followScrollFrameRef.current = null;
      const stream = streamRef.current;
      if (!stream || !followingRef.current) return;
      stream.scrollTop = stream.scrollHeight;
    });
  };

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;

    const contentChanged = previousContentKeyRef.current !== contentKey;
    previousContentKeyRef.current = contentKey;
    const suppressNotification = suppressNextContentNotificationRef.current;
    suppressNextContentNotificationRef.current = false;
    const historyAnchor = historyAnchorRef.current;
    if (historyAnchor && !historyLoading) {
      stream.scrollTop = historyAnchor.top + (stream.scrollHeight - historyAnchor.height);
      historyAnchorRef.current = null;
      return;
    }

    if (!initializedRef.current) {
      initializedRef.current = true;
      scrollToBottom();
      return;
    }
    if (!contentChanged || suppressNotification) return;

    if (followingRef.current) {
      scheduleFollowScroll();
      setHasNewContent(false);
    } else {
      setHasNewContent(true);
    }
  }, [contentKey, historyLoading, renderedWindow.start]);

  useEffect(() => {
    const content = contentRef.current;
    const stream = streamRef.current;
    if (!content || !stream || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (followingRef.current) scheduleFollowScroll();
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (followScrollFrameRef.current != null) {
        window.cancelAnimationFrame(followScrollFrameRef.current);
        followScrollFrameRef.current = null;
      }
    };
  }, []);

  const activeModel = useMemo(
    () => models.find((model) => model.model === selectedModel || model.id === selectedModel),
    [models, selectedModel],
  );
  const effortOptions = activeModel?.supportedReasoningEfforts ?? [];

  return (
    <main className="app-screen conversation-screen">
      <header className="top-bar conversation-top-bar">
        <button className="back-button" type="button" onClick={onBack} aria-label="返回任务列表"><ArrowLeftIcon /></button>
        <div className="conversation-title">
          <h1>{thread.title}</h1>
          <p>{thread.cwd || thread.modelProvider || 'Codex 任务'}</p>
        </div>
        <ConnectionStatus phase={phase} detail={phaseDetail} onReconnect={onReconnect} />
      </header>

      <section className="session-toolbar" aria-label="任务设置">
        <label>
          <span>模型</span>
          <select value={selectedModel} onChange={(event) => onSelectModel(event.target.value)} disabled={phase !== 'connected'}>
            <option value="">主机默认</option>
            {models.filter((model) => !model.hidden).map((model) => <option key={model.id} value={model.model}>{model.displayName || model.model}</option>)}
          </select>
        </label>
        <label>
          <span>思考强度</span>
          <select value={selectedEffort} onChange={(event) => onSelectEffort(event.target.value)} disabled={phase !== 'connected' || effortOptions.length === 0}>
            <option value="">默认</option>
            {effortOptions.map((effort) => <option key={effort.reasoningEffort} value={effort.reasoningEffort}>{effort.reasoningEffort}</option>)}
          </select>
        </label>
        <label>
          <span>权限 / 审阅</span>
          <select value={selectedPermissionMode} onChange={(event) => onSelectPermissionMode(event.target.value as PermissionMode)} disabled={phase !== 'connected' || running}>
            <option value="auto">自动 · 工作区</option>
            <option value="granular">严格确认</option>
            <option value="read-only">严格审阅 · 只读</option>
            <option value="guardian-approvals">替我审阅</option>
            <option value="full-access">完全访问</option>
          </select>
        </label>
        <div className={`run-indicator ${running ? 'is-running' : ''}`}>
          <span />
          <strong>{running ? <>执行中{thread.currentTurnStartedAt && <> · <ElapsedTime startedAt={thread.currentTurnStartedAt} /></>}</> : thread.state === 'waiting_approval' ? '等待授权' : thread.state === 'waiting_input' ? '等待输入' : thread.state === 'error' ? '异常' : thread.state === 'idle' ? '可继续' : thread.state === 'not_loaded' ? '未载入' : '等待同步'}</strong>
        </div>
      </section>

      {subagents.length > 0 && (
        <nav className="agent-strip" aria-label="协作 Subagent">
          {displayedSubagents.map((agent, index) => {
            const presentation = agentStatePresentation(agent.state);
            return (
              <button
                className={`agent-chip agent-state-${presentation.className}`}
                key={agent.id}
                type="button"
                title={agent.id}
                onClick={() => onSelectAgent(agent.id)}
              >
                <i style={{ '--agent-hue': (index * 67 + 250) % 360 } as React.CSSProperties} />
                <strong>{agent.label}</strong>
                <small>{presentation.label}</small>
              </button>
            );
          })}
          {subagents.length > 6 && (
            <button className="agent-overflow-toggle" type="button" onClick={() => setAgentsExpanded((current) => !current)}>
              {agentsExpanded ? '收起' : `+${hiddenSubagentCount}`}
            </button>
          )}
        </nav>
      )}

      <div className="conversation-body">
        <section
          ref={streamRef}
          className="message-stream"
          aria-live="off"
          onScroll={(event) => {
            const wasFollowing = followingRef.current;
            const follows = nearBottom(event.currentTarget);
            followingRef.current = follows;
            if (!follows && wasFollowing) setFrozenEntryEnd(conversationEntries.length);
            if (follows) {
              setHasNewContent(false);
              if (!wasFollowing && (frozenEntryEnd != null || renderedEntryLimit > DEFAULT_RENDERED_ENTRY_LIMIT)) {
                setFrozenEntryEnd(null);
                setRenderedEntryLimit(DEFAULT_RENDERED_ENTRY_LIMIT);
                scheduleFollowScroll();
              }
            }
          }}
        >
          <div ref={contentRef} className="message-stream-content">
            {renderedWindow.hiddenCount > 0 && (
              <button
                className="history-load-button"
                type="button"
                onClick={() => {
                  const stream = streamRef.current;
                  if (stream) historyAnchorRef.current = { height: stream.scrollHeight, top: stream.scrollTop };
                  setRenderedEntryLimit((current) => current + RENDERED_ENTRY_CHUNK);
                }}
              >
                显示更早的已载入记录（{Math.min(RENDERED_ENTRY_CHUNK, renderedWindow.hiddenCount)} 条）
              </button>
            )}
            {(historyHasMore || historyLoading) && (
              <button
                className="history-load-button"
                type="button"
                disabled={historyLoading}
                onClick={() => {
                  const stream = streamRef.current;
                  if (stream) historyAnchorRef.current = { height: stream.scrollHeight, top: stream.scrollTop };
                  onLoadOlderHistory();
                }}
              >
                {historyLoading ? '正在载入更早记录…' : '载入更早记录'}
              </button>
            )}
            {visibleMessages.length === 0 && approvals.length === 0 && (
              <div className="conversation-empty">
                <img src="/logo.svg?v=4" alt="" />
                <h2>开始对话</h2>
                <p>输入指令，Codex 将在电脑上的当前任务中执行。输入 / 可查看手机命令。</p>
              </div>
            )}
            {renderedWindow.entries.map((entry) => entry.type === 'message' ? (
              <MessageBubble key={entry.message.id} message={entry.message} agentTargets={entry.agentTargets} onOpenAgent={onOpenThread} onLoadAttachment={onLoadAttachment} onDownloadAttachment={onDownloadAttachment} />
            ) : (
              <details
                className={`tool-call-group${entry.messages.some((message) => message.status === 'streaming') ? ' is-streaming' : ''}`}
                key={entry.id}
                open={expandedToolGroupIds.has(entry.id)}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setExpandedToolGroupIds((current) => {
                    if (current.has(entry.id) === open) return current;
                    suppressNextContentNotificationRef.current = true;
                    const next = new Set(current);
                    if (open) next.add(entry.id);
                    else next.delete(entry.id);
                    return next;
                  });
                }}
              >
                <summary>
                  <span className="tool-group-disclosure" aria-hidden="true">›</span>
                  <strong>工具调用 · {entry.messages.length}</strong>
                  <small>{entry.messages.map((message) => message.toolName || '工具').slice(0, 3).join('、')}{entry.messages.length > 3 ? '…' : ''}</small>
                  <span className="tool-group-summary-actions">
                    {entry.agentTargets.slice(0, 2).map((agent) => (
                      <button
                        className="tool-group-summary-agent"
                        key={agent.id}
                        type="button"
                        title={`打开 ${agent.label}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onOpenThread(agent.id);
                        }}
                      >
                        <span aria-hidden="true" />
                        {agent.label}
                      </button>
                    ))}
                    {entry.agentTargets.length > 2 && <span className="tool-group-agent-more">+{entry.agentTargets.length - 2}</span>}
                    <span className="tool-group-action">展开</span>
                  </span>
                </summary>
                {entry.agentTargets.length > 0 && (
                  <nav className="message-agent-links tool-group-agent-links" aria-label="此工具组关联的 Subagent">
                    {entry.agentTargets.map((agent) => (
                      <button key={agent.id} type="button" onClick={() => onOpenThread(agent.id)}>
                        <span aria-hidden="true" />
                        <strong>{agent.label}</strong>
                        <small>打开</small>
                      </button>
                    ))}
                  </nav>
                )}
                {expandedToolGroupIds.has(entry.id) && (
                  <div className="tool-call-group-items">
                    {entry.messages.map((message) => <MessageBubble key={message.id} message={message} agentTargets={entry.agentTargetsByMessage[message.id] ?? []} onOpenAgent={onOpenThread} onLoadAttachment={onLoadAttachment} onDownloadAttachment={onDownloadAttachment} />)}
                  </div>
                )}
              </details>
            ))}
            {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onResolve={onResolveApproval} />)}
          </div>
        </section>
        {hasNewContent && (
          <button className="new-content-button" type="button" onClick={scrollToBottom}>
            <span>有新内容</span>
            <strong>回到底部 ↓</strong>
          </button>
        )}
      </div>

      <TransientActivity running={running} content={reasoning?.content} startedAt={thread.currentTurnStartedAt} />
      <CompactionStatusBar status={compaction} onDismiss={onDismissCompaction} />
      <ConversationContextPanel key={thread.id} thread={thread} messages={messages} />
      <GitDiffPanel snapshot={gitDiff} onRefresh={onRefreshGitDiff} />
      <PromptQueuePanel items={promptQueue} onCancel={onCancelQueuedPrompt} onPromote={onPromoteQueuedPrompt} onResume={onResumePromptQueue} running={running} />
      <Composer connected={phase === 'connected'} running={running} canInterrupt={canInterrupt} models={models} skills={skills} onSend={onSend} onInterrupt={onInterrupt} />
      {selectedAgent && (
        <div className="agent-sheet-backdrop" role="presentation" onClick={() => onSelectAgent(null)}>
          <section className="agent-sheet" role="dialog" aria-modal="true" aria-label={`${selectedAgent.label} Subagent 详情`} onClick={(event) => event.stopPropagation()}>
            <div className="agent-sheet-handle" aria-hidden="true" />
            <header>
              <span className={`agent-detail-state agent-state-${agentStatePresentation(selectedAgent.state).className}`} />
              <div><strong>{selectedAgent.label}</strong><small>{agentStatePresentation(selectedAgent.state).label}</small></div>
              <button type="button" onClick={() => onSelectAgent(null)} aria-label="关闭 Subagent 详情">×</button>
            </header>
            <dl>
              {selectedAgent.thread?.agentRole && <><dt>角色</dt><dd>{selectedAgent.thread.agentRole}</dd></>}
              {selectedAgent.thread?.preview && <><dt>最近任务</dt><dd>{selectedAgent.thread.preview}</dd></>}
              {selectedAgent.thread?.model && <><dt>模型</dt><dd>{selectedAgent.thread.model}{selectedAgent.thread.effort ? ` · ${selectedAgent.thread.effort}` : ''}</dd></>}
              <dt>任务 ID</dt><dd><code>{selectedAgent.id}</code></dd>
            </dl>
            <button className="agent-open-thread" type="button" onClick={() => onOpenThread(selectedAgent.id)}>
              {selectedAgent.thread ? '打开 Subagent 任务' : '按任务 ID 直接打开'}
            </button>
            {!selectedAgent.thread && (
              <p className="agent-not-loaded">该 Subagent 尚未进入任务索引；客户端会使用活动记录中的任务 ID 直接向 Host 请求。</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
