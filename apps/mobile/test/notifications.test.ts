import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationGenerationGuard, NotificationOperationQueue, settleGuardedNotification } from '../src/lib/notificationGuard';

const mocks = vi.hoisted(() => ({
  native: true,
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  getDeliveredNotifications: vi.fn(),
  removeDeliveredNotifications: vi.fn(),
  notifyApproval: vi.fn(),
  notifyCompletion: vi.fn(),
  cancelNotification: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: mocks.checkPermissions,
    requestPermissions: mocks.requestPermissions,
    createChannel: mocks.createChannel,
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    getDeliveredNotifications: mocks.getDeliveredNotifications,
    removeDeliveredNotifications: mocks.removeDeliveredNotifications,
  },
}));

vi.mock('../src/lib/background', () => ({
  CodexBackground: {
    notifyApproval: mocks.notifyApproval,
    notifyCompletion: mocks.notifyCompletion,
    cancelNotification: mocks.cancelNotification,
  },
}));

import {
  cancelThreadAttentionNotification,
  initializeNotifications,
  notifyApprovalRequested,
  notifyThreadAttention,
  notifyTurnFinished,
} from '../src/lib/notifications';

beforeEach(() => {
  mocks.native = true;
  vi.clearAllMocks();
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.requestPermissions.mockResolvedValue({ display: 'granted' });
  mocks.createChannel.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.getDeliveredNotifications.mockResolvedValue({ notifications: [] });
  mocks.removeDeliveredNotifications.mockResolvedValue(undefined);
  mocks.notifyApproval.mockResolvedValue(undefined);
  mocks.notifyCompletion.mockResolvedValue(undefined);
  mocks.cancelNotification.mockResolvedValue(undefined);
});

describe('Android notification initialization', () => {
  it('shares an in-flight permission request and creates three differentiated audible channels', async () => {
    let resolvePermission: (value: { display: string }) => void = () => undefined;
    mocks.checkPermissions.mockReturnValue(new Promise((resolve) => { resolvePermission = resolve; }));

    const first = initializeNotifications();
    const second = initializeNotifications();
    resolvePermission({ display: 'granted' });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mocks.checkPermissions).toHaveBeenCalledTimes(1);
    expect(mocks.createChannel).toHaveBeenCalledTimes(3);
    expect(mocks.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex_completions_v4', importance: 5, sound: 'codex_completion.wav', vibration: true,
    }));
    expect(mocks.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex_approvals_v4', importance: 5, sound: 'codex_approval.wav', vibration: true,
    }));
    expect(mocks.createChannel).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex_inputs_v1', importance: 5, sound: 'codex_input.wav', vibration: true,
    }));
  });

  it('does not permanently cache an initialization failure', async () => {
    mocks.checkPermissions.mockRejectedValueOnce(new Error('activity not ready'));
    await expect(initializeNotifications()).resolves.toBe(false);
    mocks.checkPermissions.mockResolvedValueOnce({ display: 'granted' });
    await expect(initializeNotifications()).resolves.toBe(true);
    expect(mocks.checkPermissions).toHaveBeenCalledTimes(2);
  });
});

