import { describe, expect, it } from 'vitest';
import { agentStatePresentation, conversationEntryWindow, DEFAULT_RENDERED_ENTRY_LIMIT, groupConsecutiveToolMessages, resolveConversationEntryAgentNames, subagentsFromMessages, visibleConversationContentKey } from '../src/components/ConversationScreen';
import { latestReasoning } from '../src/components/ConversationContextPanel';
import type { RemoteMessage, RemoteThread } from '../src/types/protocol';

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


  it('recovers Subagent ids from compact cached collaboration text', () => {
    const cached = collab({});
    cached.content = 'Agent: 019f99bb-d520-7431-83cc-6636fdcf61b3\n019f99bb-d520-7431-83cc-6636fdcf61b3: running';
    cached.detail = undefined;
    expect(subagentsFromMessages([cached])).toEqual([{
      id: '019f99bb-d520-7431-83cc-6636fdcf61b3',
      label: '019f99bb',
      state: 'running',
    }]);
  });

  it('recovers a bare Subagent id only from cached subagentActivity text', () => {
    const cached = collab({});
    cached.itemType = 'subagentActivity';
    cached.toolName = 'Subagent 活动';
    cached.content = 'started\n019f99bb-d520-7431-83cc-6636fdcf61b3\n/agent/path';
    cached.detail = undefined;
    expect(subagentsFromMessages([cached])).toEqual([{
      id: '019f99bb-d520-7431-83cc-6636fdcf61b3',
      label: '019f99bb',
      state: 'unknown',
    }]);
    const prompt = { ...cached, itemType: 'collabAgentToolCall', toolName: 'Subagent · spawnAgent' };
    expect(subagentsFromMessages([prompt])).toEqual([]);
  });

  it('reads wait-agent names from structured receiverThreads and ignores UUID examples in the report body', () => {
    const targetId = '019f9c86-c712-7be1-8699-597617b734bb';
    const unrelatedId = '019f99bb-d520-7431-83cc-6636fdcf61b3';
    const wait = collab({
      receiverThreadIds: [targetId],
      receiverThreads: [{
        threadId: targetId,
        thread: {
          id: targetId,
          agentNickname: 'Singer',
          name: '审计 Android 通知无声音',
          status: { type: 'idle' },
        },
      }],
      agentsStates: { [targetId]: { status: 'completed' } },
    });
    wait.toolName = 'Subagent · wait';
    wait.content = `Agent: ${targetId}\n${targetId}: completed — 报告示例：\nAgent: ${unrelatedId}`;
    expect(subagentsFromMessages([wait])).toEqual([{
      id: targetId,
      label: 'Singer',
      state: 'completed',
    }]);
  });

  it('reads a wait-agent nickname from nested source metadata when the thread field has no direct nickname', () => {
    const targetId = '019f9c86-fc9e-7253-936d-43c5d01fbdba';
    const wait = collab({
      receiverThreads: [{
        threadId: targetId,
        thread: {
          id: targetId,
          source: { subAgent: { thread_spawn: { agent_nickname: 'Lorentz' } } },
          status: { type: 'active' },
        },
      }],
    });
    wait.toolName = 'Subagent · wait';
    expect(subagentsFromMessages([wait])).toEqual([{
      id: targetId,
      label: 'Lorentz',
      state: 'active',
    }]);
  });

  it('resolves opaque ids to live agent nicknames and hides unresolved identifiers', () => {
    const cached = collab({ receiverThreadIds: ['019f99bb-d520-7431-83cc-6636fdcf61b3'] });
    const rawEntries = groupConsecutiveToolMessages([cached]);
    const thread: RemoteThread = {
      id: '019f99bb-d520-7431-83cc-6636fdcf61b3', title: 'Audit worker', preview: '', updatedAt: 1,
      state: 'running', unread: 0, cwd: '/tmp', modelProvider: '', parentThreadId: 'parent',
      agentNickname: 'Singer', agentRole: 'worker', source: null,
    };
    const resolved = resolveConversationEntryAgentNames(rawEntries, [thread]);
    expect(resolved[0]?.agentTargets).toEqual([{ id: thread.id, label: 'Singer', state: 'active' }]);
    expect(resolveConversationEntryAgentNames(rawEntries, [])[0]?.agentTargets).toEqual([]);
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


  it('folds Subagent calls with adjacent tools while retaining direct agent targets', () => {
    const agent = message('agent', 'tool');
    agent.itemType = 'collabAgentToolCall';
    agent.toolName = 'Subagent · spawnAgent';
    agent.detail = {
      receiverThreadIds: ['child-thread'],
      agentsStates: { 'child-thread': { nickname: 'Worker', status: 'running' } },
    };
    const entries = groupConsecutiveToolMessages([message('tool-1', 'tool'), agent, message('tool-2', 'tool')]);
    expect(entries.map((entry) => entry.type === 'message' ? entry.message.id : entry.messages.map((item) => item.id)))
      .toEqual([['tool-1', 'agent', 'tool-2']]);
    expect(entries[0]?.type === 'tool-group' ? entries[0].agentTargets : []).toEqual([
      { id: 'child-thread', label: 'Worker', state: 'running' },
    ]);
    expect(entries[0]?.type === 'tool-group' ? entries[0].agentTargetsByMessage.agent : []).toEqual([
      { id: 'child-thread', label: 'Worker', state: 'running' },
    ]);
    expect(entries[0]?.type === 'tool-group' ? entries[0].agentTargetsByMessage['tool-1'] : []).toEqual([]);
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

describe('Transient reasoning selection', () => {
  const reasoning = (id: string, turnId: string, content: string, toolName = '思考梗概'): RemoteMessage => ({
    id, threadId: 'parent', turnId, role: 'system', content, createdAt: 1,
    status: 'streaming', itemType: 'reasoning', toolName,
  });

  it('never revives a cached summary without a current turn', () => {
    expect(latestReasoning([reasoning('old', 'old-turn', 'JWT')], undefined)).toBeUndefined();
  });

  it('uses only the current turn summary and ignores reasoning detail', () => {
    expect(latestReasoning([
      reasoning('old', 'old-turn', 'JWT'),
      reasoning('summary', 'current-turn', '正在修复同步'),
      reasoning('detail', 'current-turn', '内部详情', '思考详情'),
    ], 'current-turn')?.content).toBe('正在修复同步');
  });
});

function performanceMessage(id: string, role: RemoteMessage['role']): RemoteMessage {
  return { id, threadId: 'thread', role, content: id, createdAt: 1, status: 'complete' };
}

describe('Long conversation performance guards', () => {
  it('mounts only the configured tail window while retaining an explicit older-entry count', () => {
    const entries = groupConsecutiveToolMessages(Array.from({ length: 1_000 }, (_, index) => (
      performanceMessage(`message-${index}`, index % 2 === 0 ? 'user' : 'assistant')
    )));
    const window = conversationEntryWindow(entries, DEFAULT_RENDERED_ENTRY_LIMIT);
    expect(entries).toHaveLength(1_000);
    expect(window.entries).toHaveLength(DEFAULT_RENDERED_ENTRY_LIMIT);
    expect(window.hiddenCount).toBe(1_000 - DEFAULT_RENDERED_ENTRY_LIMIT);
    expect(window.entries[0]?.type === 'message' ? window.entries[0].message.id : '').toBe(`message-${1_000 - DEFAULT_RENDERED_ENTRY_LIMIT}`);
  });

  it('keeps a frozen reading window bounded while new tail entries accumulate', () => {
    const initial = groupConsecutiveToolMessages(Array.from({ length: 80 }, (_, index) => (
      performanceMessage(`frozen-${index}`, index % 2 === 0 ? 'user' : 'assistant')
    )));
    const appended = groupConsecutiveToolMessages([
      ...Array.from({ length: 80 }, (_, index) => performanceMessage(`frozen-${index}`, index % 2 === 0 ? 'user' : 'assistant')),
      ...Array.from({ length: 500 }, (_, index) => performanceMessage(`new-${index}`, index % 2 === 0 ? 'user' : 'assistant')),
    ]);
    const frozen = conversationEntryWindow(appended, DEFAULT_RENDERED_ENTRY_LIMIT, initial.length);
    expect(frozen.entries).toHaveLength(DEFAULT_RENDERED_ENTRY_LIMIT);
    expect(frozen.hiddenAfter).toBe(500);
    expect(frozen.entries.at(-1)?.type === 'message' ? frozen.entries.at(-1)?.message.id : '').toBe('frozen-79');
  });

  it('detects a non-tail visible message replacement without scanning hidden history', () => {
    const first = performanceMessage('visible-first', 'assistant');
    const last = performanceMessage('visible-last', 'assistant');
    const before = groupConsecutiveToolMessages([first, last]);
    const after = groupConsecutiveToolMessages([{ ...first, content: 'same length!!!' }, last]);
    expect(visibleConversationContentKey(after, new Set(), []))
      .not.toBe(visibleConversationContentKey(before, new Set(), []));
  });

  it('reuses parsed agent target arrays for unchanged message objects', () => {
    const agent = performanceMessage('agent-stable', 'tool');
    agent.itemType = 'collabAgentToolCall';
    agent.detail = {
      receiverThreadIds: ['child-stable'],
      agentsStates: { 'child-stable': { nickname: 'Stable', status: 'running' } },
    };
    const first = groupConsecutiveToolMessages([agent])[0];
    const second = groupConsecutiveToolMessages([agent])[0];
    expect(first?.type).toBe('message');
    expect(second?.type).toBe('message');
    if (first?.type === 'message' && second?.type === 'message') {
      expect(second.agentTargets).toBe(first.agentTargets);
    }
  });

  it('groups a large history within a bounded synchronous budget', () => {
    const history = Array.from({ length: 5_000 }, (_, index) => {
      const item = performanceMessage(`perf-${index}`, index % 5 === 0 ? 'assistant' : 'tool');
      item.content = `output ${index}`;
      return item;
    });
    const startedAt = performance.now();
    const entries = groupConsecutiveToolMessages(history);
    const elapsedMs = performance.now() - startedAt;
    expect(entries.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(500);
  });
});
