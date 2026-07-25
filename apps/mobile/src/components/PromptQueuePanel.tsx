import { useMemo, useState } from 'react';
import type { PromptQueueItem } from '../types/protocol';

interface PromptQueuePanelProps {
  items: PromptQueueItem[];
  onCancel: (itemId: string) => void;
  onPromote: (itemId: string) => void;
  onResume: () => void;
  running: boolean;
}

const statusLabel: Record<PromptQueueItem['status'], string> = {
  queued: '等待下一轮',
  sending: '正在投递',
  paused: '队列已暂停',
  failed: '投递失败',
  uncertain: '结果待确认',
};

export function PromptQueuePanel({ items, onCancel, onPromote, onResume, running }: PromptQueuePanelProps) {
  const [expanded, setExpanded] = useState(true);
  const ordered = useMemo(() => [...items].sort((a, b) => a.createdAt - b.createdAt), [items]);
  if (ordered.length === 0) return null;
  const paused = ordered.some((item) => item.status === 'paused');

  return (
    <section className="prompt-queue-panel" aria-label="提示词队列">
      <button className="prompt-queue-summary" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span><strong>下一轮队列</strong><small>{ordered.length} 条等待处理</small></span>
        <span aria-hidden="true">⌄</span>
      </button>
      {expanded && (
        <>
          {paused && <div className="queue-paused-banner"><span>当前 turn 被中断，队列不会自动继续。</span><button type="button" onClick={onResume}>恢复队列</button></div>}
          <ol className="prompt-queue-list">
            {ordered.map((item, index) => {
              const desktopBlocked = item.status === 'queued' && item.error?.includes('电脑端 GUI');
              const actionLabel = item.status === 'uncertain'
                ? '确认后重发'
                : running
                  ? '立即引导'
                  : desktopBlocked
                    ? '等待电脑端'
                    : '等待自动发送';
              return (
                <li key={item.id} className={`queue-item queue-status-${item.status} ${desktopBlocked ? 'queue-desktop-blocked' : ''}`}>
                  <div className="queue-order">{index + 1}</div>
                  <div className="queue-copy">
                    <div><strong>{desktopBlocked ? '等待电脑端协调' : statusLabel[item.status]}</strong><time>{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
                    <p>{item.text}</p>
                    {item.fileNames.length > 0 && <small>{item.fileNames.length} 个附件 · {item.fileNames.join('、')}</small>}
                    {item.error && <small className={desktopBlocked ? 'queue-coordination-note' : 'queue-error'}>{item.error}</small>}
                  </div>
                  <div className="queue-actions">
                    {item.status !== 'sending' && item.status !== 'paused' && (
                      <button type="button" onClick={() => onPromote(item.id)} disabled={!running && item.status === 'queued'}>{actionLabel}</button>
                    )}
                    <button type="button" onClick={() => onCancel(item.id)} disabled={item.status === 'sending'}>取消</button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
