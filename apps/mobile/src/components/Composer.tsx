import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ModelOption, SkillOption } from '../types/protocol';
import { SendIcon, StopIcon } from './Icons';

export type DeliveryMode = 'auto' | 'steer' | 'queue';

export function effectiveDeliveryMode(running: boolean, selectedMode: DeliveryMode): DeliveryMode {
  if (!running) return 'auto';
  return selectedMode === 'queue' ? 'queue' : 'steer';
}

export function shouldSubmitComposerShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }): boolean {
  return event.key === 'Enter' && !event.isComposing && Boolean(event.ctrlKey || event.metaKey);
}

interface CommandOption {
  value: string;
  title: string;
  description: string;
  group: '命令' | '模型' | '技能';
}

interface ComposerProps {
  connected: boolean;
  running: boolean;
  canInterrupt: boolean;
  models: ModelOption[];
  skills: SkillOption[];
  onSend: (content: string, files: File[] | undefined, deliveryMode: DeliveryMode) => Promise<boolean> | boolean;
  onInterrupt: () => void;
}

export function Composer({ connected, running, onSend, onInterrupt, canInterrupt, models, skills }: ComposerProps) {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [selectedDeliveryMode, setSelectedDeliveryMode] = useState<DeliveryMode>('auto');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  useEffect(() => {
    setSelectedDeliveryMode(running ? 'steer' : 'auto');
  }, [running]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [content]);

  const commandOptions = useMemo<CommandOption[]>(() => [
    { value: '/status', title: '/status', description: '查看状态、目录、模型与计时', group: '命令' },
    { value: '/compact', title: '/compact', description: '压缩当前任务上下文', group: '命令' },
    { value: '/download ', title: '/download <路径>', description: '从电脑下载允许目录内的文件', group: '命令' },
    { value: '/help', title: '/help', description: '显示手机端支持的命令', group: '命令' },
    { value: '/models', title: '/models', description: '列出可用模型', group: '命令' },
    { value: '/skills', title: '/skills', description: '列出当前目录可用技能', group: '命令' },
    ...models.filter((model) => !model.hidden).map((model) => ({
      value: `/model:${model.model}`,
      title: `/model:${model.model}`,
      description: model.description || model.displayName,
      group: '模型' as const,
    })),
    ...skills.filter((skill) => skill.enabled).map((skill) => ({
      value: `/skill:${skill.name} `,
      title: `/skill:${skill.name}`,
      description: skill.shortDescription || skill.description || '使用此技能执行任务',
      group: '技能' as const,
    })),
  ], [models, skills]);

  const suggestions = useMemo(() => {
    if (!content.startsWith('/') || content.includes('\n')) return [];
    const query = content.toLowerCase();
    return commandOptions.filter((option) =>
      option.title.toLowerCase().includes(query) || option.description.toLowerCase().includes(query.slice(1)),
    ).slice(0, 8);
  }, [commandOptions, content]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (sendingRef.current || sending || (!content.trim() && files.length === 0)) return;
    const deliveryMode = effectiveDeliveryMode(running, selectedDeliveryMode);
    sendingRef.current = true;
    setSending(true);
    try {
      if (await onSend(content, files, deliveryMode)) {
        setContent('');
        setFiles([]);
        if (deliveryMode === 'queue') setSelectedDeliveryMode('steer');
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function chooseCommand(value: string) {
    setContent(value);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.length, value.length);
    });
  }

  const deliveryMode = effectiveDeliveryMode(running, selectedDeliveryMode);
  const placeholder = sending
    ? deliveryMode === 'queue' ? '正在加入下一轮…' : '正在上传并发送…'
    : !connected ? '等待重新连接…'
      : deliveryMode === 'queue' ? '输入下一轮任务；当前执行不会被打断…'
        : deliveryMode === 'steer' ? '补充要求，引导当前执行…'
          : '向 Codex 下达任务；输入 / 查看命令…';
  const sendLabel = deliveryMode === 'queue' ? '排队' : deliveryMode === 'steer' ? '引导' : '发送';

  return (
    <div className="composer-shell">
      {running && (
        <div className="composer-running-controls">
          <div className="delivery-mode-picker" role="group" aria-label="运行中消息发送方式">
            <button
              type="button"
              className={deliveryMode === 'steer' ? 'is-selected' : ''}
              aria-pressed={deliveryMode === 'steer'}
              onClick={() => setSelectedDeliveryMode('steer')}
              disabled={sending}
            >
              <strong>引导当前</strong>
              <small>立即补充要求</small>
            </button>
            <button
              type="button"
              className={`queue-mode-option${deliveryMode === 'queue' ? ' is-selected' : ''}`}
              aria-pressed={deliveryMode === 'queue'}
              onClick={() => setSelectedDeliveryMode('queue')}
              disabled={sending}
            >
              <strong>排队下一轮</strong>
              <small>当前完成后执行</small>
            </button>
          </div>
          <button className="interrupt-button" type="button" onClick={onInterrupt} disabled={!canInterrupt || sending}>
            <StopIcon /> <span>停止</span>
          </button>
        </div>
      )}
      {running && deliveryMode === 'queue' && (
        <div className="queue-mode-notice" role="status">
          <span aria-hidden="true" />
          <p><strong>已选择排队</strong><small>这条提示词不会引导当前执行，将在当前任务结束后作为下一轮发送。</small></p>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="command-palette" role="listbox" aria-label="斜杠命令">
          {suggestions.map((option) => (
            <button key={option.value} type="button" onClick={() => chooseCommand(option.value)}>
              <span className="command-kind">{option.group}</span>
              <span className="command-copy"><strong>{option.title}</strong><small>{option.description}</small></span>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="attachment-strip">
          {files.map((file, index) => (
            <button key={`${file.name}:${file.size}:${index}`} type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
              <span>{file.type.startsWith('image/') ? '图片' : '文件'}</span>
              <strong>{file.name}</strong>
              <small>×</small>
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <input
          ref={fileInputRef}
          className="file-picker-input"
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.csv,.pdf,.zip"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          disabled={!connected || sending}
        />
        <button className="attach-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={!connected || sending} aria-label="上传图片或文件">＋</button>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (shouldSubmitComposerShortcut({
              key: event.key,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
            })) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          disabled={!connected || sending}
        />
        <button
          className={`send-button send-mode-${deliveryMode}`}
          type="submit"
          disabled={!connected || sending || (!content.trim() && files.length === 0)}
          aria-label={sendLabel}
          title={deliveryMode === 'queue' ? '排队到下一轮' : deliveryMode === 'steer' ? '引导当前执行' : '发送'}
        >
          <SendIcon />
          {running && <span>{sendLabel}</span>}
        </button>
      </form>
    </div>
  );
}
