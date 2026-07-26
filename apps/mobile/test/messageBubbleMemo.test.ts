import { describe, expect, it, vi } from 'vitest';
import { messageBubblePropsEqual } from '../src/components/MessageBubble';
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
