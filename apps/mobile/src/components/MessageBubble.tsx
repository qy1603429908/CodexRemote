import { useEffect, useState } from 'react';
import type { RemoteAttachment, RemoteMessage } from '../types/protocol';
import { DiffView } from './DiffView';
import { Markdown } from './Markdown';

function displayTime(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || durationMs < 0) return '';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}分${seconds}秒`;
}

function rawDetail(detail: unknown): string {
  if (detail == null) return '';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function firstLine(content: string): string {
  return content.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}


interface LoadedAttachment {
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
}

function AttachmentView({ attachment, onLoad, onDownload }: {
  attachment: RemoteAttachment;
  onLoad?: (path: string) => Promise<LoadedAttachment>;
  onDownload?: (path: string) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedAttachment | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (attachment.type !== 'image' || !onLoad) return;
    let disposed = false;
    let objectUrl = '';
    onLoad(attachment.path).then((result) => {
      if (disposed) { URL.revokeObjectURL(result.url); return; }
      objectUrl = result.url;
      setLoaded(result);
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : '图片加载失败');
    });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.path, attachment.type, onLoad]);

  if (attachment.type === 'image') {
    return (
      <figure className="message-attachment message-image-attachment">
        {loaded ? <img src={loaded.url} alt={attachment.name} /> : <div className="attachment-loading">{error || '正在加载图片…'}</div>}
        <figcaption><span>{attachment.name}</span><button type="button" onClick={() => onDownload?.(attachment.path)}>下载</button></figcaption>
      </figure>
    );
  }
  return (
    <button className="message-attachment message-file-attachment" type="button" onClick={() => onDownload?.(attachment.path)}>
      <span>文件</span><strong>{attachment.name}</strong><small>下载</small>
    </button>
  );
}

function AttachmentGallery({ message, onLoad, onDownload }: {
  message: RemoteMessage;
  onLoad?: (path: string) => Promise<LoadedAttachment>;
  onDownload?: (path: string) => void;
}) {
  if (!message.attachments?.length) return null;
  return <div className="message-attachments">{message.attachments.map((attachment) => (
    <AttachmentView key={attachment.path} attachment={attachment} onLoad={onLoad} onDownload={onDownload} />
  ))}</div>;
}

export function MessageBubble({ message, agentTargets = [], onOpenAgent, onLoadAttachment, onDownloadAttachment }: {
  message: RemoteMessage;
  agentTargets?: Array<{ id: string; label: string; state: string }>;
  onOpenAgent?: (agentId: string) => void;
  onLoadAttachment?: (path: string) => Promise<LoadedAttachment>;
  onDownloadAttachment?: (path: string) => void;
}) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const normalizedType = message.itemType?.toLowerCase() ?? '';
  const normalizedName = message.toolName?.toLowerCase() ?? '';
  const isSubagent = normalizedType.includes('subagent')
    || normalizedType.includes('collabagent')
    || normalizedName.includes('subagent');
  const author = isUser ? '你' : isTool ? message.toolName || '工具' : message.role === 'system' ? message.toolName || '系统' : 'Codex';
  const duration = formatDuration(message.durationMs);
  const isDiff = message.toolName === '本轮 Diff' || /^diff --git /m.test(message.content);
  const inspectable = message.collapsible || isTool || isSubagent;
  const mainBody = isDiff
    ? <DiffView diff={message.content} />
    : isTool
      ? <pre><code>{message.content}</code></pre>
      : <Markdown content={message.content} />;
  const body = <>
    {mainBody}
    <AttachmentGallery message={message} onLoad={onLoadAttachment} onDownload={onDownloadAttachment} />
  </>;

  return (
    <article className={`message-row role-${message.role} ${isSubagent ? 'is-subagent' : ''} ${message.status === 'failed' ? 'is-failed' : ''}`}>
      <div className="message-column">
        {inspectable ? (
          <details className={`message-detail-card ${message.status === 'streaming' ? 'is-streaming' : ''}`} open={message.status === 'streaming'}>
            <summary>
              <span className="event-disclosure" aria-hidden="true">›</span>
              <span className="event-kind">{isSubagent ? 'Subagent' : isDiff ? 'Diff' : '工具'}</span>
              <span className="event-summary">
                <strong>{author}</strong>
                <small>{firstLine(message.content) || '查看详情'}</small>
              </span>
              <span className="message-meta">
                {duration && <span>{duration}</span>}
                {message.status === 'failed' && <span className="failed-label">失败</span>}
                <time>{displayTime(message.createdAt)}</time>
              </span>
            </summary>
            <div className="message-detail-content">{body}</div>
            {message.detail != null && <details className="raw-event"><summary>原始事件</summary><pre><code>{rawDetail(message.detail)}</code></pre></details>}
            {message.status === 'streaming' && <span className="typing-caret" />}
          </details>
        ) : (
          <>
            <header className="message-label">
              <strong>{author}</strong>
              <span className="message-meta">
                <time>{displayTime(message.createdAt)}</time>
                {duration && <span>{duration}</span>}
                {message.status === 'failed' && <span className="failed-label">失败</span>}
              </span>
            </header>
            <div className={`message-bubble ${message.status === 'streaming' ? 'is-streaming' : ''}`}>
              {body}
              {message.status === 'streaming' && <span className="typing-caret" />}
            </div>
          </>
        )}
        {agentTargets.length > 0 && (
          <nav className="message-agent-links" aria-label="此工具调用关联的 Subagent">
            {agentTargets.map((agent) => (
              <button key={agent.id} type="button" onClick={() => onOpenAgent?.(agent.id)}>
                <span aria-hidden="true" />
                <strong>{agent.label}</strong>
                <small>打开</small>
              </button>
            ))}
          </nav>
        )}
      </div>
    </article>
  );
}