describe('Android task and attention alerts', () => {
  it('posts task completion through the audible native completion channel path', async () => {
    await expect(notifyTurnFinished({
      threadId: 'thread-1', threadTitle: 'Build Android', status: 'completed', durationMs: 61_000,
    })).resolves.toBe(true);
    expect(mocks.notifyCompletion).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-1', title: 'Codex 已完成', text: 'Build Android · 1 分 1 秒',
    }));
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('falls back to a local notification with the bundled sound', async () => {
    mocks.notifyCompletion.mockRejectedValueOnce(new Error('native unavailable'));
    await expect(notifyTurnFinished({
      threadId: 'thread-2', threadTitle: 'Review', status: 'failed',
    })).resolves.toBe(true);
    expect(mocks.schedule).toHaveBeenCalledWith({ notifications: [expect.objectContaining({
      channelId: 'codex_completions_v4', sound: 'codex_completion.wav', title: 'Codex 执行失败',
    })] });
  });

  it('does not invoke the Capacitor fallback when native cancellation succeeds', async () => {
    await expect(cancelThreadAttentionNotification('thread-native', 'approval')).resolves.toBeUndefined();
    expect(mocks.cancelNotification).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.getDeliveredNotifications).not.toHaveBeenCalled();
  });

  it('uses the Capacitor fallback only when native cancellation fails', async () => {
    mocks.cancelNotification.mockRejectedValueOnce(new Error('native unavailable'));
    mocks.getDeliveredNotifications.mockResolvedValueOnce({ notifications: [{ id: 123 }, { id: 456 }] });

    await expect(cancelThreadAttentionNotification('thread-fallback', 'input')).resolves.toBeUndefined();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.getDeliveredNotifications).toHaveBeenCalledTimes(1);
  });

  it('posts explicit approvals and waiting-for-input state as urgent alerts', async () => {
    await expect(notifyApprovalRequested({
      requestId: 'approval-1', threadId: 'thread-3', method: 'permissions/request', reason: '需要完整访问',
    })).resolves.toBe(true);
    await expect(notifyThreadAttention({
      threadId: 'thread-3', threadTitle: 'Windows audit', kind: 'input',
    })).resolves.toBe(true);
    await expect(notifyApprovalRequested({
      requestId: 'computer-use-1', threadId: 'thread-3', method: 'mcpServer/elicitation/request', detail: 'Allow Computer Use?',
    })).resolves.toBe(true);

    expect(mocks.notifyApproval).toHaveBeenCalledTimes(3);
    expect(mocks.notifyApproval).toHaveBeenNthCalledWith(1, expect.objectContaining({
      threadId: 'thread-3', title: 'Codex 请求额外权限', action: 'openApproval',
    }));
    expect(mocks.notifyApproval).toHaveBeenNthCalledWith(2, expect.objectContaining({
      threadId: 'thread-3', title: 'Codex 等待你的输入', action: 'openThread', alertKind: 'input',
    }));
    expect(mocks.notifyApproval).toHaveBeenNthCalledWith(3, expect.objectContaining({
      threadId: 'thread-3', title: 'Codex 等待 Computer Use 确认', action: 'openApproval',
    }));
  });
});


describe('packaged Android notification channels', () => {
  it('uses immutable differentiated channel IDs and bundled alert sounds natively', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'android/app/src/main/java/dev/codexmobile/remote/CodexNotificationChannels.java',
    ), 'utf8');

    expect(source).toContain('codex_approvals_v4');
    expect(source).toContain('codex_inputs_v1');
    expect(source).toContain('codex_completions_v4');
    expect(source.match(/NotificationManager\.IMPORTANCE_HIGH/g)).toHaveLength(3);
    expect(source).toContain('R.raw.codex_approval');
    expect(source).toContain('R.raw.codex_input');
    expect(source).toContain('R.raw.codex_completion');
    expect(source.match(/\.setSound\(rawSoundUri\(context, R\.raw\./g)).toHaveLength(3);
    expect(source).toContain('AudioAttributes.USAGE_NOTIFICATION_EVENT');
    expect(source).toContain('Build.VERSION_CODES.UPSIDE_DOWN_CAKE');
    expect(source).toContain('new MediaPlayer()');
    expect(source).toContain('AudioManager.RINGER_MODE_NORMAL');
    expect(source).toContain('NotificationManager.INTERRUPTION_FILTER_NONE');
    expect(source).toContain('openRawResourceFd(soundResource)');
  });

  it('packages three valid and distinct WAV resources for Android alert types', () => {
    const sounds = ['codex_approval.wav', 'codex_input.wav', 'codex_completion.wav'].map((name) => readFileSync(resolve(
      process.cwd(),
      `android/app/src/main/res/raw/${name}`,
    )));

    for (const sound of sounds) {
      expect(sound.byteLength).toBeGreaterThan(44);
      expect(sound.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(sound.subarray(8, 12).toString('ascii')).toBe('WAVE');
    }
    expect(new Set(sounds.map((sound) => sound.toString('base64'))).size).toBe(3);
  });
});

