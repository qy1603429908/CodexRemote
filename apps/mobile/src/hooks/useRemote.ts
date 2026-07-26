import { App as CapacitorApp } from '@capacitor/app';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteConfig } from '../lib/configStore';
import { RemoteSocket } from '../lib/RemoteSocket';
import { cancelApprovalNotification, cancelThreadAttentionNotification, notifyApprovalRequested, notifyCompactionFailed, notifyThreadAttention, notifyTurnFinished } from '../lib/notifications';
import { downloadHostFile, saveHostFile, uploadRemoteFile } from '../lib/fileTransfer';
import { NotificationGenerationGuard, NotificationOperationQueue, settleGuardedNotification } from '../lib/notificationGuard';
import { cacheScope, clearRemoteCache, loadRemoteCache, messagesForThread, saveRemoteCache, type CachedHistoryState, type RemoteCacheSnapshot } from '../lib/remoteCache';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CompactionStatus,
  ConnectionPhase,
  ModelOption,
  RemoteMessage,
  RemoteAttachment,
  RemoteThread,
  ServerMessage,
  PromptDeliveryMode,
  PromptQueueItem,
  GitDiffSnapshot,
  SkillOption,
  ThreadState,
  PermissionMode,
  ThreadSummary,
  WireApprovalRequest,
} from '../types/protocol';
import { createRequestId } from '../types/protocol';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function explicitThreadOwner(value: unknown): string | undefined {
  const data = record(value);
  return stringValue(data?.threadId, data?.conversationId, data?.ownerThreadId, data?.ownerConversationId);
}


export function visibleUserText(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  const injectedPrefix = /<in-app-browser-context\b/i.test(normalized)
    || /(?:^|\n)# Files mentioned by the user:\s*(?:\n|$)/i.test(normalized);
  if (injectedPrefix) {
    const marker = /(?:^|\n)#{1,3}\s+My request for Codex:\s*\n/gi;
    let match: RegExpExecArray | null = null;
    let latest: RegExpExecArray | null = null;
    while ((match = marker.exec(normalized))) latest = match;
    if (latest) return normalized.slice(latest.index + latest[0].length).trim();
  }
  return normalized
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/gi, '')
    .trim();
}

function timestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function consumeThreadActivationIntent(
  pendingStartRequestIds: Set<string>,
  requestId: string | undefined,
): boolean {
  return Boolean(requestId && pendingStartRequestIds.delete(requestId));
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const copy = [...items];
  copy[index] = { ...copy[index], ...item };
  return copy;
}

function sortThreads(threads: RemoteThread[]): RemoteThread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function stateFromStatus(value: unknown): ThreadState {
  const statusRecord = record(value);
  const text = String(statusRecord?.type ?? statusRecord?.status ?? value ?? '').toLowerCase();
  const activeFlags = Array.isArray(statusRecord?.activeFlags) ? statusRecord.activeFlags.map(String) : [];
  if (activeFlags.includes('waitingOnApproval')) return 'waiting_approval';
  if (activeFlags.includes('waitingOnUserInput')) return 'waiting_input';
  if (text.includes('progress') || text.includes('running') || text.includes('active')) return 'running';
  if (text.includes('error') || text.includes('fail')) return 'error';
  if (text.includes('notloaded') || text.includes('not_loaded') || text.includes('unloaded')) return 'not_loaded';
  if (text.includes('idle') || text.includes('complete')) return 'idle';
  return 'unknown';
}

function subagentMetadataFromSource(sourceValue: unknown): { parentThreadId?: string; agentNickname?: string; agentRole?: string } {
  const source = record(sourceValue);
  const original = record(source?.original);
  const candidates = [source, original].filter((value): value is UnknownRecord => Boolean(value));
  for (const candidate of candidates) {
    const subagent = record(candidate.subAgent) ?? record(candidate.sub_agent) ?? record(candidate.subagent);
    const spawn = record(subagent?.thread_spawn) ?? record(subagent?.threadSpawn) ?? subagent;
    const parentThreadId = stringValue(spawn?.parent_thread_id, spawn?.parentThreadId, subagent?.parent_thread_id, subagent?.parentThreadId);
    const agentNickname = stringValue(spawn?.agent_nickname, spawn?.agentNickname, subagent?.agent_nickname, subagent?.agentNickname);
    const agentRole = stringValue(spawn?.agent_role, spawn?.agentRole, subagent?.agent_role, subagent?.agentRole);
    if (parentThreadId || agentNickname || agentRole) return { parentThreadId, agentNickname, agentRole };
  }
  return {};
}

function normalizeSummary(thread: ThreadSummary): RemoteThread {
  const sourceMetadata = subagentMetadataFromSource(thread.source);
  return {
    id: thread.id,
    title: visibleUserText(thread.name || thread.preview || '未命名任务'),
    preview: visibleUserText(thread.preview),
    cwd: thread.cwd,
    modelProvider: thread.modelProvider,
    updatedAt: timestamp(thread.updatedAt),
    state: stateFromStatus(thread.status),
    unread: 0,
    parentThreadId: thread.parentThreadId ?? sourceMetadata.parentThreadId ?? null,
    agentNickname: thread.agentNickname ?? sourceMetadata.agentNickname ?? null,
    agentRole: thread.agentRole ?? sourceMetadata.agentRole ?? null,
    source: thread.source,
  };
}

export function mergeThreadSummaries(current: RemoteThread[], incoming: ThreadSummary[], replace: boolean): RemoteThread[] {
  const previousById = new Map(current.map((thread) => [thread.id, thread]));
  const merged = incoming.map((thread) => {
    const summary = normalizeSummary(thread);
    const previous = previousById.get(summary.id);
    const keepObservedState = summary.state === 'not_loaded'
      && previous
      && previous.state !== 'not_loaded'
      && previous.state !== 'unknown';
    previousById.delete(summary.id);
    return {
      ...previous,
      ...summary,
      state: keepObservedState ? previous.state : summary.state,
      parentThreadId: summary.parentThreadId ?? previous?.parentThreadId ?? null,
      agentNickname: summary.agentNickname ?? previous?.agentNickname ?? null,
      agentRole: summary.agentRole ?? previous?.agentRole ?? null,
      unread: previous?.unread ?? 0,
      currentTurnStartedAt: previous?.currentTurnStartedAt,
      lastTurnDurationMs: previous?.lastTurnDurationMs,
      tokenUsage: previous?.tokenUsage,
      model: previous?.model,
      effort: previous?.effort,
      permissionMode: previous?.permissionMode,
    };
  });
  return sortThreads(replace ? merged : [...previousById.values(), ...merged]);
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join('\n');
  const data = record(value);
  if (!data) return '';
  return (
    stringValue(data.text, data.diff, data.content, data.output, data.message, data.delta, data.reason, data.path) ??
    (Array.isArray(data.content) ? textFromContent(data.content) : '')
  );
}

function canonicalUserText(item: UnknownRecord, restoreMessage: UnknownRecord | null): string {
  const restored = stringValue(restoreMessage?.text);
  if (restored) return visibleUserText(restored);
  const direct = stringValue(item.text, item.message);
  if (direct) return visibleUserText(direct);
  const source = item.input ?? item.content;
  if (!Array.isArray(source)) return visibleUserText(textFromContent(source));
  const textParts = source.flatMap((value) => {
    if (typeof value === 'string') return [value];
    const part = record(value);
    if (!part) return [];
    const type = String(part.type ?? '').toLowerCase();
    if (type && !type.includes('text') && !type.includes('prompt')) return [];
    const text = stringValue(part.text, part.content, part.message);
    return text ? [text] : [];
  });
  return visibleUserText(textParts.join('\n'));
}

function attachmentName(path: string, fallback = '附件'): string {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1);
  return name || fallback;
}

function attachmentType(type: unknown, path: string, mimeType?: string): 'image' | 'file' {
  const hint = `${String(type ?? '')} ${mimeType ?? ''} ${path}`.toLowerCase();
  return /image|\.(png|jpe?g|gif|webp|avif|heic)$/.test(hint) ? 'image' : 'file';
}

export function optimisticAttachmentsFromUploads(attachments: Array<{
  type: 'image' | 'file';
  fileName: string;
  mimeType: string;
  localPath?: string;
}>): RemoteAttachment[] {
  return attachments.flatMap((attachment) => attachment.localPath ? [{
    type: attachment.type,
    name: attachment.fileName,
    path: attachment.localPath,
    mimeType: attachment.mimeType,
  }] : []);
}

export function attachmentsFromCanonicalUserItem(itemValue: unknown): RemoteAttachment[] {
  const item = record(itemValue);
  if (!item) return [];
  const byPath = new Map<string, RemoteAttachment>();
  const add = (pathValue: unknown, nameValue?: unknown, typeValue?: unknown, mimeValue?: unknown) => {
    if (typeof pathValue !== 'string' || !pathValue.startsWith('/')) return;
    const mimeType = typeof mimeValue === 'string' ? mimeValue : undefined;
    byPath.set(pathValue, {
      type: attachmentType(typeValue, pathValue, mimeType),
      name: typeof nameValue === 'string' && nameValue.trim() ? nameValue : attachmentName(pathValue),
      path: pathValue,
      ...(mimeType ? { mimeType } : {}),
    });
  };
  for (const inputValue of Array.isArray(item.input) ? item.input : []) {
    const input = record(inputValue);
    add(input?.path, input?.name, input?.type, input?.mimeType);
  }
  for (const attachmentValue of Array.isArray(item.attachments) ? item.attachments : []) {
    const attachment = record(attachmentValue);
    add(attachment?.fsPath ?? attachment?.path, attachment?.label ?? attachment?.name, attachment?.type, attachment?.mimeType);
  }
  const restore = record(item.restoreMessage);
  const context = record(restore?.context);
  for (const key of ['imageAttachments', 'fileAttachments']) {
    for (const attachmentValue of Array.isArray(context?.[key]) ? context[key] as unknown[] : []) {
      const attachment = record(attachmentValue);
      add(attachment?.localPath ?? attachment?.fsPath ?? attachment?.path, attachment?.filename ?? attachment?.name, key, attachment?.mimeType);
    }
  }
  return [...byPath.values()];
}

function stableProjectedItemValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjectedItemValue);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => key !== 'id' && key !== 'itemId')
      .sort()
      .map((key) => [key, stableProjectedItemValue(object[key])]),
  );
}

function projectedItemFingerprint(value: unknown): string {
  return JSON.stringify(stableProjectedItemValue(value));
}

function projectedUserCorrelation(value: unknown): string | undefined {
  const item = record(value);
  const type = String(item?.type ?? '').toLowerCase();
  if (!type.includes('user')) return undefined;
  return stringValue(item?.clientUserMessageId, item?.clientId, item?.serverUserMessageId);
}

export function canonicalProjectedItems(items: unknown[]): unknown[] {
  const canonicalCounts = new Map<string, number>();
  const canonicalUserCorrelations = new Map<string, number>();
  for (const value of items) {
    const item = record(value);
    const id = stringValue(item?.id, item?.itemId);
    if (!id || /^item-\d+$/.test(id)) continue;
    const fingerprint = projectedItemFingerprint(value);
    canonicalCounts.set(fingerprint, (canonicalCounts.get(fingerprint) ?? 0) + 1);
    const correlation = projectedUserCorrelation(value);
    if (correlation) canonicalUserCorrelations.set(correlation, (canonicalUserCorrelations.get(correlation) ?? 0) + 1);
  }
  const remainingAliases = new Map(canonicalCounts);
  const remainingUserAliases = new Map(canonicalUserCorrelations);
  return items.filter((value) => {
    const item = record(value);
    const id = stringValue(item?.id, item?.itemId);
    if (!id || !/^item-\d+$/.test(id)) return true;
    const correlation = projectedUserCorrelation(value);
    const remainingCorrelation = correlation ? (remainingUserAliases.get(correlation) ?? 0) : 0;
    if (correlation && remainingCorrelation > 0) {
      remainingUserAliases.set(correlation, remainingCorrelation - 1);
      return false;
    }
    const fingerprint = projectedItemFingerprint(value);
    const remaining = remainingAliases.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    remainingAliases.set(fingerprint, remaining - 1);
    return false;
  });
}

