import { Capacitor } from '@capacitor/core';
import { CodexBackground } from './background';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { WireApprovalRequest } from '../types/protocol';

const EVENTS_CHANNEL = 'codex-events';
const APPROVAL_CHANNEL = 'codex-approvals';
let initialized = false;
let permissionGranted = false;

function notificationId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash || 1);
}

export async function initializeNotifications(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  if (initialized) return permissionGranted;
  initialized = true;
  try {
    let permissions = await LocalNotifications.checkPermissions();
    if (permissions.display === 'prompt' || permissions.display === 'prompt-with-rationale') {
      permissions = await LocalNotifications.requestPermissions();
    }
    permissionGranted = permissions.display === 'granted';
    if (!permissionGranted) return false;
    await LocalNotifications.createChannel({
      id: EVENTS_CHANNEL,
      name: 'Codex 任务事件',
      description: '任务完成、失败和中断通知',
      importance: 3,
      visibility: 1,
    });
    await LocalNotifications.createChannel({
      id: APPROVAL_CHANNEL,
      name: 'Codex 等待确认',
      description: '命令、文件和权限审批通知',
      importance: 5,
      visibility: 1,
      vibration: true,
    });
    return true;
  } catch {
    permissionGranted = false;
    return false;
  }
}

export async function notifyTurnFinished(options: {
  threadId: string;
  threadTitle: string;
  status: string;
  durationMs?: number;
}): Promise<void> {
  if (!(await initializeNotifications())) return;
  const status = options.status.toLowerCase();
  const title = status === 'failed' ? 'Codex 执行失败' : status === 'interrupted' ? 'Codex 已中断' : 'Codex 已完成';
  const duration = options.durationMs != null ? ` · ${formatDuration(options.durationMs)}` : '';
  if (Capacitor.isNativePlatform()) {
    try {
      await CodexBackground.notifyCompletion({
        threadId: options.threadId,
        title,
        text: `${options.threadTitle}${duration}`,
        action: 'openThread',
      });
      return;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  await LocalNotifications.schedule({
    notifications: [{
      id: notificationId(`turn:${options.threadId}`),
      title,
      body: `${options.threadTitle}${duration}`,
      channelId: EVENTS_CHANNEL,
      extra: { type: 'turn', threadId: options.threadId },
    }],
  });
}

export async function notifyCompactionFailed(options: {
  threadId: string;
  threadTitle: string;
  message: string;
}): Promise<void> {
  if (!(await initializeNotifications())) return;
  const title = 'Codex 上下文压缩失败';
  const body = `${options.threadTitle} · ${options.message}`;
  if (Capacitor.isNativePlatform()) {
    try {
      await CodexBackground.notifyCompletion({
        threadId: options.threadId,
        title,
        text: body,
        action: 'openThread',
      });
      return;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  await LocalNotifications.schedule({
    notifications: [{
      id: notificationId(`compaction:${options.threadId}`),
      title,
      body,
      largeBody: options.message,
      channelId: EVENTS_CHANNEL,
      extra: { type: 'compaction-failed', threadId: options.threadId },
    }],
  });
}

export async function notifyApprovalRequested(approval: WireApprovalRequest): Promise<void> {
  if (!(await initializeNotifications())) return;
  const title = approval.method.includes('fileChange')
    ? 'Codex 等待文件修改确认'
    : approval.method.includes('permissions')
      ? 'Codex 请求额外权限'
      : 'Codex 等待命令确认';
  if (Capacitor.isNativePlatform()) {
    try {
      await CodexBackground.notifyApproval({
        threadId: approval.threadId || 'global',
        title,
        text: approval.command || approval.reason || approval.detail || '打开 App 查看详情并确认。',
        action: 'openApproval',
        notificationId: notificationId(`approval:${String(approval.requestId)}`),
      });
      return;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  await LocalNotifications.schedule({
    notifications: [{
      id: notificationId(`approval:${String(approval.requestId)}`),
      title,
      body: approval.command || approval.reason || approval.detail || '打开 App 查看详情并确认。',
      largeBody: approval.detail || approval.command,
      channelId: APPROVAL_CHANNEL,
      extra: { type: 'approval', requestId: String(approval.requestId), threadId: approval.threadId },
    }],
  });
}

export async function cancelApprovalNotification(requestId: string | number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const id = notificationId(`approval:${String(requestId)}`);
  try {
    await CodexBackground.cancelNotification({ notificationId: id });
  } catch {
    // Continue with the LocalNotifications fallback.
  }
  try {
    await LocalNotifications.cancel({ notifications: [{ id }] });
    const delivered = await LocalNotifications.getDeliveredNotifications();
    const matching = delivered.notifications.filter((notification) => notification.id === id);
    if (matching.length) await LocalNotifications.removeDeliveredNotifications({ notifications: matching });
  } catch {
    // Notification may already have been dismissed.
  }
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}