describe('notification state reconciliation wiring', () => {
  const useRemoteSource = readFileSync(resolve(process.cwd(), 'src/hooks/useRemote.ts'), 'utf8');

  it('reconciles waiting notifications from full, delta and opened-thread snapshots', () => {
    expect(useRemoteSource).toMatch(/case 'threads':[\s\S]*replaceThreadsAndSyncAttention/);
    expect(useRemoteSource).toMatch(/case 'threads\.snapshot':[\s\S]*replaceThreadsAndSyncAttention/);
    expect(useRemoteSource).toMatch(/case 'threads\.delta':[\s\S]*replaceThreadsAndSyncAttention/);
    expect(useRemoteSource).toMatch(/case 'thread':[\s\S]*replaceThreadsAndSyncAttention/);
    expect(useRemoteSource).toMatch(/desktop\/threadSnapshot[\s\S]*replaceThreadsAndSyncAttention/);
  });

  it('skips native cancellation for ordinary non-waiting snapshot entries', () => {
    expect(useRemoteSource).toMatch(/previousState === undefined && notifiedState === undefined && pendingTimer === undefined\) return/);
    expect(useRemoteSource).toMatch(/if \(waiting \|\| tracked\) updateAttentionNotification/);
    expect(useRemoteSource).not.toMatch(/queueAttentionCancellation\(threadId, 'approval'\);\s*void queueAttentionCancellation\(threadId, 'input'\)/);
  });

  it('keeps pending states retryable and gives every approval request its own alert', () => {
    expect(useRemoteSource).toMatch(/previous === state && \(pendingTimer !== undefined \|\| alreadyNotified\)/);
    expect(useRemoteSource).toMatch(/settleGuardedNotification\([\s\S]*result === 'shown'[\s\S]*notifiedAttentionStateByThreadRef\.current\[threadId\] = state/);
    expect(useRemoteSource).toMatch(/queueAttentionCancellation\(normalized\.threadId, 'approval'\)/);
    expect(useRemoteSource).toMatch(/if \(!notifiedApprovalIdsRef\.current\.has\(notificationKey\)\)[\s\S]*notifyApprovalRequested/);
    expect(useRemoteSource).toMatch(/stillWaiting[\s\S]*updateThreadState\(resolved\.threadId, 'waiting_approval'\)/);
  });
});