export function itemToMessage(itemValue: unknown, threadId: string, turnId: string, index: number, fallbackCreatedAt = Date.now(), turnInProgress = false): RemoteMessage | null {
  const item = record(itemValue);
  if (!item) return null;
  const type = String(item.type ?? 'item');
  const id = stringValue(item.id, item.itemId) ?? `${turnId}_${index}`;
  const normalizedType = type.toLowerCase();
  const restoreMessage = record(item.restoreMessage);
  const attachments = normalizedType.includes('user') ? attachmentsFromCanonicalUserItem(item) : [];
  let role: RemoteMessage['role'] = 'tool';
  let content = '';
  let toolName: string | undefined;
  let collapsible = false;

  if (normalizedType.includes('user')) {
    role = 'user';
    content = canonicalUserText(item, restoreMessage);
  } else if (normalizedType.includes('agentmessage') || normalizedType.includes('assistant')) {
    role = 'assistant';
    content = textFromContent(item.text ?? item.content ?? item.message);
  } else if (normalizedType.includes('reasoning')) {
    role = 'system';
    toolName = '思考梗概';
    content = textFromContent(item.summary ?? item.text ?? item.content);
    collapsible = true;
  } else if (normalizedType.includes('command')) {
    toolName = '命令';
    const command = textFromContent(item.command);
    const output = textFromContent(item.aggregatedOutput ?? item.output);
    content = [command ? `$ ${command}` : '', output].filter(Boolean).join('\n');
    collapsible = true;
  } else if (normalizedType.includes('file')) {
    toolName = '文件修改';
    const changes = Array.isArray(item.changes) ? item.changes.flatMap((value) => {
      const change = record(value);
      if (!change) return [];
      const path = stringValue(change.path) ?? '未命名文件';
      const kind = stringValue(change.kind) ?? 'update';
      const diff = stringValue(change.diff);
      return [diff || `${kind} · ${path}`];
    }) : [];
    content = changes.join('\n') || textFromContent(item.patch ?? item.content) || '文件已修改';
    collapsible = true;
  } else if (normalizedType.includes('mcptoolcall')) {
    toolName = `${stringValue(item.server) ?? 'MCP'} · ${stringValue(item.tool) ?? '工具'}`;
    content = textFromContent(item.result ?? item.error ?? item.arguments) || '工具调用';
    collapsible = true;
  } else if (normalizedType.includes('dynamictoolcall')) {
    toolName = [stringValue(item.namespace), stringValue(item.tool)].filter(Boolean).join(' · ') || '工具调用';
    content = textFromContent(item.contentItems ?? item.arguments) || '工具调用';
    collapsible = true;
  } else if (normalizedType.includes('collabagenttoolcall')) {
    toolName = `Subagent · ${stringValue(item.tool) ?? '协作'}`;
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(String).join(', ') : '';
    const states = record(item.agentsStates);
    const stateLines = states ? Object.entries(states).map(([agentId, value]) => {
      const agent = record(value);
      return `${agentId}: ${String(agent?.status ?? 'unknown')}${typeof agent?.message === 'string' ? ` — ${agent.message}` : ''}`;
    }).join('\n') : '';
    content = [textFromContent(item.prompt), receivers ? `Agent: ${receivers}` : '', stateLines].filter(Boolean).join('\n') || 'Subagent 协作事件';
    collapsible = true;
  } else if (normalizedType.includes('subagentactivity')) {
    toolName = 'Subagent 活动';
    content = [textFromContent(item.kind), stringValue(item.agentThreadId), stringValue(item.agentPath)].filter(Boolean).join('\n');
    collapsible = true;
  } else if (normalizedType.includes('plan') || normalizedType.includes('todo')) {
    role = 'system';
    toolName = '计划';
    const plan = Array.isArray(item.plan) ? item.plan.map((entry) => {
      const row = record(entry);
      const status = String(row?.status ?? 'pending').toLowerCase();
      const marker = status.includes('complete') ? 'x' : ' ';
      return `- [${marker}] ${String(row?.step ?? row?.text ?? '')}`;
    }).filter((line) => line.trim() !== '- [ ]') : [];
    content = [textFromContent(item.explanation), ...plan, textFromContent(item.text ?? item.content)].filter(Boolean).join('\n');
    collapsible = true;
  } else {
    toolName = type;
    content = textFromContent(item.content ?? item.text ?? item.output ?? item.message ?? item);
    collapsible = role === 'tool';
  }

  if (!content && attachments.length === 0) return null;
  if (!content && attachments.length > 0) content = attachments.every((attachment) => attachment.type === 'image')
    ? `发送了 ${attachments.length} 张图片`
    : `发送了 ${attachments.length} 个附件`;
  const statusText = String(item.status ?? '').toLowerCase();
  return {
    id,
    threadId,
    turnId,
    role,
    content,
    ...(attachments.length ? { attachments } : {}),
    createdAt: timestamp(item.createdAt ?? item.created_at ?? restoreMessage?.createdAt, fallbackCreatedAt),
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
    status: statusText.includes('progress') || (turnInProgress && normalizedType.includes('reasoning')) ? 'streaming' : statusText.includes('fail') ? 'failed' : 'complete',
    toolName,
    itemType: type,
    detail: item,
    collapsible,
  };
}


function isSyntheticProjectedMessage(message: RemoteMessage): boolean {
  return /^item-\d+$/.test(message.id);
}

function messageProjectionFingerprint(message: RemoteMessage): string {
  const itemType = message.role === 'user' || message.role === 'assistant'
    ? message.role
    : (message.itemType ?? message.toolName ?? message.role).toLowerCase();
  return JSON.stringify([
    message.turnId ?? '',
    message.role,
    itemType,
    message.content,
    message.attachments ?? [],
    message.status,
    message.toolName ?? '',
    message.durationMs ?? null,
    message.completedAt ?? null,
    stableProjectedItemValue(message.detail),
  ]);
}

function withoutProjectedMessageAliases(
  messages: RemoteMessage[],
  authoritative: RemoteMessage[],
): RemoteMessage[] {
  const canonicalCounts = new Map<string, number>();
  for (const message of authoritative) {
    if (isSyntheticProjectedMessage(message)) continue;
    const fingerprint = messageProjectionFingerprint(message);
    canonicalCounts.set(fingerprint, (canonicalCounts.get(fingerprint) ?? 0) + 1);
  }
  return messages.filter((message) => {
    // Cross-source fallback aliasing is intentionally limited to assistant output.
    // User items have explicit correlation IDs; tool/system items can legitimately render
    // identical text while carrying different opaque semantics.
    if (!isSyntheticProjectedMessage(message) || message.role !== 'assistant') return true;
    const fingerprint = messageProjectionFingerprint(message);
    const remaining = canonicalCounts.get(fingerprint) ?? 0;
    if (remaining <= 0) return true;
    canonicalCounts.set(fingerprint, remaining - 1);
    return false;
  });
}

function preserveFresherLiveMessage(current: RemoteMessage | undefined, incoming: RemoteMessage): RemoteMessage {
  if (!current) return incoming;
  const currentHasLongerContent = current.content.length > incoming.content.length;
  const preventsTerminalDowngrade = current.status !== 'streaming' && incoming.status === 'streaming';
  if (!currentHasLongerContent && !preventsTerminalDowngrade) return incoming;
  return {
    ...incoming,
    ...((currentHasLongerContent || preventsTerminalDowngrade)
      ? { content: current.content, detail: current.detail ?? incoming.detail }
      : {}),
    ...(preventsTerminalDowngrade ? { status: current.status } : {}),
    completedAt: current.completedAt ?? incoming.completedAt,
    durationMs: current.durationMs ?? incoming.durationMs,
    attachments: (current.attachments?.length ?? 0) > (incoming.attachments?.length ?? 0)
      ? current.attachments
      : incoming.attachments,
  };
}

function messageCorrelationIds(message: RemoteMessage): string[] {
  if (message.role !== 'user') return [];
  const detail = record(message.detail);
  return [detail?.clientUserMessageId, detail?.clientId, detail?.serverUserMessageId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function dedupeMessages(messages: RemoteMessage[]): RemoteMessage[] {
  const byId = new Map<string, RemoteMessage>();
  for (const message of messages) {
    const previous = byId.get(message.id);
    byId.set(message.id, previous ? { ...previous, ...message } : message);
  }
  const output: RemoteMessage[] = [];
  const correlationIndex = new Map<string, number>();
  for (const message of byId.values()) {
    const keys = messageCorrelationIds(message);
    const existingIndex = keys.map((key) => correlationIndex.get(key)).find((value): value is number => value != null);
    if (existingIndex == null) {
      const index = output.push(message) - 1;
      keys.forEach((key) => correlationIndex.set(key, index));
      continue;
    }
    const existing = output[existingIndex]!;
    if (existing.id.startsWith('local_') && !message.id.startsWith('local_')) output[existingIndex] = message;
    messageCorrelationIds(output[existingIndex]!).forEach((key) => correlationIndex.set(key, existingIndex));
  }
  return output;
}

const EMPTY_SELECTED_MESSAGES: RemoteMessage[] = [];

function sameJsonLikeValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left == null || right == null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonLikeValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && sameJsonLikeValue(leftRecord[key], rightRecord[key]));
}

function sameRemoteMessage(left: RemoteMessage, right: RemoteMessage): boolean {
  return left.id === right.id
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.role === right.role
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.completedAt === right.completedAt
    && left.durationMs === right.durationMs
    && left.status === right.status
    && left.toolName === right.toolName
    && left.itemType === right.itemType
    && left.collapsible === right.collapsible
    && sameJsonLikeValue(left.attachments, right.attachments)
    && sameJsonLikeValue(left.detail, right.detail);
}

export type SelectedMessagesSelector = (
  selectedThreadId: string | null,
  messagesByThread: Record<string, RemoteMessage[]>,
  todoByThread: Record<string, RemoteMessage>,
) => RemoteMessage[];

export function createSelectedMessagesSelector(): SelectedMessagesSelector {
  let previousThreadId: string | null | undefined;
  let previousSource: RemoteMessage[] | undefined;
  let previousTodo: RemoteMessage | undefined;
  let previousResult = EMPTY_SELECTED_MESSAGES;

  return (selectedThreadId, messagesByThread, todoByThread) => {
    const source = selectedThreadId ? messagesByThread[selectedThreadId] : undefined;
    const todo = selectedThreadId ? todoByThread[selectedThreadId] : undefined;
    if (selectedThreadId === previousThreadId && source === previousSource && todo === previousTodo) {
      return previousResult;
    }

    const oldThreadId = previousThreadId;
    const oldResult = previousResult;
    previousThreadId = selectedThreadId;
    previousSource = source;
    previousTodo = todo;

    if (!selectedThreadId) {
      previousResult = EMPTY_SELECTED_MESSAGES;
      return previousResult;
    }

    const sourceWithTodo = todo ? [...(source ?? EMPTY_SELECTED_MESSAGES), todo] : (source ?? EMPTY_SELECTED_MESSAGES);
    const projected = dedupeMessages(messagesForThread(selectedThreadId, sourceWithTodo));
    if (projected.length === 0) {
      previousResult = oldThreadId === selectedThreadId && oldResult.length === 0 ? oldResult : EMPTY_SELECTED_MESSAGES;
      return previousResult;
    }

    const previousById = oldThreadId === selectedThreadId
      ? new Map(oldResult.map((message) => [message.id, message]))
      : new Map<string, RemoteMessage>();
    const stabilized = projected.map((message) => {
      const previous = previousById.get(message.id);
      return previous && sameRemoteMessage(previous, message) ? previous : message;
    });
    const resultUnchanged = oldThreadId === selectedThreadId
      && stabilized.length === oldResult.length
      && stabilized.every((message, index) => message === oldResult[index]);
    previousResult = resultUnchanged ? oldResult : stabilized;
    return previousResult;
  };
}


export interface PendingMessageDelta {
  threadId: string;
  turnId?: string;
  itemId: string;
  delta: string;
  role: RemoteMessage['role'];
  toolName?: string;
  itemType?: string;
  createdAt: number;
}

export function applyPendingMessageDeltas(
  current: Record<string, RemoteMessage[]>,
  pending: PendingMessageDelta[],
): Record<string, RemoteMessage[]> {
  if (pending.length === 0) return current;
  const byThread = new Map<string, PendingMessageDelta[]>();
  for (const delta of pending) {
    const bucket = byThread.get(delta.threadId);
    if (bucket) bucket.push(delta);
    else byThread.set(delta.threadId, [delta]);
  }
  const next = { ...current };
  for (const [threadId, deltas] of byThread) {
    const items = [...messagesForThread(threadId, current[threadId] ?? [])];
    const indexById = new Map(items.map((item, index) => [item.id, index]));
    for (const delta of deltas) {
      const index = indexById.get(delta.itemId);
      if (index != null) {
        const previous = items[index]!;
        if (previous.status !== 'streaming') continue;
        items[index] = {
          ...previous,
          turnId: previous.turnId ?? delta.turnId,
          content: previous.content + delta.delta,
          status: 'streaming',
          ...(delta.toolName ? { toolName: delta.toolName } : {}),
          ...(delta.itemType ? { itemType: delta.itemType } : {}),
        };
      } else {
        indexById.set(delta.itemId, items.length);
        items.push({
          id: delta.itemId,
          threadId,
          turnId: delta.turnId,
          role: delta.role,
          content: delta.delta,
          createdAt: delta.createdAt,
          status: 'streaming',
          toolName: delta.toolName,
          itemType: delta.itemType,
        });
      }
    }
    next[threadId] = items;
  }
  return next;
}

function latestPlanMessage(messages: RemoteMessage[]): RemoteMessage | undefined {
  return [...messages].reverse().find((message) => {
    const itemType = message.itemType?.toLowerCase() ?? '';
    return itemType.includes('plan') || itemType.includes('todo') || message.toolName === '计划';
  });
}

function withoutOptimisticMatches(messages: RemoteMessage[], authoritative: RemoteMessage[]): RemoteMessage[] {
  const canonicalUsers = authoritative.filter((message) => message.role === 'user' && !message.id.startsWith('local_'));
  if (canonicalUsers.length === 0) return messages;
  const normalizedContent = (message: RemoteMessage) => message.content.trim().replace(/\s+/g, ' ');
  return messages.filter((message) => {
    if (message.role !== 'user' || !message.id.startsWith('local_')) return true;
    const normalized = normalizedContent(message);
    if (!normalized) return true;
    return !canonicalUsers.some((candidate) =>
      normalizedContent(candidate) === normalized
      && Math.abs(candidate.createdAt - message.createdAt) <= 5 * 60_000,
    );
  });
}

function knownTurnIds(messages: RemoteMessage[]): string[] {
  return [...new Set(messages.flatMap((message) => message.turnId ? [message.turnId] : []))].slice(-500);
}

