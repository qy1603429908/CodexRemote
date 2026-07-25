import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { RemoteConfig } from './configStore';

export interface BackgroundAction {
  threadId?: string;
  action?: string;
  kind?: 'approval' | 'completion' | 'background';
  nonce?: string;
}

interface CodexBackgroundPluginApi {
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  getStatus(): Promise<{ running: boolean; notificationsGranted: boolean; sdkInt: number }>;
  start(options: { title?: string; text?: string; threadId?: string; action?: string; serverUrl?: string }): Promise<{ running: boolean }>;
  update(options: { title?: string; text?: string; threadId?: string; action?: string }): Promise<{ running: boolean }>;
  stop(): Promise<{ running: boolean }>;
  notifyApproval(options: { threadId: string; title?: string; text?: string; action?: string; notificationId?: number }): Promise<void>;
  notifyCompletion(options: { threadId: string; title?: string; text?: string; action?: string; notificationId?: number }): Promise<void>;
  cancelNotification(options: { notificationId?: number; kind?: string; threadId?: string }): Promise<void>;
  consumePendingAction(): Promise<{ action: BackgroundAction | null }>;
  addListener(eventName: 'notificationAction', listener: (event: BackgroundAction) => void): Promise<PluginListenerHandle>;
}

export const CodexBackground = registerPlugin<CodexBackgroundPluginApi>('CodexBackground');

export async function startBackgroundRuntime(config: RemoteConfig, threadId?: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const permission = await CodexBackground.requestNotificationPermission();
    if (!permission.granted) return false;
    await CodexBackground.start({
      title: 'Codex Mobile Remote',
      text: `后台连接已启用 · ${new URL(config.serverUrl).host}`,
      threadId,
      action: threadId ? 'openThread' : 'openBackground',
      serverUrl: config.serverUrl,
    });
    return true;
  } catch {
    return false;
  }
}

export async function updateBackgroundThread(threadId?: string, title?: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await CodexBackground.update({
      title: 'Codex Mobile Remote',
      text: title ? `后台同步 · ${title}` : '后台连接与审批提醒已启用',
      threadId,
      action: threadId ? 'openThread' : 'openBackground',
    });
  } catch {
    // The service may not have been started because notification permission was denied.
  }
}
