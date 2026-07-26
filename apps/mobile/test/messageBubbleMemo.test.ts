import { describe, expect, it, vi } from 'vitest';
import { displayTime, messageBubblePropsEqual } from '../src/components/MessageBubble';
import type { RemoteMessage } from '../src/types/protocol';

function message(content = 'unchanged'): RemoteMessage {
  return { id: 'same', threadId: 'thread', role: 'assistant', content, createdAt: 1, status: 'complete' };
}

describe('MessageBubble memo comparison', () => {
  it('skips rerender for equivalent canonical clones and equivalent agent targets', () => {
    const open = vi.fn();
    expect(messageBubblePropsEqual(
      { message: message(), agentTargets: [{ id: 'agent', label: 'Worker', state: 'complete' }], onOpenAgent: open },
      { message: message(), agentTargets: [{ id: 'agent', label: 'Worker', state: 'complete' }], onOpenAgent: open },
    )).toBe(true);
  });

  it('rerenders only the message whose visible content changed', () => {
    expect(messageBubblePropsEqual({ message: message('before') }, { message: message('after') })).toBe(false);
  });
});


describe('MessageBubble timestamps', () => {
  it('hides turn-level fallback timestamps instead of presenting them as item time', () => {
    expect(displayTime(new Date('2026-07-26T12:53:00+08:00').getTime(), 'turn')).toBe('');
  });

  it('renders an item-level timestamp in the local hour and minute', () => {
    expect(displayTime(new Date(2026, 6, 26, 14, 42).getTime(), 'item')).toMatch(/14:42|14：42/);
  });

  it('labels first-observed live snapshot times as approximate', () => {
    expect(displayTime(new Date(2026, 6, 26, 15, 4).getTime(), 'observed')).toMatch(/^≈15[:：]04$/);
  });

  it('rerenders when timestamp confidence changes', () => {
    expect(messageBubblePropsEqual(
      { message: { ...message(), timestampSource: 'turn' } },
      { message: { ...message(), timestampSource: 'live' } },
    )).toBe(false);
  });
});