export function turnIdsAfterSnapshot(current: Record<string, string>, threadId: string, currentTurnId?: string): Record<string, string> {
  if (currentTurnId) return current[threadId] === currentTurnId ? current : { ...current, [threadId]: currentTurnId };
  if (!(threadId in current)) return current;
  const next = { ...current };
  delete next[threadId];
  return next;
}

export function reconcileMessages(
  current: RemoteMessage[],
  incoming: RemoteMessage[],
  placement: 'append' | 'prepend' = 'append',
  targetThreadId = incoming[0]?.threadId ?? current[0]?.threadId,
): RemoteMessage[] {
  const ownedCurrent = targetThreadId ? messagesForThread(targetThreadId, current) : [];
  const ownedIncoming = targetThreadId ? messagesForThread(targetThreadId, incoming) : [];
  if (ownedIncoming.length === 0) return ownedCurrent;
  const authoritative = dedupeMessages(ownedIncoming);
  const incomingIds = new Set(authoritative.map((message) => message.id));
  const incomingCorrelations = new Set(authoritative.flatMap(messageCorrelationIds));
  const overlaps = (message: RemoteMessage) => incomingIds.has(message.id)
    || messageCorrelationIds(message).some((id) => incomingCorrelations.has(id));
  const overlapIndexes = ownedCurrent.flatMap((message, index) => overlaps(message) ? [index] : []);
  const withoutReplacedCanonical = ownedCurrent.filter((message) => !overlaps(message));
  const preserved = withoutOptimisticMatches(withoutReplacedCanonical, authoritative);

  // The wire arrays are the canonical order. Timestamps are turn-level fallbacks and
  // may be identical for every item, so sorting ties by item id can invert user/assistant
  // chronology. Older history pages prepend. A live snapshot replaces its overlapping
  // window in place, keeping previously loaded older history before it and local/newer
  // state after it.
  if (placement === 'prepend') return dedupeMessages([...authoritative, ...preserved]);
  if (overlapIndexes.length === 0) return dedupeMessages([...preserved, ...authoritative]);
  const firstOverlap = Math.min(...overlapIndexes);
  const beforeIds = new Set(ownedCurrent.slice(0, firstOverlap).map((message) => message.id));
  const before = preserved.filter((message) => beforeIds.has(message.id));
  const after = preserved.filter((message) => !beforeIds.has(message.id));
  return dedupeMessages([...before, ...authoritative, ...after]);
}



export function reconcileThreadSnapshot(
  current: RemoteMessage[],
  incoming: RemoteMessage[],
  targetThreadId = incoming[0]?.threadId ?? current[0]?.threadId,
): RemoteMessage[] {
  const ownedCurrent = targetThreadId ? messagesForThread(targetThreadId, current) : [];
  const ownedIncoming = targetThreadId ? messagesForThread(targetThreadId, incoming) : [];
  if (ownedIncoming.length === 0) return ownedCurrent;
  const currentById = new Map(ownedCurrent.map((message) => [message.id, message]));
  const authoritative = dedupeMessages(ownedIncoming)
    .map((message) => preserveFresherLiveMessage(currentById.get(message.id), message));
  const coveredTurnIds = [...new Set(authoritative.flatMap((message) => message.turnId ? [message.turnId] : []))];
  if (coveredTurnIds.length === 0) return reconcileMessages(ownedCurrent, authoritative, 'append', targetThreadId);

  const incomingIds = new Set(authoritative.map((message) => message.id));
  const incomingCorrelations = new Set(authoritative.flatMap(messageCorrelationIds));
  const overlaps = (message: RemoteMessage) => incomingIds.has(message.id)
    || messageCorrelationIds(message).some((id) => incomingCorrelations.has(id));
  const cleanedCurrent = withoutProjectedMessageAliases(
    withoutOptimisticMatches(ownedCurrent, authoritative),
    authoritative,
  );
  const covered = new Set(coveredTurnIds);
  const authoritativeByTurn = new Map<string, RemoteMessage[]>();
  for (const message of authoritative) {
    if (!message.turnId) continue;
    const bucket = authoritativeByTurn.get(message.turnId) ?? [];
    bucket.push(message);
    authoritativeByTurn.set(message.turnId, bucket);
  }
  const liveTailByTurn = new Map<string, RemoteMessage[]>();
  for (const message of cleanedCurrent) {
    if (!message.turnId || !covered.has(message.turnId) || overlaps(message)) continue;
    const bucket = liveTailByTurn.get(message.turnId) ?? [];
    bucket.push(message);
    liveTailByTurn.set(message.turnId, bucket);
  }
  const mergedByTurn = new Map<string, RemoteMessage[]>();

  for (const turnId of coveredTurnIds) {
    const canonical = authoritativeByTurn.get(turnId) ?? [];
    // A Desktop snapshot is the canonical prefix for this turn. Only exact semantic
    // aliases of canonical messages are removed above; unmatched live items retain their
    // opaque IDs and stay in the event tail until a later snapshot includes them.
    const canonicalHasReasoning = canonical.some((message) => message.itemType?.toLowerCase().includes('reasoning'));
    const canonicalHasPlan = canonical.some((message) => {
      const type = message.itemType?.toLowerCase() ?? '';
      return type.includes('plan') || type.includes('todo');
    });
    const eventTail = (liveTailByTurn.get(turnId) ?? []).filter((message) => {
      const type = message.itemType?.toLowerCase() ?? '';
      // Desktop snapshots are authoritative for transient reasoning/plan state. Event
      // aliases often use synthetic IDs, so retaining an older unmatched delta after the
      // canonical block makes the transient footer jump back to stale text.
      if (canonicalHasReasoning && type.includes('reasoning')) return false;
      if (canonicalHasPlan && (type.includes('plan') || type.includes('todo'))) return false;
      return true;
    });
    mergedByTurn.set(turnId, dedupeMessages([...canonical, ...eventTail]));
  }

  const result: RemoteMessage[] = [];
  const emitted = new Set<string>();
  for (const message of cleanedCurrent) {
    const turnId = message.turnId;
    if (!turnId || !covered.has(turnId)) {
      if (!overlaps(message)) result.push(message);
      continue;
    }
    if (emitted.has(turnId)) continue;
    result.push(...(mergedByTurn.get(turnId) ?? []));
    emitted.add(turnId);
  }
  for (const turnId of coveredTurnIds) {
    if (emitted.has(turnId)) continue;
    result.push(...(mergedByTurn.get(turnId) ?? []));
  }
  return dedupeMessages(result);
}


function permissionModeFromThread(data: UnknownRecord): PermissionMode {
  const settings = record(data.latestThreadSettings) ?? record(data.currentPermissions) ?? {};
  const sandbox = record(settings.sandboxPolicy);
  const reviewer = String(settings.approvalsReviewer ?? 'user');
  if (sandbox?.type === 'dangerFullAccess' && settings.approvalPolicy === 'never') return 'full-access';
  if (sandbox?.type === 'readOnly') return 'read-only';
  if (reviewer === 'guardian_subagent' || reviewer === 'auto_review') return 'guardian-approvals';
  if (record(settings.approvalPolicy)?.granular) return 'granular';
  return 'auto';
}

export function normalizeThreadPayload(payload: unknown): {
  thread: RemoteThread | null;
  messages: RemoteMessage[];
  currentTurnId?: string;
} {
  const outer = record(payload);
  const threadData = record(outer?.thread) ?? outer;
  if (!threadData) return { thread: null, messages: [] };
  const id = stringValue(threadData.id, threadData.threadId, threadData.conversationId);
  if (!id) return { thread: null, messages: [] };
  const turns = Array.isArray(threadData.turns) ? threadData.turns : [];
  const messages: RemoteMessage[] = [];
  let currentTurnId: string | undefined;

  turns.forEach((turnValue, turnIndex) => {
    const turn = record(turnValue);
    if (!turn) return;
    const turnOwner = explicitThreadOwner(turn);
    if (turnOwner && turnOwner !== id) return;
    const turnId = stringValue(turn.id, turn.turnId) ?? `turn_${turnIndex}`;
    const turnStatus = String(turn.status ?? '').toLowerCase();
    if (turnStatus.includes('progress')) currentTurnId = turnId;
    const ownedItems = (Array.isArray(turn.items) ? turn.items : []).filter((item) => {
      const itemOwner = explicitThreadOwner(item);
      return !itemOwner || itemOwner === id;
    });
    const items = canonicalProjectedItems(ownedItems);
    items.forEach((item, itemIndex) => {
      const message = itemToMessage(item, id, turnId, itemIndex, timestamp(turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs, 0), turnStatus.includes('progress'));
      if (message) messages.push(message);
    });
  });

  return {
    thread: {
      id,
      title: stringValue(threadData.name, threadData.title, threadData.preview) ?? '未命名任务',
      preview: stringValue(threadData.preview) ?? '',
      cwd: stringValue(threadData.cwd) ?? '',
      modelProvider: stringValue(threadData.modelProvider) ?? '',
      updatedAt: timestamp(threadData.updatedAt ?? threadData.updated_at),
      state: currentTurnId ? 'running' : stateFromStatus(threadData.threadRuntimeStatus ?? threadData.status),
      unread: 0,
      parentThreadId: stringValue(threadData.parentThreadId) ?? subagentMetadataFromSource(threadData.source).parentThreadId ?? null,
      agentNickname: stringValue(threadData.agentNickname) ?? subagentMetadataFromSource(threadData.source).agentNickname ?? null,
      agentRole: stringValue(threadData.agentRole) ?? subagentMetadataFromSource(threadData.source).agentRole ?? null,
      model: stringValue(record(threadData.latestThreadSettings)?.model, threadData.latestModel),
      effort: stringValue(record(threadData.latestThreadSettings)?.effort, threadData.latestReasoningEffort),
      permissionMode: permissionModeFromThread(threadData),
      source: {
        ...(record(threadData.source) ?? { original: threadData.source ?? null }),
        ...(threadData.threadGoal != null ? { threadGoal: threadData.threadGoal } : {}),
        ...(threadData.latestThreadSettings != null ? { latestThreadSettings: threadData.latestThreadSettings } : {}),
        ...(threadData.currentPermissions != null ? { currentPermissions: threadData.currentPermissions } : {}),
      },
      currentTurnStartedAt: currentTurnId
        ? (() => {
            const activeTurn = record(turns.find((value) => stringValue(record(value)?.id, record(value)?.turnId) === currentTurnId));
            return timestamp(activeTurn?.startedAt ?? activeTurn?.turnStartedAtMs ?? activeTurn?.startedAtMs);
          })()
        : undefined,
    },
    messages,
    currentTurnId,
  };
}

function normalizeApproval(approval: WireApprovalRequest): ApprovalRequest {
  return {
    id: String(approval.requestId),
    wireId: approval.requestId,
    threadId: approval.threadId,
    turnId: approval.turnId,
    title: approval.title,
    description: approval.detail ?? approval.reason,
    command: approval.command,
    cwd: approval.cwd,
    availableDecisions: approval.availableDecisions,
    createdAt: Date.now(),
  };
}

export function eventThreadId(params: UnknownRecord | null): string | undefined {
  const nestedThread = record(params?.thread);
  const nestedConversation = record(params?.conversation);
  const nestedTurn = record(params?.turn);
  const nestedItem = record(params?.item);
  return stringValue(
    params?.threadId,
    params?.conversationId,
    nestedThread?.id,
    nestedThread?.threadId,
    nestedThread?.conversationId,
    nestedConversation?.id,
    nestedTurn?.threadId,
    nestedTurn?.conversationId,
    nestedItem?.threadId,
    nestedItem?.conversationId,
    nestedItem?.ownerThreadId,
    nestedItem?.ownerConversationId,
  );
}

function eventTurnId(params: UnknownRecord | null): string | undefined {
  const nestedTurn = record(params?.turn);
  return stringValue(params?.turnId, nestedTurn?.id);
}

export function isContextCompactionItem(value: unknown): boolean {
  const item = record(value);
  if (!item) return false;
  const type = String(item.type ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return type === 'contextcompaction' || type === 'compaction' || type === 'compactiontrigger';
}

function turnHasContextCompaction(value: unknown): boolean {
  const turn = record(value);
  return Array.isArray(turn?.items) && turn.items.some(isContextCompactionItem);
}

export interface ContextCompactionEvidence {
  id: string;
  turnId?: string;
  turnStatus: string;
  completed?: boolean;
  source?: 'manual' | 'automatic';
}

export function contextCompactionItemsFromThreadPayload(payload: unknown): ContextCompactionEvidence[] {
  const outer = record(payload);
  const thread = record(outer?.thread) ?? outer;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const evidence: ContextCompactionEvidence[] = [];
  turns.forEach((turnValue, turnIndex) => {
    const turn = record(turnValue);
    const turnId = stringValue(turn?.id, turn?.turnId);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    items.forEach((itemValue, itemIndex) => {
      if (!isContextCompactionItem(itemValue)) return;
      const item = record(itemValue);
      const source = item?.source === 'manual' || item?.source === 'automatic' ? item.source : undefined;
      evidence.push({
        id: stringValue(item?.id, item?.itemId) ?? `${turnId ?? `turn_${turnIndex}`}:${itemIndex}`,
        turnId,
        turnStatus: String(turn?.status ?? '').toLowerCase(),
        completed: typeof item?.completed === 'boolean' ? item.completed : undefined,
        source,
      });
    });
  });
  return evidence;
}

export function contextCompactionItemIdsFromThreadPayload(payload: unknown): string[] {
  return contextCompactionItemsFromThreadPayload(payload).map((item) => item.id);
}

export function compactionStatusFromThreadPayload(payload: unknown, now = Date.now()): CompactionStatus | null {
  const outer = record(payload);
  const thread = record(outer?.thread) ?? outer;
  const threadId = stringValue(thread?.id, thread?.threadId);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  if (!threadId) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = record(turns[index]);
    if (!turn || !turnHasContextCompaction(turn)) continue;
    const status = String(turn.status ?? '').toLowerCase();
    const startedAt = timestamp(turn.startedAt ?? turn.turnStartedAtMs ?? turn.startedAtMs, now);
    const completedAt = timestamp(turn.completedAt ?? turn.completedAtMs, now);
    const turnId = stringValue(turn.id, turn.turnId);
    if (status.includes('progress')) {
      return { threadId, phase: 'running', startedAt, updatedAt: now, turnId, automatic: true };
    }
    if ((status.includes('fail') || status.includes('interrupt')) && now - completedAt <= 5 * 60_000) {
      const error = record(turn.error);
      return {
        threadId,
        phase: 'failed',
        startedAt,
        updatedAt: completedAt,
        turnId,
        message: stringValue(error?.message, error?.additionalDetails) ?? (status.includes('interrupt') ? '上下文压缩被中断' : '上下文压缩失败'),
        automatic: true,
      };
    }
    return null;
  }
  return null;
}

