import { describe, expect, it } from 'vitest';
import { agentStatePresentation, groupConsecutiveToolMessages, subagentsFromMessages, visibleConversationContentKey } from '../src/components/ConversationScreen';
import type { RemoteMessage } from '../src/types/protocol';

function collab(detail: Record<string, unknown>): RemoteMessage {
  return {
    id: 'collab',
    threadId: 'parent',
    role: 'tool',
    content: 'activity',
    createdAt: 1,
    status: 'complete',
    itemType: 'collabAgentToolCall',
    detail,
  };
}

describe('Subagent presentation', () => {
  it('does not downgrade interrupted to generic complete receiver state', () => {
    expect(subagentsFromMessages([collab({
      agentsStates: { child: { status: 'interrupted', nickname: 'Worker' } },
      receiverThreadIds: ['child'],
    })])).toEqual([{ id: 'child', label: 'Worker', state: 'interrupted' }]);
  });

  it('labels non-running states explicitly', () => {
    expect(agentStatePresentation('not_loaded').label).toBe('未载入');
    expect(agentStatePresentation('errored').label).toBe('失败');
    expect(agentStatePresentation('shutdown').label).toBe('已停止');
    expect(agentStatePresentation('waiting_approval').label).toBe('待审批');
  });
});


describe('Consecutive tool grouping', () => {
  const message = (id: string, role: RemoteMessage['role']): RemoteMessage => ({ id, threadId: 'thread', role, content: id, createdAt: 1, status: 'complete' });

  it('folds only adjacent tools and keeps user/assistant boundaries', () => {
    const entries = groupConsecutiveToolMessages([
      message('user', 'user'),
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
      message('assistant', 'assistant'),
      message('tool-3', 'tool'),
    ]);
    expect(entries.map((entry) => entry.type === 'message' ? entry.message.id : entry.messages.map((item) => item.id))).toEqual([
      'user', ['tool-1', 'tool-2'], 'assistant', 'tool-3',
    ]);
  });

  it('keeps a stable group identity while later tool calls join the same run', () => {
    const first = groupConsecutiveToolMessages([
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
    ])[0];
    const later = groupConsecutiveToolMessages([
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
      message('tool-3', 'tool'),
    ])[0];
    expect(first?.type).toBe('tool-group');
    expect(later?.type).toBe('tool-group');
    expect(first && first.type === 'tool-group' ? first.id : '').toBe('tools:tool-1');
    expect(later && later.type === 'tool-group' ? later.id : '').toBe('tools:tool-1');
  });

  it('does not report hidden updates inside a closed tool group as visible new content', () => {
    const before = groupConsecutiveToolMessages([
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
    ]);
    const after = groupConsecutiveToolMessages([
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
      message('tool-3', 'tool'),
    ]);
    expect(visibleConversationContentKey(before, new Set(), []))
      .toBe(visibleConversationContentKey(after, new Set(), []));
  });

  it('does report updates that are visible inside an expanded tool group', () => {
    const before = groupConsecutiveToolMessages([
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
    ]);
    const after = groupConsecutiveToolMessages([
      message('tool-1', 'tool'),
      message('tool-2', 'tool'),
      message('tool-3', 'tool'),
    ]);
    const expanded = new Set(['tools:tool-1']);
    expect(visibleConversationContentKey(before, expanded, []))
      .not.toBe(visibleConversationContentKey(after, expanded, []));
  });

});
