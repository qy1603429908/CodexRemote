import { Capacitor } from '@capacitor/core';
import { CodexBackground } from './background';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { WireApprovalRequest } from '../types/protocol';

const COMPLETION_CHANNEL = 'codex_completions_v4';
const APPROVAL_CHANNEL = 'codex_approvals_v4';
const INPUT_CHANNEL = 'codex_inputs_v1';
const COMPLETION_SOUND = 'codex_completion.wav';
const APPROVAL_SOUND = 'codex_approval.wav';
const INPUT_SOUND = 'codex_input.wav';
let initializationPromise: Promise<boolean> | null = null;

function notificationId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  if (hash === -2147483648) return 1;
  return Math.abs(hash || 1);
}

export async function initializeNotifications(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    try {
      let permissions = await LocalNotifications.checkPermissions();
      if (permissions.display === 'prompt' || permissions.display === 'prompt-with-rationale') {
        permissions = await LocalNotifications.requestPermissions();
      }
      if (permissions.display !== 'granted') return false;
      await LocalNotifications.createChannel({
        id: COMPLETION_CHANNEL,
        name: 'Codex 任务事件',
        description: '任务完成、失败和中断通知',
        importance: 5,
        visibility: 1,
        vibration: true,
        sound: COMPLETION_SOUND,
      });
      await LocalNotifications.createChannel({
        id: APPROVAL_CHANNEL,
        name: 'Codex 等待审批',
        description: '命令、文件和权限审批通知',
        importance: 5,
        visibility: 1,
        vibration: true,
        sound: APPROVAL_SOUND,
      });
      await LocalNotifications.createChannel({
        id: INPUT_CHANNEL,
        name: 'Codex 等待输入',
        description: '任务等待用户补充输入的通知',
        importance: 5,
        visibility: 1,
        vibration: true,
        sound: INPUT_SOUND,
      });
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await initializationPromise;
  } finally {
    // Notification permission/channel state can change while the WebView remains alive.
    // Never permanently cache an early denial, startup race or vendor-specific failure.
    initializationPromise = null;
  }
}

export async function notifyTurnFinished(options: {
  threadId: string;
  threadTitle: string;
  status: string;
  durationMs?: number;
  eventId?: string;
}): Promise<boolean> {
  if (!(await initializeNotifications())) return false;
  const status = options.status.toLowerCase();
  const title = status === 'failed' ? 'Codex 执行失败' : status === 'interrupted' ? 'Codex 已中断' : 'Codex 已完成';
  const duration = options.durationMs != null ? ` · ${formatDuration(options.durationMs)}` : '';
  const id = notificationId(`turn:${options.threadId}:${options.eventId ?? 'latest'}`);
  if (Capacitor.isNativePlatform()) {
    try {
      await CodexBackground.notifyCompletion({
        threadId: options.threadId,
        title,
        text: `${options.threadTitle}${duration}`,
        action: 'openThread',
        notificationId: id,
      });
      return true;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title,
        body: `${options.threadTitle}${duration}`,
        channelId: COMPLETION_CHANNEL,
        sound: COMPLETION_SOUND,
        extra: { type: 'turn', threadId: options.threadId },
      }],
    });
    return true;
  } catch {
    return false;
  }
}

export async function notifyCompactionFailed(options: {
  threadId: string;
  threadTitle: string;
  message: string;
}): Promise<boolean> {
  if (!(await initializeNotifications())) return false;
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
      return true;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: notificationId(`compaction:${options.threadId}`),
        title,
        body,
        largeBody: options.message,
        channelId: COMPLETION_CHANNEL,
        sound: COMPLETION_SOUND,
        extra: { type: 'compaction-failed', threadId: options.threadId },
      }],
    });
    return true;
  } catch {
    return false;
  }
}

export async function notifyApprovalRequested(approval: WireApprovalRequest): Promise<boolean> {
  if (!(await initializeNotifications())) return false;
  const title = approval.method.includes('mcpServer/elicitation')
    ? 'Codex 等待 Computer Use 确认'
    : approval.method.includes('fileChange')
      ? 'Codex 等待文件修改确认'
      : approval.method.includes('permissions')
        ? 'Codex 请求额外权限'
        : 'Codex 等待命令确认';
  const body = approval.command || approval.reason || approval.detail || '打开 App 查看详情并确认。';
  const id = notificationId(`approval:${String(approval.requestId)}`);
  if (Capacitor.isNativePlatform()) {
    try {
      await CodexBackground.notifyApproval({
        threadId: approval.threadId || 'global',
        title,
        text: body,
        action: 'openApproval',
        notificationId: id,
      });
      return true;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title,
        body,
        largeBody: approval.detail || approval.command,
        channelId: APPROVAL_CHANNEL,
        sound: APPROVAL_SOUND,
        extra: { type: 'approval', requestId: String(approval.requestId), threadId: approval.threadId },
      }],
    });
    return true;
  } catch {
    return false;
  }
}

export async function notifyThreadAttention(options: {
  threadId: string;
  threadTitle: string;
  kind: 'approval' | 'input';
}): Promise<boolean> {
  if (!(await initializeNotifications())) return false;
  const id = notificationId(`attention:${options.kind}:${options.threadId}`);
  const title = options.kind === 'input' ? 'Codex 等待你的输入' : 'Codex 等待审批';
  const body = `${options.threadTitle} · 打开 App 继续处理。`;
  if (Capacitor.isNativePlatform()) {
    try {
      await CodexBackground.notifyApproval({
        threadId: options.threadId,
        title,
        text: body,
        action: options.kind === 'input' ? 'openThread' : 'openApproval',
        alertKind: options.kind,
        notificationId: id,
      });
      return true;
    } catch {
      // Fall back to Capacitor LocalNotifications.
    }
  }
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id,
        title,
        body,
        channelId: options.kind === 'input' ? INPUT_CHANNEL : APPROVAL_CHANNEL,
        sound: options.kind === 'input' ? INPUT_SOUND : APPROVAL_SOUND,
        extra: { type: `attention-${options.kind}`, threadId: options.threadId },
      }],
    });
    return true;
  } catch {
    return false;
  }
}

export async function cancelApprovalNotification(requestId: string | number): Promise<void> {
  await cancelNotificationById(notificationId(`approval:${String(requestId)}`));
}

export async function cancelThreadAttentionNotification(threadId: string, kind: 'approval' | 'input'): Promise<void> {
  await cancelNotificationById(notificationId(`attention:${kind}:${threadId}`));
}

async function cancelNotificationById(id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await CodexBackground.cancelNotification({ notificationId: id });
    return;
  } catch {
    // Continue with the LocalNotifications fallback only when the native path failed.
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