describe('native foreground-service event listener', () => {
  const socketSource = readFileSync(resolve(
    process.cwd(),
    'android/app/src/main/java/dev/codexmobile/remote/CodexBackgroundSocket.java',
  ), 'utf8');
  const serviceSource = readFileSync(resolve(
    process.cwd(),
    'android/app/src/main/java/dev/codexmobile/remote/CodexBackgroundService.java',
  ), 'utf8');
  const pluginSource = readFileSync(resolve(
    process.cwd(),
    'android/app/src/main/java/dev/codexmobile/remote/CodexBackgroundPlugin.java',
  ), 'utf8');
  const channelSource = readFileSync(resolve(
    process.cwd(),
    'android/app/src/main/java/dev/codexmobile/remote/CodexNotificationChannels.java',
  ), 'utf8');
  const bridgeSource = readFileSync(resolve(process.cwd(), 'src/lib/background.ts'), 'utf8');
  const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

  it('keeps an authenticated read-only WebSocket inside the Android foreground service', () => {
    expect(socketSource).toContain('Sec-WebSocket-Protocol');
    expect(socketSource).toContain('codex-mobile-v1');
    expect(socketSource).toContain('SecureTokenPlugin.readStoredValue');
    expect(socketSource).toContain('threads.list');
    expect(socketSource).toContain('ping');
    expect(socketSource).not.toContain('turn.start');
    expect(socketSource).not.toContain('prompt.send');
    expect(serviceSource).toContain('backgroundSocket.start(serverUrl)');
    expect(socketSource).toContain('credentialFingerprint(normalized)');
    expect(socketSource).toContain('clearSessionState()');
    expect(socketSource).toContain('handler.removeCallbacks(reconnectRunnable)');
    expect(socketSource).not.toContain('synchronized void restart(');
    expect(bridgeSource).toContain('serverUrl: config.serverUrl');
    expect(appSource).toMatch(/config === null[\s\S]*CodexBackground\.stop/);
  });

  it('restarts the background runtime after permission recovery without letting update create an empty service', () => {
    expect(bridgeSource).toContain('resumeBackgroundRuntime');
    expect(bridgeSource).toContain('CodexBackground.getStatus()');
    expect(bridgeSource).toMatch(/if \(!status\.running\) return false;[\s\S]*CodexBackground\.update/);
    expect(appSource).toContain("addListener('appStateChange'");
    expect(appSource).toContain('resumeBackgroundRuntime(config');
    expect(appSource).toContain('Android 后台通知服务未启动');
    expect(pluginSource).toMatch(/public void update\(PluginCall call\)[\s\S]*isMarkedRunning\(getContext\(\)\)[\s\S]*running", false/);
    expect(socketSource).toMatch(/token == null \|\| token\.isEmpty\(\)[\s\S]*scheduleReconnect\(\)/);
  });

  it('observes completion, approval and waiting-state events using the same notification IDs as the WebView', () => {
    expect(socketSource).toContain('case "approval"');
    expect(socketSource).toContain('case "turn.completed"');
    expect(socketSource).toContain('thread/status/changed');
    expect(socketSource).toContain('waitingOnUserInput');
    expect(socketSource).toContain('waitingOnApproval');
    expect(socketSource).toContain('notificationId("approval:" + requestId)');
    expect(socketSource).toContain('notificationLedger.claimNotification(id, threadId)');
    expect(pluginSource).toContain('ledger.claimNotification(id, threadId)');
    expect(socketSource).toContain('notificationId("turn:" + threadId + ":" + eventId)');
    expect(socketSource).toContain('notificationId("attention:" + state + ":" + threadId)');
    expect(socketSource).toContain('.setOnlyAlertOnce(false)');
    expect(socketSource).toContain('CodexNotificationChannels.playVendorAlertFallback(context, alertKindForChannel(channel))');
    expect(pluginSource).toContain('CodexNotificationChannels.playVendorAlertFallback(getContext(), alertKindForChannel(channel))');
    expect(socketSource).toContain('observeThreadState(threadId, state)');
    expect(socketSource).toContain('scheduleCompletionFallback(threadId, state)');
    expect(socketSource).toContain('COMPLETION_FALLBACK_DELAY_MS = 900L');
    expect(channelSource).toContain('ALERT_DEDUPE_MS = 900L');
    expect(channelSource).toContain('fallback deduped kind=');
  });
});


describe('notification async generation guard', () => {
  it('invalidates a coarse notification that completes after detailed approval arrives', () => {
    const guard = new NotificationGenerationGuard();
    const coarse = guard.begin('attention:thread');
    guard.invalidate('attention:thread');
    expect(guard.isCurrent(coarse)).toBe(false);
  });

  it('invalidates a pending request notification after resolution and across session reset', () => {
    const guard = new NotificationGenerationGuard();
    const approval = guard.begin('approval:request');
    guard.invalidate('approval:request');
    expect(guard.isCurrent(approval)).toBe(false);
    const next = guard.begin('approval:request');
    guard.reset();
    expect(guard.isCurrent(next)).toBe(false);
  });

  it('cancels a notification that finishes after its approval was resolved', async () => {
    const guard = new NotificationGenerationGuard();
    const ticket = guard.begin('approval:request');
    let resolveSchedule!: (shown: boolean) => void;
    const scheduled = new Promise<boolean>((resolve) => { resolveSchedule = resolve; });
    let relevant = true;
    let cancelled = 0;
    const result = settleGuardedNotification({
      guard, ticket, queue: new NotificationOperationQueue(), operationKey: 'approval:request',
      schedule: () => scheduled, isRelevant: () => relevant,
      cancel: async () => { cancelled += 1; },
    });
    relevant = false;
    guard.invalidate('approval:request');
    resolveSchedule(true);
    await expect(result).resolves.toBe('stale');
    expect(cancelled).toBe(1);
  });

  it('keeps the newest schedule visible when an older schedule resolves last', async () => {
    const queue = new NotificationOperationQueue();
    const operations: string[] = [];
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve; });
    const old = queue.run('attention:thread', async () => {
      await new Promise<void>((resolve) => { releaseOld = resolve; markOldStarted(); });
      operations.push('old-schedule');
    });
    const cancel = queue.run('attention:thread', async () => { operations.push('cancel-old'); });
    const newest = queue.run('attention:thread', async () => { operations.push('new-schedule'); });
    await oldStarted;
    releaseOld();
    await Promise.all([old, cancel, newest]);
    expect(operations).toEqual(['old-schedule', 'cancel-old', 'new-schedule']);
  });

  it('runs a new schedule after an already pending cancel for the same ID', async () => {
    const queue = new NotificationOperationQueue();
    const operations: string[] = [];
    let releaseCancel!: () => void;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    const cancel = queue.run('approval:request', async () => {
      await new Promise<void>((resolve) => { releaseCancel = resolve; markCancelStarted(); });
      operations.push('cancel');
    });
    const newest = queue.run('approval:request', async () => { operations.push('new-schedule'); });
    await cancelStarted;
    releaseCancel();
    await Promise.all([cancel, newest]);
    expect(operations).toEqual(['cancel', 'new-schedule']);
  });
});