export function useRemote(config: RemoteConfig | null) {
  const socketRef = useRef<RemoteSocket | null>(null);
  const selectedThreadRef = useRef<string | null>(null);
  const turnIdsRef = useRef<Record<string, string>>({});
  const approvalsRef = useRef<ApprovalRequest[]>([]);
  const threadsRef = useRef<RemoteThread[]>([]);
  const itemStartedAtRef = useRef<Record<string, number>>({});
  const notifiedApprovalIdsRef = useRef<Set<string>>(new Set());
  const notifiedTurnIdsRef = useRef<Set<string>>(new Set());
  const attentionStateByThreadRef = useRef<Record<string, 'waiting_approval' | 'waiting_input'>>({});
  const notifiedAttentionStateByThreadRef = useRef<Record<string, 'waiting_approval' | 'waiting_input'>>({});
  const attentionNotificationTimersRef = useRef<Record<string, number>>({});
  const notificationGuardRef = useRef(new NotificationGenerationGuard());
  const notificationQueueRef = useRef(new NotificationOperationQueue());
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [phaseDetail, setPhaseDetail] = useState('');
  const [codexReady, setCodexReady] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [selectedModel, setSelectedModelState] = useState('');
  const [selectedEffort, setSelectedEffortState] = useState('');
  const [selectedPermissionMode, setSelectedPermissionModeState] = useState<PermissionMode>('auto');
  const [threads, setThreads] = useState<RemoteThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messagesByThread, setMessagesByThread] = useState<Record<string, RemoteMessage[]>>({});
  const [todoByThread, setTodoByThread] = useState<Record<string, RemoteMessage>>({});
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [turnIds, setTurnIds] = useState<Record<string, string>>({});
  const [lastError, setLastError] = useState('');
  const [compactionsByThread, setCompactionsByThread] = useState<Record<string, CompactionStatus>>({});
  const [promptQueueByThread, setPromptQueueByThread] = useState<Record<string, PromptQueueItem[]>>({});
  const [gitDiffByThread, setGitDiffByThread] = useState<Record<string, GitDiffSnapshot>>({});
  const compactionsRef = useRef<Record<string, CompactionStatus>>({});
  const compactionTurnIdsRef = useRef<Record<string, Set<string>>>({});
  const pendingCompactionRequestsRef = useRef<Map<string, string>>(new Map());
  const pendingThreadStartRequestsRef = useRef<Set<string>>(new Set());
  const notifiedCompactionFailuresRef = useRef<Set<string>>(new Set());
  const seenCompactionItemsRef = useRef<Record<string, Map<string, boolean | undefined>>>({});
  const [historyByThread, setHistoryByThread] = useState<Record<string, CachedHistoryState>>({});
  const [historyLoadingByThread, setHistoryLoadingByThread] = useState<Record<string, boolean>>({});
  const historyByThreadRef = useRef<Record<string, CachedHistoryState>>({});
  const messagesByThreadRef = useRef<Record<string, RemoteMessage[]>>({});
  const pendingMessageDeltasRef = useRef<Map<string, PendingMessageDelta>>(new Map());
  const pendingMessageDeltaTimerRef = useRef<number | null>(null);
  const terminalMessageItemsRef = useRef<Set<string>>(new Set());
  const terminalMessageTurnsRef = useRef<Set<string>>(new Set());
  const syncVersionRef = useRef<string | undefined>(undefined);
  const syncCursorRef = useRef(0);
  const threadIndexVersionRef = useRef(0);
  const serverIdRef = useRef<string | undefined>(undefined);
  const cacheScopeRef = useRef<string | null>(null);
  const cacheHydratedRef = useRef(false);
  const cacheSaveTimerRef = useRef<number | null>(null);
  const cacheWriteRef = useRef<Promise<void>>(Promise.resolve());
  const cacheEpochRef = useRef(0);
  const handleMessageRef = useRef<(message: ServerMessage) => void>(() => undefined);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  useEffect(() => {
    turnIdsRef.current = turnIds;
  }, [turnIds]);

  useEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    messagesByThreadRef.current = messagesByThread;
  }, [messagesByThread]);

  useEffect(() => () => {
    if (pendingMessageDeltaTimerRef.current != null) window.clearTimeout(pendingMessageDeltaTimerRef.current);
    pendingMessageDeltaTimerRef.current = null;
    pendingMessageDeltasRef.current.clear();
    terminalMessageItemsRef.current.clear();
    terminalMessageTurnsRef.current.clear();
  }, []);

  useEffect(() => {
    historyByThreadRef.current = historyByThread;
  }, [historyByThread]);

  useEffect(() => {
    compactionsRef.current = compactionsByThread;
  }, [compactionsByThread]);

  const updateCompactionStatus = useCallback((threadId: string, next: Omit<CompactionStatus, 'threadId' | 'startedAt' | 'updatedAt'> & { startedAt?: number; updatedAt?: number }) => {
    const now = Date.now();
    setCompactionsByThread((current) => {
      const previous = current[threadId];
      const status: CompactionStatus = {
        threadId,
        startedAt: next.startedAt ?? previous?.startedAt ?? now,
        updatedAt: next.updatedAt ?? now,
        automatic: next.automatic ?? previous?.automatic,
        turnId: next.turnId ?? previous?.turnId,
        message: next.message,
        phase: next.phase,
      };
      const updated = { ...current, [threadId]: status };
      compactionsRef.current = updated;
      return updated;
    });
  }, []);

  const reportCompactionFailure = useCallback((threadId: string, message: string, turnId?: string) => {
    const normalizedMessage = message.trim() || '上下文压缩失败';
    updateCompactionStatus(threadId, { phase: 'failed', message: normalizedMessage, turnId });
    setLastError(`上下文压缩失败：${normalizedMessage}`);
    const key = `${threadId}:${turnId ?? normalizedMessage}`;
    if (notifiedCompactionFailuresRef.current.has(key)) return;
    notifiedCompactionFailuresRef.current.add(key);
    const threadTitle = threadsRef.current.find((thread) => thread.id === threadId)?.title ?? 'Codex 任务';
    void notifyCompactionFailed({ threadId, threadTitle, message: normalizedMessage });
  }, [updateCompactionStatus]);

  const observeCompactionSnapshot = useCallback((payload: unknown, threadId: string) => {
    const items = contextCompactionItemsFromThreadPayload(payload);
    const nextItems = new Map(items.map((item) => [item.id, item.completed]));
    const previousItems = seenCompactionItemsRef.current[threadId];
    seenCompactionItemsRef.current[threadId] = nextItems;
    if (previousItems) {
      for (const item of items) {
        const previousCompleted = previousItems.get(item.id);
        const isNew = !previousItems.has(item.id);
        const becameComplete = previousCompleted === false && item.completed === true;
        if (item.completed === false && isNew) {
          if (item.turnId) {
            compactionTurnIdsRef.current[threadId] ??= new Set();
            compactionTurnIdsRef.current[threadId].add(item.turnId);
          }
          updateCompactionStatus(threadId, {
            phase: 'running',
            turnId: item.turnId,
            message: '正在压缩上下文',
            automatic: item.source === 'automatic',
          });
        } else if (item.completed === true && (isNew || becameComplete)) {
          updateCompactionStatus(threadId, {
            phase: 'succeeded',
            turnId: item.turnId,
            message: '上下文压缩完成',
            automatic: item.source === 'automatic',
          });
        }
      }
    }

    const active = compactionsRef.current[threadId];
    if (!active || !['requested', 'running', 'retrying'].includes(active.phase)) return;
    const outer = record(payload);
    const thread = record(outer?.thread) ?? outer;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const activeTurn = [...turns].reverse().map(record).find((turn) => turn && String(turn.status ?? '').toLowerCase().includes('progress'));
    const latestTurn = record(turns.at(-1));
    if (!activeTurn && latestTurn && String(latestTurn.status ?? '').toLowerCase().includes('fail')) {
      const error = record(latestTurn.error);
      reportCompactionFailure(threadId, stringValue(error?.message, error?.additionalDetails) ?? '上下文压缩失败', stringValue(latestTurn.id, latestTurn.turnId));
    }
  }, [reportCompactionFailure, updateCompactionStatus]);

  const updateThreadState = useCallback((threadId: string, state: ThreadState) => {
    setThreads((current) => {
      const updated = sortThreads(
        current.map((thread) =>
          thread.id === threadId ? { ...thread, state, updatedAt: Date.now() } : thread,
        ),
      );
      threadsRef.current = updated;
      return updated;
    });
  }, []);

  const queueAttentionCancellation = useCallback((threadId: string, kind: 'approval' | 'input') => {
    return notificationQueueRef.current.run(
      `attention:${kind}:${threadId}`,
      () => cancelThreadAttentionNotification(threadId, kind),
    );
  }, []);

  const queueApprovalCancellation = useCallback((requestId: string | number) => {
    return notificationQueueRef.current.run(
      `approval:${String(requestId)}`,
      () => cancelApprovalNotification(requestId),
    );
  }, []);

  const clearThreadAttentionNotification = useCallback((threadId: string) => {
    notificationGuardRef.current.invalidate(`attention:${threadId}`);
    const pendingTimer = attentionNotificationTimersRef.current[threadId];
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    delete attentionNotificationTimersRef.current[threadId];
    delete attentionStateByThreadRef.current[threadId];
    delete notifiedAttentionStateByThreadRef.current[threadId];
    // Both IDs are deterministic. Cancelling both also cleans a notification delivered
    // after an earlier async schedule crossed this state transition.
    void queueAttentionCancellation(threadId, 'approval');
    void queueAttentionCancellation(threadId, 'input');
  }, [queueAttentionCancellation]);

  const updateAttentionNotification = useCallback((threadId: string, state: ThreadState) => {
    if (state !== 'waiting_approval' && state !== 'waiting_input') {
      clearThreadAttentionNotification(threadId);
      return;
    }

    if (state === 'waiting_approval' && approvalsRef.current.some((approval) => approval.threadId === threadId)) {
      const pending = attentionNotificationTimersRef.current[threadId];
      if (pending !== undefined) window.clearTimeout(pending);
      delete attentionNotificationTimersRef.current[threadId];
      attentionStateByThreadRef.current[threadId] = state;
      return;
    }

    const previous = attentionStateByThreadRef.current[threadId];
    const pendingTimer = attentionNotificationTimersRef.current[threadId];
    const alreadyNotified = notifiedAttentionStateByThreadRef.current[threadId] === state;
    if (previous === state && (pendingTimer !== undefined || alreadyNotified)) return;

    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    delete attentionNotificationTimersRef.current[threadId];
    const previouslyNotified = notifiedAttentionStateByThreadRef.current[threadId];
    if (previouslyNotified && previouslyNotified !== state) {
      void queueAttentionCancellation(threadId, previouslyNotified === 'waiting_input' ? 'input' : 'approval');
      delete notifiedAttentionStateByThreadRef.current[threadId];
    }

    attentionStateByThreadRef.current[threadId] = state;
    const kind = state === 'waiting_input' ? 'input' : 'approval';
    const ticket = notificationGuardRef.current.begin(`attention:${threadId}`);
    const showNotification = () => {
      if (!notificationGuardRef.current.isCurrent(ticket) || attentionStateByThreadRef.current[threadId] !== state) return;
      const threadTitle = threadsRef.current.find((thread) => thread.id === threadId)?.title ?? 'Codex 任务';
      void settleGuardedNotification({
        guard: notificationGuardRef.current,
        ticket,
        queue: notificationQueueRef.current,
        operationKey: `attention:${kind}:${threadId}`,
        schedule: () => notifyThreadAttention({ threadId, threadTitle, kind }),
        isRelevant: () => attentionStateByThreadRef.current[threadId] === state
          && !(kind === 'approval' && approvalsRef.current.some((approval) => approval.threadId === threadId)),
        cancel: () => cancelThreadAttentionNotification(threadId, kind),
      }).then((result) => {
        if (result === 'stale') return;
        if (result === 'shown') {
          notifiedAttentionStateByThreadRef.current[threadId] = state;
          return;
        }
        delete notifiedAttentionStateByThreadRef.current[threadId];
        setLastError('Android 通知未能发送，请检查通知权限及通知分类的声音设置');
      });
    };
    if (kind === 'approval') {
      // A detailed approval event normally follows the coarse waiting status. Delay the
      // fallback briefly; repeated snapshots must not keep cancelling the same timer.
      attentionNotificationTimersRef.current[threadId] = window.setTimeout(() => {
        delete attentionNotificationTimersRef.current[threadId];
        showNotification();
      }, 2_000);
    } else {
      showNotification();
    }
  }, [clearThreadAttentionNotification, queueAttentionCancellation]);

  const replaceThreadsAndSyncAttention = useCallback((nextThreads: RemoteThread[]) => {
    const nextIds = new Set(nextThreads.map((thread) => thread.id));
    for (const threadId of Object.keys(attentionStateByThreadRef.current)) {
      if (!nextIds.has(threadId)) clearThreadAttentionNotification(threadId);
    }
    threadsRef.current = nextThreads;
    setThreads(nextThreads);
    for (const thread of nextThreads) updateAttentionNotification(thread.id, thread.state);
  }, [clearThreadAttentionNotification, updateAttentionNotification]);

  const flushPendingMessageDeltas = useCallback(() => {
    if (pendingMessageDeltaTimerRef.current != null) {
      window.clearTimeout(pendingMessageDeltaTimerRef.current);
      pendingMessageDeltaTimerRef.current = null;
    }
    if (pendingMessageDeltasRef.current.size === 0) return;
    const pending = [...pendingMessageDeltasRef.current.values()];
    pendingMessageDeltasRef.current.clear();
    setMessagesByThread((current) => applyPendingMessageDeltas(current, pending));
  }, []);

  const appendDelta = useCallback(
    (threadId: string, turnId: string | undefined, itemId: string, delta: string, role: RemoteMessage['role'], toolName?: string, itemType?: string) => {
      if (!delta) return;
      const itemKey = `${threadId}\u0000${itemId}`;
      const turnKey = turnId ? `${threadId}\u0000${turnId}` : '';
      if (terminalMessageItemsRef.current.has(itemKey) || (turnKey && terminalMessageTurnsRef.current.has(turnKey))) return;
      const key = itemKey;
      const previous = pendingMessageDeltasRef.current.get(key);
      pendingMessageDeltasRef.current.set(key, previous ? {
        ...previous,
        turnId: previous.turnId ?? turnId,
        delta: previous.delta + delta,
        ...(toolName ? { toolName } : {}),
        ...(itemType ? { itemType } : {}),
      } : { threadId, turnId, itemId, delta, role, toolName, itemType, createdAt: Date.now() });
      if (pendingMessageDeltaTimerRef.current == null) {
        pendingMessageDeltaTimerRef.current = window.setTimeout(flushPendingMessageDeltas, 32);
      }
    },
    [flushPendingMessageDeltas],
  );

  const handleEvent = useCallback(
    (method: string, rawParams: unknown) => {
      const params = record(rawParams);
      const threadId = eventThreadId(params);
      const turnId = eventTurnId(params);
      const item = record(params?.item);
      const itemId = stringValue(params?.itemId, item?.id) ?? `${turnId ?? 'turn'}_${method}`;
      const lowerMethod = method.toLowerCase();
      const isBufferedTextDelta = method === 'item/reasoning/summaryTextDelta'
        || method === 'item/reasoning/textDelta'
        || method === 'item/plan/delta'
        || method === 'item/mcpToolCall/progress'
        || method === 'turn/diff/updated'
        || (lowerMethod.includes('agentmessage') && lowerMethod.includes('delta'))
        || lowerMethod.includes('outputdelta');
      if (!isBufferedTextDelta) flushPendingMessageDeltas();

      if ((method === 'thread/started' || method === 'desktop/threadSnapshot') && params?.thread) {
        const normalized = normalizeThreadPayload({ thread: params.thread });
        if (normalized.thread) {
          observeCompactionSnapshot({ thread: params.thread }, normalized.thread.id);
          const latestTodo = latestPlanMessage(normalized.messages);
          if (latestTodo) setTodoByThread((current) => ({ ...current, [normalized.thread!.id]: latestTodo }));
          replaceThreadsAndSyncAttention(sortThreads(upsertById(threadsRef.current, normalized.thread!)));
          if (selectedThreadRef.current === normalized.thread.id) {
            setMessagesByThread((current) => ({ ...current, [normalized.thread!.id]: reconcileThreadSnapshot(current[normalized.thread!.id] ?? [], normalized.messages, normalized.thread!.id) }));
            if (normalized.thread.model) setSelectedModelState(normalized.thread.model);
            if (normalized.thread.effort) setSelectedEffortState(normalized.thread.effort);
            if (normalized.thread.permissionMode) setSelectedPermissionModeState(normalized.thread.permissionMode);
            setTurnIds((current) => turnIdsAfterSnapshot(current, normalized.thread!.id, normalized.currentTurnId));
          }
        }
        return;
      }
      if (method === 'thread/status/changed' && threadId) {
        const nextState = stateFromStatus(params?.status);
        updateThreadState(threadId, nextState);
        updateAttentionNotification(threadId, nextState);
        if (!['running', 'waiting_approval', 'waiting_input'].includes(nextState)) {
          setTurnIds((current) => turnIdsAfterSnapshot(current, threadId));
        }
        return;
      }
      if (method === 'thread/tokenUsage/updated' && threadId) {
        const tokenUsage = record(params?.tokenUsage);
        const total = record(tokenUsage?.total);
        if (total) {
          setThreads((current) => {
            const updated = current.map((thread) => thread.id === threadId ? {
              ...thread,
              tokenUsage: {
                totalTokens: Number(total.totalTokens ?? 0),
                inputTokens: Number(total.inputTokens ?? 0),
                outputTokens: Number(total.outputTokens ?? 0),
                reasoningOutputTokens: Number(total.reasoningOutputTokens ?? 0),
              },
            } : thread);
            threadsRef.current = updated;
            return updated;
          });
        }
        return;
      }
      if (method === 'turn/started' && threadId && turnId) {
        terminalMessageTurnsRef.current.delete(`${threadId}\u0000${turnId}`);
        setTurnIds((current) => ({ ...current, [threadId]: turnId }));
        const turn = record(params?.turn);
        const startedAt = timestamp(turn?.startedAt ?? turn?.turnStartedAtMs ?? turn?.startedAtMs ?? params?.startedAtMs ?? Date.now());
        if (turnHasContextCompaction(turn)) {
          compactionTurnIdsRef.current[threadId] ??= new Set();
          compactionTurnIdsRef.current[threadId].add(turnId);
          updateCompactionStatus(threadId, { phase: 'running', startedAt, turnId, automatic: !compactionsRef.current[threadId] });
        }
        setThreads((current) => {
          const updated = current.map((thread) => thread.id === threadId ? { ...thread, state: 'running' as const, currentTurnStartedAt: startedAt } : thread);
          threadsRef.current = updated;
          return updated;
        });
        updateAttentionNotification(threadId, 'running');
        return;
      }
      if (method === 'turn/completed' && threadId) {
        if (turnId) terminalMessageTurnsRef.current.add(`${threadId}\u0000${turnId}`);
        const turn = record(params?.turn);
        const failed = String(turn?.status ?? '').toLowerCase() === 'failed';
        const error = record(turn?.error);
        const errorText = stringValue(error?.message, error?.additionalDetails, params?.message);
        const turnStatus = String(turn?.status ?? '').toLowerCase();
        const trackedCompaction = Boolean(turnId && compactionTurnIdsRef.current[threadId]?.has(turnId));
        const activeCompaction = compactionsRef.current[threadId];
        const isCompactionTurn = trackedCompaction || (Boolean(activeCompaction) && ['requested', 'running', 'retrying'].includes(activeCompaction.phase) && turnHasContextCompaction(turn));
        if (isCompactionTurn) {
          if (failed || turnStatus.includes('interrupt')) {
            reportCompactionFailure(threadId, errorText ?? (turnStatus.includes('interrupt') ? '上下文压缩被中断' : '上下文压缩失败'), turnId);
          } else {
            updateCompactionStatus(threadId, { phase: 'succeeded', message: '上下文压缩完成', turnId });
          }
          if (turnId) compactionTurnIdsRef.current[threadId]?.delete(turnId);
        }
        setTurnIds((current) => {
          const next = { ...current };
          delete next[threadId];
          return next;
        });
        const durationMs = typeof turn?.durationMs === 'number' ? turn.durationMs : undefined;
        const completedThreadState: ThreadState = failed ? 'error' : 'idle';
        setThreads((current) => {
          const updated = current.map((thread) => thread.id === threadId ? {
            ...thread,
            state: completedThreadState,
            currentTurnStartedAt: undefined,
            lastTurnDurationMs: durationMs,
            updatedAt: Date.now(),
          } : thread);
          threadsRef.current = updated;
          return updated;
        });
        setMessagesByThread((current) => {
          const completed = messagesForThread(threadId, current[threadId] ?? []).map((message) =>
            message.status === 'streaming'
              ? { ...message, status: failed ? ('failed' as const) : ('complete' as const), completedAt: Date.now() }
              : message,
          );
          if (failed && errorText) {
            completed.push({
              id: `${turnId ?? 'turn'}_error`,
              threadId,
              role: 'system',
              content: errorText,
              createdAt: Date.now(),
              status: 'failed',
              toolName: '错误',
            });
          }
          return { ...current, [threadId]: completed };
        });
        if (failed && errorText && !isCompactionTurn) setLastError(errorText);
        const threadTitle = threadsRef.current.find((thread) => thread.id === threadId)?.title ?? 'Codex 任务';
        if (!isCompactionTurn) {
          const notificationKey = `${threadId}:${turnId ?? String(turn?.completedAt ?? turn?.startedAt ?? '')}`;
          if (!notifiedTurnIdsRef.current.has(notificationKey)) {
            notifiedTurnIdsRef.current.add(notificationKey);
            void notifyTurnFinished({
              threadId,
              threadTitle,
              status: String(turn?.status ?? (failed ? 'failed' : 'completed')),
              durationMs,
              eventId: turnId ?? String(turn?.completedAt ?? turn?.startedAt ?? 'latest'),
            }).then((shown) => {
              if (!shown) {
                notifiedTurnIdsRef.current.delete(notificationKey);
                setLastError('Android 通知未能发送，请检查通知权限及通知分类的声音设置');
              }
            });
          }
        }
        clearThreadAttentionNotification(threadId);
        return;
      }
      if (method === 'error' && threadId) {
        const error = record(params?.error);
        const errorText = stringValue(error?.message, error?.additionalDetails) ?? 'Codex turn 发生错误';
        const activeCompaction = compactionsRef.current[threadId];
        const belongsToCompaction = Boolean(activeCompaction && ['requested', 'running', 'retrying'].includes(activeCompaction.phase)
          && (!turnId || !activeCompaction.turnId || activeCompaction.turnId === turnId || compactionTurnIdsRef.current[threadId]?.has(turnId)));
        if (belongsToCompaction) {
          if (params?.willRetry === true) {
            updateCompactionStatus(threadId, { phase: 'retrying', message: `发生错误，Codex 正在重试：${errorText}`, turnId });
            setLastError(`上下文压缩遇到错误，正在重试：${errorText}`);
          } else {
            reportCompactionFailure(threadId, errorText, turnId);
            updateThreadState(threadId, 'error');
          }
          return;
        }
        setLastError(errorText);
        if (params?.willRetry !== true) updateThreadState(threadId, 'error');
        return;
      }
      if ((method === 'thread/compacted' || method === 'context/compacted') && threadId) {
        updateCompactionStatus(threadId, { phase: 'succeeded', message: '上下文压缩完成', turnId });
        return;
      }
      if (method === 'item/reasoning/summaryTextDelta' && threadId) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'system', '思考梗概', 'reasoning');
        return;
      }
      if (method === 'item/reasoning/textDelta' && threadId) {
        appendDelta(threadId, turnId, `${itemId}_detail`, textFromContent(params?.delta), 'system', '思考详情', 'reasoning');
        return;
      }
      if (method === 'item/plan/delta' && threadId) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'system', '计划', 'plan');
        return;
      }
      if (method === 'turn/plan/updated' && threadId) {
        const plan = Array.isArray(params?.plan) ? params.plan : [];
        const text = plan.map((entry) => {
          const row = record(entry);
          return `${String(row?.status ?? 'pending')} · ${String(row?.step ?? '')}`;
        }).join('\n');
        if (text) {
          const id = `${turnId ?? 'turn'}_plan`;
          const planMessage: RemoteMessage = {
            id,
            threadId,
            turnId,
            role: 'system',
            content: [typeof params?.explanation === 'string' ? params.explanation : '', text].filter(Boolean).join('\n'),
            createdAt: Date.now(),
            status: 'streaming',
            toolName: '计划',
            itemType: 'plan',
            detail: rawParams,
            collapsible: true,
          };
          setTodoByThread((current) => ({ ...current, [threadId]: planMessage }));
          setMessagesByThread((current) => ({
            ...current,
            [threadId]: upsertById(messagesForThread(threadId, current[threadId] ?? []), planMessage),
          }));
        }
        return;
      }
      if (method === 'item/mcpToolCall/progress' && threadId) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.message), 'tool', 'MCP 进度');
        return;
      }
      if (method === 'turn/diff/updated' && threadId && turnId) {
        appendDelta(threadId, turnId, `${turnId}_diff`, textFromContent(params?.diff), 'tool', '本轮 Diff');
        return;
      }
      if (method === 'item/fileChange/patchUpdated' && threadId) {
        const normalized = itemToMessage(
          { type: 'fileChange', id: itemId, changes: params?.changes, status: 'inProgress' },
          threadId,
          turnId ?? 'turn',
          0,
        );
        if (normalized) {
          normalized.status = 'streaming';
          setMessagesByThread((current) => ({
            ...current,
            [threadId]: dedupeMessages(upsertById(messagesForThread(threadId, current[threadId] ?? []), normalized)),
          }));
        }
        return;
      }
      if ((method === 'item/started' || method === 'item/completed') && threadId && item) {
        const terminalItemKey = `${threadId}\u0000${itemId}`;
        if (method === 'item/started') {
          terminalMessageItemsRef.current.delete(terminalItemKey);
          terminalMessageItemsRef.current.delete(`${terminalItemKey}_detail`);
        } else {
          terminalMessageItemsRef.current.add(terminalItemKey);
          terminalMessageItemsRef.current.add(`${terminalItemKey}_detail`);
        }
        if (isContextCompactionItem(item)) {
          if (turnId) {
            compactionTurnIdsRef.current[threadId] ??= new Set();
            compactionTurnIdsRef.current[threadId].add(turnId);
          }
          if (method === 'item/started') {
            updateCompactionStatus(threadId, {
              phase: 'running',
              startedAt: typeof params?.startedAtMs === 'number' ? params.startedAtMs : Date.now(),
              turnId,
              automatic: !compactionsRef.current[threadId],
            });
          } else {
            updateCompactionStatus(threadId, {
              phase: 'succeeded',
              updatedAt: typeof params?.completedAtMs === 'number' ? params.completedAtMs : Date.now(),
              turnId,
              message: '上下文压缩完成',
            });
          }
          return;
        }
        const normalized = itemToMessage(item, threadId, turnId ?? 'turn', 0);
        const timingKey = `${threadId}:${turnId ?? 'turn'}:${itemId}`;
        if (method === 'item/started') {
          itemStartedAtRef.current[timingKey] = typeof params?.startedAtMs === 'number' ? params.startedAtMs : Date.now();
        }
        if (normalized) {
          if (method === 'item/started') {
            normalized.status = 'streaming';
            normalized.createdAt = itemStartedAtRef.current[timingKey] ?? normalized.createdAt;
          } else {
            const completedAt = typeof params?.completedAtMs === 'number' ? params.completedAtMs : Date.now();
            const startedAt = itemStartedAtRef.current[timingKey];
            normalized.completedAt = completedAt;
            if (normalized.durationMs == null && startedAt != null) normalized.durationMs = Math.max(0, completedAt - startedAt);
            delete itemStartedAtRef.current[timingKey];
          }
          setMessagesByThread((current) => ({
            ...current,
            [threadId]: dedupeMessages(upsertById(
              normalized.role === 'user'
                ? withoutOptimisticMatches(messagesForThread(threadId, current[threadId] ?? []), [normalized])
                : messagesForThread(threadId, current[threadId] ?? []),
              normalized,
            )),
          }));
        }
        return;
      }
      if (threadId && method.includes('agentMessage') && method.toLowerCase().includes('delta')) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'assistant');
        return;
      }
      if (threadId && method.toLowerCase().includes('outputdelta')) {
        appendDelta(threadId, turnId, itemId, textFromContent(params?.delta), 'tool', '命令输出');
      }
    },
    [appendDelta, clearThreadAttentionNotification, flushPendingMessageDeltas, observeCompactionSnapshot, replaceThreadsAndSyncAttention, reportCompactionFailure, updateAttentionNotification, updateCompactionStatus, updateThreadState],
  );

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      if (message.type === 'sync.replay') {
        if (message.syncVersion !== syncVersionRef.current) return;
        for (const event of message.events) handleMessageRef.current(event);
        syncCursorRef.current = Math.max(syncCursorRef.current, message.toCursor);
        return;
      }
      if (message.type === 'sync.reset') {
        syncVersionRef.current = message.syncVersion;
        syncCursorRef.current = message.latestCursor;
        threadIndexVersionRef.current = 0;
        socketRef.current?.send({ type: 'threads.sync', requestId: createRequestId('threads-sync') });
        const threadId = selectedThreadRef.current;
        if (threadId) socketRef.current?.send({
          type: 'thread.open', requestId: createRequestId('open-reset'), threadId,
          historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
        });
        return;
      }
      if (message.syncVersion && syncVersionRef.current && message.syncVersion !== syncVersionRef.current) {
        syncVersionRef.current = message.syncVersion;
        syncCursorRef.current = 0;
      }
      if (typeof message.syncCursor === 'number' && message.syncCursor <= syncCursorRef.current) return;
      switch (message.type) {
        case 'welcome': {
          setCodexReady(message.codexReady);
          setLastError('');
          setPhaseDetail(message.codexReady ? '' : 'Bridge 已连接，但 Codex app-server 尚未就绪');
          const serverChanged = Boolean(serverIdRef.current && serverIdRef.current !== message.serverId);
          if (serverChanged) {
            replaceThreadsAndSyncAttention([]);
            setMessagesByThread({});
            setHistoryByThread({});
            threadIndexVersionRef.current = 0;
            syncCursorRef.current = 0;
          }
          serverIdRef.current = message.serverId;
          const sameSyncVersion = !serverChanged && Boolean(message.syncVersion && syncVersionRef.current === message.syncVersion);
          if (message.syncVersion) {
            socketRef.current?.send({
              type: 'sync.resume', requestId: createRequestId('resume'),
              syncVersion: sameSyncVersion ? syncVersionRef.current : undefined,
              cursor: sameSyncVersion ? syncCursorRef.current : undefined,
              threadIds: selectedThreadRef.current ? [selectedThreadRef.current] : [],
            });
            syncVersionRef.current = message.syncVersion;
            socketRef.current?.send({
              type: 'threads.sync', requestId: createRequestId('threads-sync'),
              knownVersion: sameSyncVersion ? threadIndexVersionRef.current : undefined,
            });
          } else {
            syncVersionRef.current = undefined;
            syncCursorRef.current = 0;
            socketRef.current?.send({ type: 'threads.list', requestId: createRequestId('threads') });
          }
          socketRef.current?.send({ type: 'models.list', requestId: createRequestId('models') });
          socketRef.current?.send({ type: 'prompt.queue.list', requestId: createRequestId('queue') });
          if (selectedThreadRef.current) {
            const selected = selectedThreadRef.current;
            socketRef.current?.send({
              type: 'thread.open', requestId: createRequestId('open'), threadId: selected,
              historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(selected, messagesByThreadRef.current[selected] ?? [])),
            });
            socketRef.current?.send({ type: 'thread.diff.get', requestId: createRequestId('diff'), threadId: selected });
          }
          break;
        }
        case 'status':
          setCodexReady(message.codexReady);
          if (message.codexReady) {
            setPhase('connected');
            setPhaseDetail('');
            setLastError('');
            socketRef.current?.send(syncVersionRef.current
              ? { type: 'threads.sync', requestId: createRequestId('threads-sync'), knownVersion: threadIndexVersionRef.current }
              : { type: 'threads.list', requestId: createRequestId('threads') });
          } else {
            const detail = message.detail || 'Bridge 已连接，但 Codex app-server 尚未就绪';
            setPhaseDetail(detail);
            setLastError(detail);
          }
          break;
        case 'threads': {
          replaceThreadsAndSyncAttention(mergeThreadSummaries(threadsRef.current, message.threads, true));
          break;
        }
        case 'threads.snapshot': {
          threadIndexVersionRef.current = message.version;
          replaceThreadsAndSyncAttention(mergeThreadSummaries(threadsRef.current, message.threads, true));
          break;
        }
        case 'threads.delta':
          if (message.baseVersion !== threadIndexVersionRef.current) {
            socketRef.current?.send({ type: 'threads.sync', requestId: createRequestId('threads-resync') });
            break;
          }
          threadIndexVersionRef.current = message.version;
          replaceThreadsAndSyncAttention(mergeThreadSummaries(
            threadsRef.current.filter((thread) => !message.removedIds.includes(thread.id)),
            message.upserts,
            false,
          ));
          break;
        case 'models': {
          setModels(message.models);
          setSelectedModelState((current) => current || message.models.find((model) => model.isDefault)?.model || message.models[0]?.model || '');
          setSelectedEffortState((current) => {
            if (current) return current;
            const defaultModel = message.models.find((model) => model.isDefault) ?? message.models[0];
            return defaultModel?.defaultReasoningEffort ?? '';
          });
          break;
        }
        case 'skills':
          setSkills(message.skills.filter((skill) => skill.enabled));
          break;
        case 'prompt.queue': {
          const grouped: Record<string, PromptQueueItem[]> = {};
          for (const item of message.items) (grouped[item.threadId] ??= []).push(item);
          setPromptQueueByThread(grouped);
          break;
        }
        case 'prompt.queued':
          setPromptQueueByThread((current) => ({
            ...current,
            [message.threadId]: dedupeQueueItems([...(current[message.threadId] ?? []), message.item]),
          }));
          break;
        case 'prompt.queue.updated':
          setPromptQueueByThread((current) => ({ ...current, [message.threadId]: message.items }));
          break;
        case 'prompt.queue.cancelled':
          setPromptQueueByThread((current) => ({
            ...current,
            [message.threadId]: (current[message.threadId] ?? []).filter((item) => item.id !== message.itemId),
          }));
          break;
        case 'thread.diff':
          setGitDiffByThread((current) => ({ ...current, [message.snapshot.threadId]: message.snapshot }));
          break;
        case 'thread.compaction.accepted':
          if (message.requestId) pendingCompactionRequestsRef.current.delete(message.requestId);
          updateCompactionStatus(message.threadId, { phase: 'requested', message: '上下文压缩请求已受理' });
          break;
        case 'thread.settings.updated':
          setLastError('模型设置已更新');
          break;
        case 'thread': {
          const normalized = normalizeThreadPayload(message.thread);
          if (!normalized.thread) break;
          observeCompactionSnapshot(message.thread, normalized.thread.id);
          const latestTodo = latestPlanMessage(normalized.messages);
          if (latestTodo) setTodoByThread((current) => ({ ...current, [normalized.thread!.id]: latestTodo }));
          replaceThreadsAndSyncAttention(sortThreads(upsertById(threadsRef.current, normalized.thread!)));
          setMessagesByThread((current) => ({
            ...current,
            [normalized.thread!.id]: reconcileMessages(current[normalized.thread!.id] ?? [], normalized.messages, 'append', normalized.thread!.id),
          }));
          if (message.history) setHistoryByThread((current) => ({
            ...current,
            [normalized.thread!.id]: { ...message.history!, loaded: true },
          }));
          setHistoryLoadingByThread((current) => ({ ...current, [normalized.thread!.id]: false }));
          setTurnIds((current) => turnIdsAfterSnapshot(current, normalized.thread!.id, normalized.currentTurnId));
          const activatesThread = consumeThreadActivationIntent(
            pendingThreadStartRequestsRef.current,
            message.requestId,
          );
          if (activatesThread) {
            selectedThreadRef.current = normalized.thread.id;
            setSelectedThreadId(normalized.thread.id);
          }
          if (selectedThreadRef.current === normalized.thread.id) {
            if (normalized.thread.model) setSelectedModelState(normalized.thread.model);
            if (normalized.thread.effort) setSelectedEffortState(normalized.thread.effort);
            if (normalized.thread.permissionMode) setSelectedPermissionModeState(normalized.thread.permissionMode);
          }
          break;
        }
        case 'thread.history': {
          const normalized = normalizeThreadPayload({ thread: { id: message.threadId, turns: message.turns } });
          setMessagesByThread((current) => ({
            ...current,
            [message.threadId]: reconcileMessages(current[message.threadId] ?? [], normalized.messages, 'prepend', message.threadId),
          }));
          setHistoryByThread((current) => ({ ...current, [message.threadId]: { ...message.history, loaded: true } }));
          setHistoryLoadingByThread((current) => ({ ...current, [message.threadId]: false }));
          break;
        }
        case 'turn.started': {
          const turn = record(message.turn);
          const turnId = stringValue(turn?.id, turn?.turnId);
          if (turnId) setTurnIds((current) => ({ ...current, [message.threadId]: turnId }));
          updateThreadState(message.threadId, 'running');
          updateAttentionNotification(message.threadId, 'running');
          break;
        }
        case 'event':
          handleEvent(message.method, message.params);
          break;
        case 'approval': {
          const normalized = normalizeApproval(message.approval);
          setApprovals((current) => {
            const next = upsertById(current, normalized);
            approvalsRef.current = next;
            return next;
          });
          if (normalized.threadId) updateThreadState(normalized.threadId, 'waiting_approval');
          const notificationKey = String(message.approval.requestId);
          if (normalized.threadId) {
            notificationGuardRef.current.invalidate(`attention:${normalized.threadId}`);
            const pendingTimer = attentionNotificationTimersRef.current[normalized.threadId];
            if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
            delete attentionNotificationTimersRef.current[normalized.threadId];
            attentionStateByThreadRef.current[normalized.threadId] = 'waiting_approval';
            delete notifiedAttentionStateByThreadRef.current[normalized.threadId];
            // Cancel unconditionally: an older async coarse schedule may have posted before
            // its Promise callback had a chance to record notifiedAttentionState.
            void queueAttentionCancellation(normalized.threadId, 'approval');
          }
          if (!notifiedApprovalIdsRef.current.has(notificationKey)) {
            notifiedApprovalIdsRef.current.add(notificationKey);
            const ticket = notificationGuardRef.current.begin(`approval:${notificationKey}`);
            void settleGuardedNotification({
              guard: notificationGuardRef.current,
              ticket,
              queue: notificationQueueRef.current,
              operationKey: `approval:${notificationKey}`,
              schedule: () => notifyApprovalRequested(message.approval),
              isRelevant: () => approvalsRef.current.some((approval) => String(approval.wireId) === notificationKey),
              cancel: () => cancelApprovalNotification(notificationKey),
            }).then((result) => {
              if (result === 'shown') return;
              notifiedApprovalIdsRef.current.delete(notificationKey);
              if (result === 'failed') setLastError('Android 审批通知未能发送，请检查通知权限及通知分类的声音设置');
            });
          }
          break;
        }
        case 'approval.resolved': {
          const resolved = approvalsRef.current.find((approval) => approval.wireId === message.approvalRequestId);
          const remaining = approvalsRef.current.filter((approval) => approval.wireId !== message.approvalRequestId);
          approvalsRef.current = remaining;
          setApprovals(remaining);
          const resolvedNotificationKey = String(message.approvalRequestId);
          notificationGuardRef.current.invalidate(`approval:${resolvedNotificationKey}`);
          notifiedApprovalIdsRef.current.delete(resolvedNotificationKey);
          void queueApprovalCancellation(message.approvalRequestId);
          if (resolved?.threadId) {
            const stillWaiting = remaining.some((approval) => approval.threadId === resolved.threadId);
            if (stillWaiting) {
              attentionStateByThreadRef.current[resolved.threadId] = 'waiting_approval';
              updateThreadState(resolved.threadId, 'waiting_approval');
            } else {
              clearThreadAttentionNotification(resolved.threadId);
              if (turnIdsRef.current[resolved.threadId]) updateThreadState(resolved.threadId, 'running');
            }
          }
          break;
        }
        case 'error': {
          const compactionThreadId = message.requestId ? pendingCompactionRequestsRef.current.get(message.requestId) : undefined;
          if (message.requestId) {
            pendingCompactionRequestsRef.current.delete(message.requestId);
            pendingThreadStartRequestsRef.current.delete(message.requestId);
          }
          if (compactionThreadId) reportCompactionFailure(compactionThreadId, `[${message.code}] ${message.message}`);
          else setLastError(`[${message.code}] ${message.message}`);
          break;
        }
        case 'pong':
          break;
      }
      if (typeof message.syncCursor === 'number') syncCursorRef.current = Math.max(syncCursorRef.current, message.syncCursor);
    },
    [clearThreadAttentionNotification, handleEvent, observeCompactionSnapshot, replaceThreadsAndSyncAttention, reportCompactionFailure, updateAttentionNotification, updateCompactionStatus, updateThreadState],
  );
  handleMessageRef.current = handleMessage;

  useEffect(() => {
    if (!config) {
      setPhase('idle');
      return;
    }

    let cancelled = false;
    let socket: RemoteSocket | null = null;
    let appListener: { remove: () => Promise<void> } | null = null;
    cacheHydratedRef.current = false;
    const scope = cacheScope(config.serverUrl, config.pairingToken);
    cacheScopeRef.current = scope;

    setModels([]);
    setSkills([]);
    setSelectedModelState('');
    setSelectedEffortState('');
    setSelectedPermissionModeState('auto');
    setTodoByThread({});
    setPromptQueueByThread({});
    setGitDiffByThread({});
    setApprovals([]);
    approvalsRef.current = [];
    notificationGuardRef.current.reset();
    notifiedApprovalIdsRef.current.clear();
    notifiedTurnIdsRef.current.clear();
    for (const timer of Object.values(attentionNotificationTimersRef.current)) window.clearTimeout(timer);
    attentionNotificationTimersRef.current = {};
    attentionStateByThreadRef.current = {};
    notifiedAttentionStateByThreadRef.current = {};
    setTurnIds({});
    turnIdsRef.current = {};
    setLastError('');
    setCompactionsByThread({});
    compactionsRef.current = {};
    compactionTurnIdsRef.current = {};
    pendingCompactionRequestsRef.current.clear();
    pendingThreadStartRequestsRef.current.clear();
    notifiedCompactionFailuresRef.current.clear();
    seenCompactionItemsRef.current = {};

    void (async () => {
      const cached = await loadRemoteCache(scope);
      if (cancelled) return;
      if (cached) {
        setThreads(cached.threads);
        threadsRef.current = cached.threads;
        setMessagesByThread(cached.messagesByThread);
        setHistoryByThread(cached.historyByThread);
        setSelectedThreadId(cached.selectedThreadId);
        selectedThreadRef.current = cached.selectedThreadId;
        serverIdRef.current = cached.serverId;
        syncVersionRef.current = cached.syncVersion;
        syncCursorRef.current = cached.syncCursor;
        threadIndexVersionRef.current = cached.threadIndexVersion;
      } else {
        setThreads([]);
        threadsRef.current = [];
        setMessagesByThread({});
        setHistoryByThread({});
        setSelectedThreadId(null);
        selectedThreadRef.current = null;
        serverIdRef.current = undefined;
        syncVersionRef.current = undefined;
        syncCursorRef.current = 0;
        threadIndexVersionRef.current = 0;
      }
      setHistoryLoadingByThread({});
      cacheHydratedRef.current = true;

      socket = new RemoteSocket({
        serverUrl: config.serverUrl,
        token: config.pairingToken,
        onMessage: (message) => handleMessageRef.current(message),
        onPhase: (nextPhase, detail) => {
          setPhase(nextPhase);
          setPhaseDetail(detail ?? '');
          if (nextPhase !== 'connected') setCodexReady(false);
        },
      });
      socketRef.current = socket;
      socket.connect();

      appListener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          socket?.reconnectNow();
          for (const thread of threadsRef.current) {
            if (thread.state === 'waiting_approval' || thread.state === 'waiting_input') {
              updateAttentionNotification(thread.id, thread.state);
            }
          }
        }
      });
      if (cancelled) void appListener.remove();
    })();

    return () => {
      cancelled = true;
      socket?.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      void appListener?.remove();
    };
  }, [config, updateAttentionNotification]);

  useEffect(() => {
    if (!config || !cacheHydratedRef.current || !cacheScopeRef.current) return;
    if (cacheSaveTimerRef.current !== null) window.clearTimeout(cacheSaveTimerRef.current);
    const scope = cacheScopeRef.current;
    const epoch = cacheEpochRef.current;
    cacheSaveTimerRef.current = window.setTimeout(() => {
      cacheSaveTimerRef.current = null;
      if (!cacheHydratedRef.current || epoch !== cacheEpochRef.current) return;
      const snapshot: RemoteCacheSnapshot = {
        schema: 4,
        savedAt: Date.now(),
        serverId: serverIdRef.current,
        syncVersion: syncVersionRef.current,
        syncCursor: syncCursorRef.current,
        threadIndexVersion: threadIndexVersionRef.current,
        selectedThreadId,
        threads,
        messagesByThread,
        historyByThread,
      };
      cacheWriteRef.current = cacheWriteRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!cacheHydratedRef.current || epoch !== cacheEpochRef.current) return;
          await saveRemoteCache(scope, snapshot);
        });
    }, 250);
    return () => {
      if (cacheSaveTimerRef.current !== null) window.clearTimeout(cacheSaveTimerRef.current);
    };
  }, [config, historyByThread, messagesByThread, selectedThreadId, threads]);


  const selectThread = useCallback((threadId: string | null) => {
    const previous = selectedThreadRef.current;
    if (previous && previous !== threadId) socketRef.current?.send({ type: 'thread.close', threadId: previous });
    selectedThreadRef.current = threadId;
    setSelectedThreadId(threadId);
    if (!threadId) return;
    setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, unread: 0 } : thread)));
    setHistoryLoadingByThread((current) => ({ ...current, [threadId]: true }));
    const sent = socketRef.current?.send({
      type: 'thread.open', requestId: createRequestId('open'), threadId,
      historyLimit: 20, knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
    });
    if (!sent) setHistoryLoadingByThread((current) => ({ ...current, [threadId]: false }));
    socketRef.current?.send({ type: 'thread.diff.get', requestId: createRequestId('diff'), threadId });
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread?.cwd) socketRef.current?.send({ type: 'skills.list', requestId: createRequestId('skills'), cwd: thread.cwd });
  }, [threads]);

  const loadOlderHistory = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (!threadId) return;
    const history = historyByThreadRef.current[threadId];
    if (!history?.hasMore || historyLoadingByThread[threadId]) return;
    setHistoryLoadingByThread((current) => ({ ...current, [threadId]: true }));
    const sent = socketRef.current?.send({
      type: 'thread.history', requestId: createRequestId('history'), threadId,
      cursor: history.nextCursor ?? undefined, limit: 20,
      knownTurnIds: knownTurnIds(messagesForThread(threadId, messagesByThreadRef.current[threadId] ?? [])),
    });
    if (!sent) setHistoryLoadingByThread((current) => ({ ...current, [threadId]: false }));
  }, [historyLoadingByThread]);

  const sendMessage = useCallback(async (content: string, files: File[] = [], deliveryMode: PromptDeliveryMode = 'auto'): Promise<boolean> => {
    const threadId = selectedThreadRef.current;
    const text = content.trim();
    if (!threadId || (!text && files.length === 0)) return false;

    const appendLocalSystemMessage = (title: string, body: string) => {
      const localMessage: RemoteMessage = {
        id: `local_${title}_${Date.now()}`,
        threadId,
        role: 'system',
        content: body,
        createdAt: Date.now(),
        status: 'complete',
        toolName: title,
        collapsible: true,
      };
      setMessagesByThread((current) => ({ ...current, [threadId]: [...messagesForThread(threadId, current[threadId] ?? []), localMessage] }));
    };

    const downloadMatch = text.match(/^\/download\s+(.+)$/i);
    if (downloadMatch) {
      if (!config) return false;
      try {
        const result = await saveHostFile({ serverUrl: config.serverUrl, token: config.pairingToken }, downloadMatch[1]!.trim());
        appendLocalSystemMessage('文件下载', `${result.fileName} · ${result.size.toLocaleString('zh-CN')} bytes`);
        return true;
      } catch (error) {
        setLastError(error instanceof Error ? error.message : '文件下载失败');
        return false;
      }
    }

    if (text === '/compact') {
      const requestId = createRequestId('compact');
      pendingCompactionRequestsRef.current.set(requestId, threadId);
      updateCompactionStatus(threadId, { phase: 'requested', message: '正在请求上下文压缩', automatic: false });
      const sent = socketRef.current?.send({ type: 'thread.compact', requestId, threadId });
      if (!sent) {
        pendingCompactionRequestsRef.current.delete(requestId);
        reportCompactionFailure(threadId, '当前未连接，无法压缩上下文');
      }
      return Boolean(sent);
    }
    if (text === '/status') {
      const thread = threads.find((candidate) => candidate.id === threadId);
      const elapsed = thread?.currentTurnStartedAt ? Math.max(0, Date.now() - thread.currentTurnStartedAt) : undefined;
      appendLocalSystemMessage('会话状态', [
        `状态：${threadStateLabel(thread?.state ?? 'idle')}`,
        `目录：${thread?.cwd || '未知'}`,
        `模型：${selectedModel || '主机默认'}${selectedEffort ? ` · ${selectedEffort}` : ''}`,
        elapsed != null ? `本轮已用时：${Math.floor(elapsed / 1000)} 秒` : '',
        thread?.tokenUsage ? `Token：${thread.tokenUsage.totalTokens.toLocaleString('zh-CN')}（输入 ${thread.tokenUsage.inputTokens.toLocaleString('zh-CN')} / 输出 ${thread.tokenUsage.outputTokens.toLocaleString('zh-CN')}）` : '',
      ].filter(Boolean).join('\n'));
      return true;
    }
    if (text === '/help') {
      appendLocalSystemMessage('手机命令', [
        '/status — 状态、目录、模型、计时和 Token',
        '/compact — 压缩当前上下文',
        '/download <电脑绝对路径> — 下载允许目录内的文件',
        '输入框 ＋ — 上传图片或文件并随任务发送',
        '/models — 列出主机报告的模型',
        '/model:<id> — 切换当前任务模型',
        '/effort:<level> — 切换思考强度',
        '/skills — 列出当前目录技能',
        '/skill:<name> <任务> — 带指定技能开始一轮',
      ].join('\n'));
      return true;
    }
    if (text === '/models') {
      appendLocalSystemMessage('可用模型', models.filter((model) => !model.hidden).map((model) => `${model.model}${model.isDefault ? '（默认）' : ''} — ${model.displayName}`).join('\n') || '主机未返回模型列表');
      return true;
    }
    if (text === '/skills') {
      appendLocalSystemMessage('目录技能', skills.filter((skill) => skill.enabled).map((skill) => `${skill.name} — ${skill.shortDescription || skill.description}`).join('\n') || '当前目录没有启用的技能');
      return true;
    }

    const modelMatch = text.match(/^\/model(?::|\s+)([^\s]+)$/i);
    if (modelMatch) {
      const requested = modelMatch[1] ?? '';
      const model = models.find((candidate) => candidate.model.toLowerCase() === requested.toLowerCase() || candidate.id.toLowerCase() === requested.toLowerCase());
      if (!model) {
        setLastError(`未找到模型：${requested}`);
        return false;
      }
      const effort = model.defaultReasoningEffort ?? '';
      const sent = socketRef.current?.send({
        type: 'thread.settings',
        requestId: createRequestId('settings'),
        threadId,
        model: model.model,
        ...(effort ? { effort } : {}),
        summary: 'concise',
        permissionMode: selectedPermissionMode,
      });
      if (!sent) return false;
      setSelectedModelState(model.model);
      setSelectedEffortState(effort);
      appendLocalSystemMessage('模型已切换', `${model.displayName || model.model}${effort ? ` · ${effort}` : ''}`);
      return true;
    }

    const effortMatch = text.match(/^\/effort(?::|\s+)([^\s]+)$/i);
    if (effortMatch) {
      const requested = effortMatch[1] ?? '';
      const activeModel = models.find((candidate) => candidate.model === selectedModel || candidate.id === selectedModel);
      const supported = activeModel?.supportedReasoningEfforts.some((option) => option.reasoningEffort === requested);
      if (activeModel && !supported) {
        setLastError(`模型 ${activeModel.displayName || activeModel.model} 不支持思考强度：${requested}`);
        return false;
      }
      const sent = socketRef.current?.send({
        type: 'thread.settings',
        requestId: createRequestId('settings'),
        threadId,
        ...(selectedModel ? { model: selectedModel } : {}),
        effort: requested,
        summary: 'concise',
        permissionMode: selectedPermissionMode,
      });
      if (!sent) return false;
      setSelectedEffortState(requested);
      appendLocalSystemMessage('思考强度已切换', requested);
      return true;
    }

    let prompt = text;
    let skill: SkillOption | undefined;
    const skillMatch = text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/i);
    if (skillMatch) {
      skill = skills.find((candidate) => candidate.name.toLowerCase() === skillMatch[1]?.toLowerCase());
      if (!skill) {
        setLastError(`未找到技能：${skillMatch[1]}`);
        return false;
      }
      prompt = skillMatch[2]?.trim() || `请使用 ${skill.name} 技能处理当前任务。`;
    }

    const attachments: Array<{ type: 'image' | 'file'; uploadId: string; fileName: string; mimeType: string; localPath?: string }> = [];
    if (files.length > 0) {
      if (!config) return false;
      try {
        for (const file of files) {
          const upload = await uploadRemoteFile({
            serverUrl: config.serverUrl,
            token: config.pairingToken,
            file,
            fileName: file.name,
          });
          attachments.push({
            type: upload.mimeType.startsWith('image/') ? 'image' : 'file',
            uploadId: upload.uploadId,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            localPath: upload.path,
          });
        }
      } catch (error) {
        setLastError(error instanceof Error ? error.message : '文件上传失败');
        return false;
      }
    }

    const requestId = createRequestId('turn');
    const clientUserMessageId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : createRequestId('message');
    const sent = socketRef.current?.send({
      type: 'turn.start',
      requestId,
      threadId,
      text: prompt || `请查看我上传的 ${attachments.length} 个文件。`,
      clientUserMessageId,
      deliveryMode,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(skill ? { skill: { name: skill.name, path: skill.path } } : {}),
      ...(attachments.length ? { attachments } : {}),
      summary: 'concise',
      permissionMode: selectedPermissionMode,
    });
    if (!sent) {
      setLastError('当前未连接，消息没有发送');
      return false;
    }
    if (deliveryMode !== 'queue') {
      const optimistic: RemoteMessage = {
        id: `local_${requestId}`,
        threadId,
        turnId: turnIdsRef.current[threadId],
        role: 'user',
        content: prompt || `请查看我上传的 ${attachments.length} 个文件。`,
        createdAt: Date.now(),
        status: 'complete',
        ...(attachments.length ? { attachments: optimisticAttachmentsFromUploads(attachments) } : {}),
        detail: { clientUserMessageId },
      };
      setMessagesByThread((current) => ({
        ...current,
        [threadId]: [...messagesForThread(threadId, current[threadId] ?? []), optimistic],
      }));
      updateThreadState(threadId, 'running');
    }
    return true;
  }, [config, models, reportCompactionFailure, selectedEffort, selectedModel, selectedPermissionMode, skills, threads, updateCompactionStatus, updateThreadState]);

  const refreshGitDiff = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({ type: 'thread.diff.get', requestId: createRequestId('diff'), threadId });
  }, []);

  const resumePromptQueue = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({ type: 'prompt.queue.resume', requestId: createRequestId('queue-resume'), threadId });
  }, []);

  const cancelQueuedPrompt = useCallback((itemId: string) => {
    socketRef.current?.send({ type: 'prompt.queue.cancel', requestId: createRequestId('queue-cancel'), itemId });
  }, []);

  const promoteQueuedPrompt = useCallback((itemId: string) => {
    socketRef.current?.send({ type: 'prompt.queue.promote', requestId: createRequestId('queue-promote'), itemId });
  }, []);

  const interrupt = useCallback(() => {
    const threadId = selectedThreadRef.current;
    if (!threadId) return;
    const turnId = turnIds[threadId];
    if (!turnId) {
      setLastError('尚未收到当前 turnId，暂时无法中断');
      return;
    }
    socketRef.current?.send({
      type: 'turn.interrupt',
      requestId: createRequestId('interrupt'),
      threadId,
      turnId,
    });
  }, [turnIds]);

  const resolveApproval = useCallback((approvalId: string, decision: ApprovalDecision) => {
    const approval = approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) return;
    const sent = socketRef.current?.send({
      type: 'approval.resolve',
      requestId: createRequestId('approval'),
      approvalRequestId: approval.wireId,
      decision,
    });
    if (sent) {
      setApprovals((current) => current.filter((candidate) => candidate.id !== approvalId));
      notifiedApprovalIdsRef.current.delete(String(approval.wireId));
      void queueApprovalCancellation(approval.wireId);
      if (approval.threadId && turnIdsRef.current[approval.threadId]) {
        updateThreadState(approval.threadId, 'running');
      }
    }
  }, [approvals, queueApprovalCancellation, updateThreadState]);

  const startThread = useCallback((cwd: string, model?: string, modelProvider?: string) => {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd.startsWith('/')) {
      setLastError('工作目录必须是电脑上的绝对路径');
      return false;
    }
    const requestId = createRequestId('thread');
    pendingThreadStartRequestsRef.current.add(requestId);
    const sent = socketRef.current?.send({
      type: 'thread.start',
      requestId,
      cwd: normalizedCwd,
      ...(model?.trim() ? { model: model.trim() } : {}),
      ...(modelProvider?.trim() ? { modelProvider: modelProvider.trim() } : {}),
    });
    if (!sent) pendingThreadStartRequestsRef.current.delete(requestId);
    return Boolean(sent);
  }, []);

  const selectModel = useCallback((modelId: string) => {
    setSelectedModelState(modelId);
    const model = models.find((candidate) => candidate.model === modelId || candidate.id === modelId);
    const effort = model?.defaultReasoningEffort ?? '';
    setSelectedEffortState(effort);
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({
      type: 'thread.settings',
      requestId: createRequestId('settings'),
      threadId,
      model: modelId,
      ...(effort ? { effort } : {}),
      summary: 'concise',
    });
  }, [models]);

  const selectEffort = useCallback((effort: string) => {
    setSelectedEffortState(effort);
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({
      type: 'thread.settings',
      requestId: createRequestId('settings'),
      threadId,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(effort ? { effort } : {}),
      summary: 'concise',
    });
  }, [selectedModel]);

  const selectPermissionMode = useCallback((permissionMode: PermissionMode) => {
    setSelectedPermissionModeState(permissionMode);
    const threadId = selectedThreadRef.current;
    if (threadId) socketRef.current?.send({
      type: 'thread.settings',
      requestId: createRequestId('settings'),
      threadId,
      permissionMode,
    });
  }, []);

  const loadHostAttachment = useCallback(async (path: string) => {
    if (!config) throw new Error('尚未配置 Host 连接。');
    const result = await downloadHostFile({ serverUrl: config.serverUrl, token: config.pairingToken }, path);
    return { ...result, url: URL.createObjectURL(result.blob) };
  }, [config]);

  const downloadHostAttachment = useCallback(async (path: string) => {
    if (!config) return;
    try {
      await saveHostFile({ serverUrl: config.serverUrl, token: config.pairingToken }, path);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : '附件下载失败');
    }
  }, [config]);

  const fullRefresh = useCallback(async () => {
    if (cacheSaveTimerRef.current !== null) {
      window.clearTimeout(cacheSaveTimerRef.current);
      cacheSaveTimerRef.current = null;
    }
    cacheHydratedRef.current = false;
    cacheEpochRef.current += 1;
    await cacheWriteRef.current.catch(() => undefined);
    await clearRemoteCache();

    setThreads([]);
    threadsRef.current = [];
    setMessagesByThread({});
    messagesByThreadRef.current = {};
    setHistoryByThread({});
    historyByThreadRef.current = {};
    setHistoryLoadingByThread({});
    setTodoByThread({});
    setPromptQueueByThread({});
    setGitDiffByThread({});
    setApprovals([]);
    approvalsRef.current = [];
    notificationGuardRef.current.reset();
    notifiedApprovalIdsRef.current.clear();
    notifiedTurnIdsRef.current.clear();
    for (const timer of Object.values(attentionNotificationTimersRef.current)) window.clearTimeout(timer);
    attentionNotificationTimersRef.current = {};
    attentionStateByThreadRef.current = {};
    notifiedAttentionStateByThreadRef.current = {};
    setTurnIds({});
    turnIdsRef.current = {};
    itemStartedAtRef.current = {};
    setCompactionsByThread({});
    compactionsRef.current = {};
    compactionTurnIdsRef.current = {};
    pendingCompactionRequestsRef.current.clear();
    pendingThreadStartRequestsRef.current.clear();
    notifiedCompactionFailuresRef.current.clear();
    seenCompactionItemsRef.current = {};
    serverIdRef.current = undefined;
    syncVersionRef.current = undefined;
    syncCursorRef.current = 0;
    threadIndexVersionRef.current = 0;
    cacheHydratedRef.current = true;
    setPhaseDetail('本地缓存已清空，正在从 Host 全量重新载入');
    socketRef.current?.reconnectNow();
  }, []);

  const reconnect = useCallback(() => socketRef.current?.reconnectNow(), []);
  const dismissError = useCallback(() => setLastError(''), []);
  const dismissCompaction = useCallback((threadId: string) => {
    setCompactionsByThread((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      compactionsRef.current = next;
      return next;
    });
  }, []);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );
  const selectedMessagesSelectorRef = useRef<SelectedMessagesSelector | null>(null);
  if (!selectedMessagesSelectorRef.current) selectedMessagesSelectorRef.current = createSelectedMessagesSelector();
  const selectedMessages = selectedMessagesSelectorRef.current(selectedThreadId, messagesByThread, todoByThread);
  const selectedCompaction = selectedThreadId ? (compactionsByThread[selectedThreadId] ?? null) : null;
  const selectedPromptQueue = selectedThreadId ? (promptQueueByThread[selectedThreadId] ?? []) : [];
  const selectedGitDiff = selectedThreadId ? (gitDiffByThread[selectedThreadId] ?? null) : null;
  const selectedSubagents = useMemo(
    () => selectedThreadId ? threads.filter((thread) => thread.parentThreadId === selectedThreadId) : [],
    [selectedThreadId, threads],
  );
  const selectedApprovals = useMemo(
    () => approvals.filter((approval) => !approval.threadId || approval.threadId === selectedThreadId),
    [approvals, selectedThreadId],
  );
  const running = selectedThread?.state === 'running';
  const canInterrupt = Boolean(selectedThreadId && turnIds[selectedThreadId]);

  return {
    phase,
    phaseDetail,
    codexReady,
    models,
    skills,
    selectedModel,
    selectedEffort,
    selectedPermissionMode,
    threads,
    selectedThread,
    selectedThreadId,
    selectedMessages,
    selectedHistory: selectedThreadId ? (historyByThread[selectedThreadId] ?? null) : null,
    historyLoading: selectedThreadId ? Boolean(historyLoadingByThread[selectedThreadId]) : false,
    selectedCompaction,
    selectedPromptQueue,
    selectedGitDiff,
    selectedSubagents,
    selectedTurnId: selectedThreadId ? turnIds[selectedThreadId] : undefined,
    selectedApprovals,
    running,
    canInterrupt,
    lastError,
    selectThread,
    loadOlderHistory,
    sendMessage,
    cancelQueuedPrompt,
    promoteQueuedPrompt,
    resumePromptQueue,
    refreshGitDiff,
    loadHostAttachment,
    downloadHostAttachment,
    interrupt,
    resolveApproval,
    startThread,
    selectModel,
    selectEffort,
    selectPermissionMode,
    reconnect,
    fullRefresh,
    dismissError,
    dismissCompaction,
  };
}

export function dedupeQueueItems(items: PromptQueueItem[]): PromptQueueItem[] {
  const byClientId = new Map<string, PromptQueueItem>();
  for (const item of items) byClientId.set(`${item.threadId}:${item.clientUserMessageId}`, item);
  return [...byClientId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function threadStateLabel(state: ThreadState): string {
  switch (state) {
    case 'running':
      return '执行中';
    case 'waiting_approval':
      return '待审批';
    case 'waiting_input':
      return '待输入';
    case 'error':
      return '异常';
    case 'idle':
      return '可继续';
    case 'not_loaded':
      return '未载入';
    default:
      return '等待同步';
  }
}
