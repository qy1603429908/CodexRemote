import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConversationScreen } from './components/ConversationScreen';
import { NewThreadSheet } from './components/NewThreadSheet';
import { SetupScreen } from './components/SetupScreen';
import { ThreadList } from './components/ThreadList';
import { useRemote } from './hooks/useRemote';
import { clearRemoteConfig, loadRemoteConfig, type RemoteConfig } from './lib/configStore';
import { initializeNotifications } from './lib/notifications';
import { CodexBackground, startBackgroundRuntime, updateBackgroundThread } from './lib/background';

export function popThreadBackStack(stack: string[]): { previousThreadId: string | null; remaining: string[] } {
  if (stack.length === 0) return { previousThreadId: null, remaining: [] };
  return { previousThreadId: stack.at(-1) ?? null, remaining: stack.slice(0, -1) };
}

export function App() {
  const [config, setConfig] = useState<RemoteConfig | null | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewThread, setShowNewThread] = useState(false);
  const [selectedAgentByThread, setSelectedAgentByThread] = useState<Record<string, string | null>>({});
  const threadBackStackRef = useRef<string[]>([]);
  const remote = useRemote(config ?? null);

  const openRootThread = useCallback((threadId: string) => {
    threadBackStackRef.current = [];
    setSelectedAgentByThread((current) => ({ ...current, [threadId]: null }));
    remote.selectThread(threadId);
  }, [remote.selectThread]);

  const openNestedThread = useCallback((threadId: string) => {
    const currentThreadId = remote.selectedThreadId;
    if (currentThreadId && currentThreadId !== threadId) threadBackStackRef.current.push(currentThreadId);
    setSelectedAgentByThread((current) => ({ ...current, [threadId]: null }));
    remote.selectThread(threadId);
  }, [remote.selectThread, remote.selectedThreadId]);

  const navigateBack = useCallback(() => {
    const currentThreadId = remote.selectedThreadId;
    if (currentThreadId && selectedAgentByThread[currentThreadId]) {
      setSelectedAgentByThread((current) => ({ ...current, [currentThreadId]: null }));
      return;
    }
    const { previousThreadId, remaining } = popThreadBackStack(threadBackStackRef.current);
    threadBackStackRef.current = remaining;
    if (previousThreadId) {
      remote.selectThread(previousThreadId);
      return;
    }
    remote.selectThread(null);
  }, [remote.selectThread, remote.selectedThreadId, selectedAgentByThread]);

  useEffect(() => {
    void loadRemoteConfig().then(setConfig).catch(() => setConfig(null));
    void initializeNotifications();
    if (Capacitor.isNativePlatform()) {
      void StatusBar.setStyle({ style: Style.Dark });
      void StatusBar.setBackgroundColor({ color: '#f7f7f5' });
      void StatusBar.setOverlaysWebView({ overlay: false });
    }
  }, []);

  useEffect(() => {
    if (!config || !Capacitor.isNativePlatform()) return;
    void startBackgroundRuntime(config, remote.selectedThreadId ?? undefined);
  }, [config]);

  useEffect(() => {
    if (!config || !Capacitor.isNativePlatform()) return;
    void updateBackgroundThread(remote.selectedThreadId ?? undefined, remote.selectedThread?.title);
  }, [config, remote.selectedThread?.title, remote.selectedThreadId]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    const consumedNonces = new Set<string>();
    const openAction = (action: { threadId?: string; nonce?: string }) => {
      if (action.nonce && consumedNonces.has(action.nonce)) return;
      if (action.nonce) consumedNonces.add(action.nonce);
      if (action.threadId && action.threadId !== 'global') openRootThread(action.threadId);
    };
    void CodexBackground.addListener('notificationAction', openAction).then((handle) => { listener = handle; });
    void CodexBackground.consumePendingAction().then(({ action }) => { if (action) openAction(action); }).catch(() => undefined);
    return () => void listener?.remove();
  }, [openRootThread]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    void CapacitorApp.addListener('backButton', () => {
      if (showNewThread) setShowNewThread(false);
      else if (showSettings) setShowSettings(false);
      else if (remote.selectedThreadId) navigateBack();
      else void CapacitorApp.exitApp();
    }).then((handle) => {
      listener = handle;
    });
    return () => void listener?.remove();
  }, [navigateBack, remote.selectedThreadId, showNewThread, showSettings]);


  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let listener: { remove: () => Promise<void> } | null = null;
    void LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
      const extra = notification.extra as { threadId?: unknown } | undefined;
      if (typeof extra?.threadId === 'string') openRootThread(extra.threadId);
    }).then((handle) => {
      listener = handle;
    });
    return () => void listener?.remove();
  }, [openRootThread]);

  async function forgetConnection() {
    if (Capacitor.isNativePlatform()) await CodexBackground.stop().catch(() => undefined);
    await clearRemoteConfig();
    setShowSettings(false);
    setConfig(null);
  }

  if (config === undefined) {
    return (
      <main className="loading-screen">
        <div className="brand-mark"><span /></div>
        <p>正在读取安全配置…</p>
      </main>
    );
  }

  if (!config || showSettings) {
    return (
      <SetupScreen
        initialConfig={config}
        onSaved={(saved) => {
          setConfig(saved);
          setShowSettings(false);
        }}
        onCancel={config ? () => setShowSettings(false) : undefined}
        onFullRefresh={config ? async () => {
          await remote.fullRefresh();
          setShowSettings(false);
        } : undefined}
        onForget={config ? () => void forgetConnection() : undefined}
      />
    );
  }

  return (
    <>
      {remote.selectedThread ? (
        <ConversationScreen
          thread={remote.selectedThread}
          messages={remote.selectedMessages}
          subagents={remote.selectedSubagents}
          approvals={remote.selectedApprovals}
          compaction={remote.selectedCompaction}
          promptQueue={remote.selectedPromptQueue}
          gitDiff={remote.selectedGitDiff}
          models={remote.models}
          skills={remote.skills}
          selectedModel={remote.selectedModel}
          selectedEffort={remote.selectedEffort}
          selectedPermissionMode={remote.selectedPermissionMode}
          phase={remote.phase}
          phaseDetail={remote.phaseDetail}
          running={remote.running}
          canInterrupt={remote.canInterrupt}
          historyHasMore={Boolean(remote.selectedHistory?.hasMore)}
          historyLoading={remote.historyLoading}
          selectedAgentId={selectedAgentByThread[remote.selectedThread.id] ?? null}
          onSelectAgent={(agentId) => setSelectedAgentByThread((current) => ({ ...current, [remote.selectedThread!.id]: agentId }))}
          onLoadOlderHistory={remote.loadOlderHistory}
          onBack={navigateBack}
          onReconnect={remote.reconnect}
          onSend={remote.sendMessage}
          onCancelQueuedPrompt={remote.cancelQueuedPrompt}
          onPromoteQueuedPrompt={remote.promoteQueuedPrompt}
          onResumePromptQueue={remote.resumePromptQueue}
          onRefreshGitDiff={remote.refreshGitDiff}
          onInterrupt={remote.interrupt}
          onSelectModel={remote.selectModel}
          onSelectEffort={remote.selectEffort}
          onSelectPermissionMode={remote.selectPermissionMode}
          onResolveApproval={remote.resolveApproval}
          onDismissCompaction={() => remote.dismissCompaction(remote.selectedThread!.id)}
          onOpenThread={openNestedThread}
          onLoadAttachment={remote.loadHostAttachment}
          onDownloadAttachment={remote.downloadHostAttachment}
        />
      ) : (
        <ThreadList
          threads={remote.threads}
          phase={remote.phase}
          phaseDetail={remote.phaseDetail || (remote.phase === 'connected' && !remote.codexReady ? 'Bridge 已连接，但 Codex app-server 尚未就绪' : '')}
          onSelect={openRootThread}
          onCreate={() => setShowNewThread(true)}
          onSettings={() => setShowSettings(true)}
          onReconnect={remote.reconnect}
        />
      )}

      {showNewThread && (
        <NewThreadSheet models={remote.models} defaultModel={remote.selectedModel} onClose={() => setShowNewThread(false)} onStart={remote.startThread} />
      )}

      {remote.lastError && (
        <div className="error-toast" role="alert">
          <span>{remote.lastError}</span>
          <button type="button" onClick={remote.dismissError} aria-label="关闭错误提示">×</button>
        </div>
      )}
    </>
  );
}
