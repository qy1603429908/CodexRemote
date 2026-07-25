import { useMemo, useState } from 'react';
import type { RemoteMessage, RemoteThread } from '../types/protocol';
import { Markdown } from './Markdown';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  const data = record(value);
  if (!data) return '';
  for (const key of ['text', 'content', 'title', 'description', 'objective', 'goal']) {
    const candidate = text(data[key]);
    if (candidate) return candidate;
  }
  return '';
}

function findGoal(source: unknown): string {
  const data = record(source);
  if (!data) return '';
  const candidates = [
    data.threadGoal,
    data.thread_goal,
    data.goal,
    data.objective,
    record(data.thread)?.threadGoal,
    record(data.conversation)?.threadGoal,
  ];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return value;
  }
  return '';
}

function isPlan(message: RemoteMessage): boolean {
  const itemType = message.itemType?.toLowerCase() ?? '';
  const toolName = message.toolName?.toLowerCase() ?? '';
  return itemType.includes('plan') || itemType.includes('todo') || toolName === '计划' || toolName.includes('todo');
}

function checklistCount(content: string): { done: number; total: number } | null {
  const items = content.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?.+$/gm) ?? [];
  if (items.length === 0) return null;
  return {
    done: items.filter((item) => /\[[xX]\]/.test(item)).length,
    total: items.length,
  };
}

export function isContextMessage(message: RemoteMessage): boolean {
  const itemType = message.itemType?.toLowerCase() ?? '';
  return itemType.includes('reasoning') || isPlan(message);
}

export function latestReasoning(messages: RemoteMessage[], currentTurnId?: string): RemoteMessage | undefined {
  if (!currentTurnId) return undefined;
  return [...messages].reverse().find((message) => {
    const isReasoning = message.itemType?.toLowerCase().includes('reasoning');
    const isDetail = message.toolName === '思考详情' || message.id.endsWith('_detail');
    return message.turnId === currentTurnId && message.status === 'streaming' && isReasoning && !isDetail;
  });
}

export function ConversationContextPanel({ thread, messages }: { thread: RemoteThread; messages: RemoteMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const goal = useMemo(() => findGoal(thread.source), [thread.source]);
  const plan = useMemo(() => [...messages].reverse().find(isPlan)?.content.trim() ?? '', [messages]);
  const progress = useMemo(() => checklistCount(plan), [plan]);

  if (!goal && !plan) return null;

  const summary = progress
    ? `${progress.done}/${progress.total} 项完成`
    : goal && plan
      ? '目标与执行计划'
      : goal
        ? '当前目标'
        : '执行计划';

  return (
    <section className={`conversation-context ${expanded ? 'is-expanded' : ''}`} aria-label="目标与 TODO">
      <button
        className="context-toggle"
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="context-heading">
          <span className="context-mark" aria-hidden="true" />
          <strong>目标 / TODO</strong>
          <small>{summary}</small>
        </span>
        <span className="context-chevron" aria-hidden="true">⌄</span>
      </button>
      {expanded && (
        <div className="context-content">
          {goal && (
            <section>
              <h3>目标</h3>
              <Markdown content={goal} />
            </section>
          )}
          {plan && (
            <section>
              <h3>TODO</h3>
              <Markdown content={plan} />
            </section>
          )}
        </div>
      )}
    </section>
  );
}
