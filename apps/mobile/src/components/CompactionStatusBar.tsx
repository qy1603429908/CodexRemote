import { useEffect, useState } from 'react';
import type { CompactionStatus } from '../types/protocol';

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function CompactionStatusBar({ status, onDismiss }: { status: CompactionStatus | null; onDismiss: () => void }) {
  const [now, setNow] = useState(Date.now());
  const active = status?.phase === 'requested' || status?.phase === 'running' || status?.phase === 'retrying';

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, status?.startedAt]);

  useEffect(() => {
    if (status?.phase !== 'succeeded') return;
    const timer = window.setTimeout(onDismiss, 7000);
    return () => window.clearTimeout(timer);
  }, [onDismiss, status?.phase, status?.updatedAt]);

  if (!status) return null;

  const label = status.phase === 'requested'
    ? '正在请求上下文压缩'
    : status.phase === 'running'
      ? '正在压缩上下文'
      : status.phase === 'retrying'
        ? '上下文压缩遇到错误，正在重试'
        : status.phase === 'succeeded'
          ? '上下文压缩完成'
          : '上下文压缩失败';

  return (
    <section
      className={`compaction-status compaction-${status.phase}`}
      aria-live={status.phase === 'failed' ? 'assertive' : 'polite'}
      aria-label="上下文压缩状态"
    >
      <span className="compaction-symbol" aria-hidden="true">
        {active ? <><i /><i /><i /></> : status.phase === 'succeeded' ? '✓' : '!'}
      </span>
      <span className="compaction-copy">
        <strong>{label}</strong>
        {status.message && status.message !== label && <small>{status.message}</small>}
      </span>
      {active && <time>{formatElapsed(now - status.startedAt)}</time>}
      {!active && <button type="button" onClick={onDismiss} aria-label="关闭上下文压缩状态">×</button>}
    </section>
  );
}
