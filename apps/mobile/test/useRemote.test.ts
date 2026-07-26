import { describe, expect, it } from 'vitest';
import { applyPendingMessageDeltas, canonicalProjectedItems, compactionStatusFromThreadPayload, consumeThreadActivationIntent, contextCompactionItemIdsFromThreadPayload, createSelectedMessagesSelector, dedupeMessages, eventThreadId, isActiveTurnStatus, normalizeThreadPayload, optimisticAttachmentsFromUploads, permissionModeLabel, reconcileMessages, reconcileThreadSnapshot, shouldApplyPermissionModeSnapshot, stateFromStatus, turnIdsAfterSnapshot, visibleUserText } from '../src/hooks/useRemote';
import type { RemoteMessage } from '../src/types/protocol';

function user(id: string, content: string, createdAt: number): RemoteMessage {
  return { id, threadId: 'thread', role: 'user', content, createdAt, status: 'complete' };
}



describe('Permission mode synchronization', () => {
  it('keeps a recent optimistic choice from being reverted by a stale thread snapshot', () => {
    const override = { mode: 'full-access' as const, expiresAt: 20_000 };
    expect(shouldApplyPermissionModeSnapshot('auto', override, 10_000)).toBe(false);
    expect(shouldApplyPermissionModeSnapshot('full-access', override, 10_000)).toBe(true);
    expect(shouldApplyPermissionModeSnapshot('auto', override, 20_000)).toBe(true);
  });

  it('uses concise user-facing labels for every permission mode', () => {
    expect(permissionModeLabel('auto')).toBe('自动 · 工作区');
    expect(permissionModeLabel('granular')).toBe('严格确认');
    expect(permissionModeLabel('read-only')).toBe('严格审阅 · 只读');
    expect(permissionModeLabel('guardian-approvals')).toBe('替我审阅');
    expect(permissionModeLabel('full-access')).toBe('完全访问');
  });
});


describe('Buffered streaming deltas', () => {
  it('coalesces ordered deltas for the same item in one immutable thread update', () => {
    const stable = user('stable', 'keep', 1);
    const current = { thread: [stable] };
    const next = applyPendingMessageDeltas(current, [
      { threadId: 'thread', turnId: 'turn', itemId: 'stream', delta: 'hello', role: 'assistant', createdAt: 2 },
      { threadId: 'thread', turnId: 'turn', itemId: 'stream', delta: ' world', role: 'assistant', createdAt: 2 },
    ]);
    expect(next).not.toBe(current);
    expect(next.thread).toEqual([
      stable,
      expect.objectContaining({ id: 'stream', content: 'hello world', status: 'streaming' }),
    ]);
    expect(next.thread?.[0]).toBe(stable);
  });

  it('never downgrades a terminal message when a late delta arrives', () => {
    const completed: RemoteMessage = {
      id: 'done', threadId: 'thread', turnId: 'turn', role: 'assistant',
      content: 'canonical', createdAt: 1, completedAt: 2, status: 'complete',
    };
    const next = applyPendingMessageDeltas({ thread: [completed] }, [
      { threadId: 'thread', turnId: 'turn', itemId: 'done', delta: ' late', role: 'assistant', createdAt: 3 },
    ]);
    expect(next.thread).toEqual([completed]);
    expect(next.thread?.[0]).toBe(completed);
  });

  it('updates multiple streaming items using one indexed pass per thread', () => {
    const current = {
      thread: [
        { ...user('assistant', 'A', 1), role: 'assistant' as const, status: 'streaming' as const },
        { ...user('tool', 'B', 2), role: 'tool' as const, status: 'streaming' as const },
      ],
    };
    const next = applyPendingMessageDeltas(current, [
      { threadId: 'thread', itemId: 'assistant', delta: '1', role: 'assistant', createdAt: 3 },
      { threadId: 'thread', itemId: 'tool', delta: '2', role: 'tool', createdAt: 3 },
    ]);
    expect(next.thread?.map((message) => message.content)).toEqual(['A1', 'B2']);
  });
});

describe('Selected message reference stability', () => {
  it('keeps the selected array reference when only another thread bucket changes', () => {
    const select = createSelectedMessagesSelector();
    const selected = user('selected', 'selected content', 1);
    const firstTodoByThread: Record<string, RemoteMessage> = {};
    const firstBuckets = { thread: [selected], other: [{ ...user('other-1', 'old', 1), threadId: 'other' }] };
    const first = select('thread', firstBuckets, firstTodoByThread);
    const second = select('thread', {
      ...firstBuckets,
      other: [{ ...user('other-2', 'new', 2), threadId: 'other' }],
    }, firstTodoByThread);
    const third = select('thread', firstBuckets, {
      other: { ...user('other-todo', '- [ ] unrelated', 3), threadId: 'other', itemType: 'todo-list' },
    });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(third[0]).toBe(first[0]);
  });

  it('keeps the selected array and item references for an equal cloned bucket', () => {
    const select = createSelectedMessagesSelector();
    const original = { ...user('selected', 'same content', 1), detail: { source: 'desktop' } };
    const first = select('thread', { thread: [original] }, {});
    const second = select('thread', { thread: [{ ...original, detail: { source: 'desktop' } }] }, {});

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  it('returns a new array only for changed content and reuses unchanged message objects', () => {
    const select = createSelectedMessagesSelector();
    const firstMessage = user('first', 'stable', 1);
    const changingMessage = user('changing', 'before', 2);
    const first = select('thread', { thread: [firstMessage, changingMessage] }, {});
    const second = select('thread', {
      thread: [{ ...firstMessage }, { ...changingMessage, content: 'after' }],
    }, {});

    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.content).toBe('after');
  });

  it('keeps an equal cloned selected TODO stable and replaces it when TODO content changes', () => {
    const select = createSelectedMessagesSelector();
    const message = user('message', 'body', 1);
    const todo: RemoteMessage = {
      ...user('todo', '- [ ] pending', 2), itemType: 'todo-list', toolName: '计划', detail: { revision: 1 },
    };
    const first = select('thread', { thread: [message] }, { thread: todo });
    const equal = select('thread', { thread: [{ ...message }] }, {
      thread: { ...todo, detail: { revision: 1 } },
    });
    const changed = select('thread', { thread: [{ ...message }] }, {
      thread: { ...todo, content: '- [x] complete', detail: { revision: 2 } },
    });

    expect(equal).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed[0]).toBe(first[0]);
    expect(changed[1]).not.toBe(first[1]);
  });

  it('stabilizes a large equal snapshot and only replaces the changed message', () => {
    const select = createSelectedMessagesSelector();
    const messages = Array.from({ length: 500 }, (_, index) => user(`message-${index}`, `content-${index}`, index));
    const first = select('thread', { thread: messages }, {});
    const equal = select('thread', { thread: messages.map((message) => ({ ...message })) }, {});
    const changed = select('thread', {
      thread: messages.map((message, index) => index === 250 ? { ...message, content: 'changed' } : { ...message }),
    }, {});

    expect(equal).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.filter((message, index) => message === first[index])).toHaveLength(499);
  });

  it('injects the current TODO, deduplicates it by id, and ignores foreign-thread messages', () => {
    const select = createSelectedMessagesSelector();
    const oldTodo: RemoteMessage = {
      ...user('todo', '- [ ] old', 2), itemType: 'todo-list', toolName: '计划',
    };
    const currentTodo: RemoteMessage = {
      ...oldTodo, content: '- [x] current', detail: { plan: [{ step: 'current', status: 'completed' }] },
    };
    const foreign = { ...user('foreign', 'must not leak', 3), threadId: 'other' };

    const selected = select(
      'thread',
      { thread: [user('message', 'body', 1), oldTodo, foreign] },
      { thread: currentTodo },
    );

    expect(selected.map((message) => message.id)).toEqual(['message', 'todo']);
    expect(selected[1]).toMatchObject({ threadId: 'thread', content: '- [x] current' });
    expect(selected.some((message) => message.threadId !== 'thread')).toBe(false);
  });
});

describe('Desktop/mobile reconciliation', () => {
  it('does not reactivate a task when a delayed open response arrives after returning to the list', () => {
    const pendingStarts = new Set(['thread-start-request']);
    expect(consumeThreadActivationIntent(pendingStarts, 'stale-open-request')).toBe(false);
    expect(pendingStarts).toEqual(new Set(['thread-start-request']));
    expect(consumeThreadActivationIntent(pendingStarts, 'thread-start-request')).toBe(true);
    expect(consumeThreadActivationIntent(pendingStarts, 'thread-start-request')).toBe(false);
  });

  it('never assigns an event without an explicit thread identity to the currently visible task', () => {
    expect(eventThreadId({})).toBeUndefined();
    expect(eventThreadId({ conversationId: 'subagent-thread' })).toBe('subagent-thread');
    expect(eventThreadId({ thread: { id: 'nested-thread' } })).toBe('nested-thread');
    expect(eventThreadId({ turn: { threadId: 'turn-owner' } })).toBe('turn-owner');
    expect(eventThreadId({ item: { ownerConversationId: 'item-owner' } })).toBe('item-owner');
  });

  it('removes foreign messages while reconciling a thread bucket', () => {
    const ownedCurrent = user('owned-current', 'child current', 1);
    const foreignCurrent = { ...user('foreign-current', 'parent current', 2), threadId: 'parent' };
    const ownedIncoming = user('owned-incoming', 'child incoming', 3);
    const foreignIncoming = { ...user('foreign-incoming', 'parent incoming', 4), threadId: 'parent' };

    expect(reconcileMessages(
      [foreignCurrent, ownedCurrent],
      [ownedIncoming, foreignIncoming],
      'append',
      'thread',
    ).map((message) => message.id)).toEqual(['owned-current', 'owned-incoming']);

    expect(reconcileThreadSnapshot(
      [foreignCurrent, ownedCurrent],
      [ownedIncoming, foreignIncoming],
      'thread',
    ).map((message) => message.id)).toEqual(['owned-current', 'owned-incoming']);
  });

  it('reconciles hundreds of covered turns without changing canonical turn order', () => {
    const current: RemoteMessage[] = [];
    const incoming: RemoteMessage[] = [];
    for (let index = 0; index < 500; index += 1) {
      const turnId = `turn-${index}`;
      current.push({ ...user(`live-${index}`, `live ${index}`, index), role: 'tool', turnId });
      incoming.push({ ...user(`canonical-${index}`, `canonical ${index}`, index), role: 'assistant', turnId });
    }
    const result = reconcileThreadSnapshot(current, incoming, 'thread');
    expect(result).toHaveLength(1_000);
    expect(result.slice(0, 4).map((message) => message.id)).toEqual([
      'canonical-0', 'live-0', 'canonical-1', 'live-1',
    ]);
    expect(result.slice(-4).map((message) => message.id)).toEqual([
      'canonical-498', 'live-498', 'canonical-499', 'live-499',
    ]);
  });

  it('maps Desktop notLoaded to an explicit non-idle state', () => {
    expect(stateFromStatus({ type: 'notLoaded' })).toBe('not_loaded');
    expect(stateFromStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waiting_approval');
    expect(stateFromStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waiting_input');
  });

  it('clears a stale current turn when an authoritative snapshot is idle', () => {
    expect(turnIdsAfterSnapshot({ thread: 'old-turn', other: 'keep' }, 'thread')).toEqual({ other: 'keep' });
    expect(turnIdsAfterSnapshot({ other: 'keep' }, 'thread', 'new-turn')).toEqual({ other: 'keep', thread: 'new-turn' });
  });

  it('removes a nearby optimistic duplicate when canonical history arrives', () => {
    const canonical = user('canonical', 'same prompt', 10_000);
    const optimistic = user('local_request', 'same   prompt', 10_500);
    expect(reconcileMessages([optimistic], [canonical])).toEqual([canonical]);
    expect(reconcileMessages([optimistic], [canonical])).toEqual([canonical]);
  });

  it('keeps a legitimate repeated prompt from an older turn', () => {
    const old = user('canonical-old', 'repeat me', 10_000);
    const optimistic = user('local_request', 'repeat me', 10_000 + 10 * 60_000);
    expect(reconcileMessages([old, optimistic], [old])).toEqual([old, optimistic]);
  });

  it('does not erase local streaming state when a Desktop snapshot has no turns yet', () => {
    const streaming: RemoteMessage = { ...user('agent-live', 'partial', 20_000), role: 'assistant', status: 'streaming' };
    expect(reconcileMessages([streaming], [])).toEqual([streaming]);
  });


  it('preserves canonical item order when user and assistant share the same turn timestamp', () => {
    const canonicalUser = user('z-user', 'question', 0);
    const canonicalAssistant: RemoteMessage = { ...user('a-assistant', 'answer', 0), role: 'assistant' };
    expect(reconcileMessages([], [canonicalUser, canonicalAssistant]).map((message) => message.id))
      .toEqual(['z-user', 'a-assistant']);
  });

  it('prepends older history without reordering its canonical items', () => {
    const currentAssistant: RemoteMessage = { ...user('current-answer', 'new answer', 2), role: 'assistant' };
    const olderUser = user('z-old-user', 'old question', 1);
    const olderAssistant: RemoteMessage = { ...user('a-old-answer', 'old answer', 1), role: 'assistant' };
    expect(reconcileMessages([currentAssistant], [olderUser, olderAssistant], 'prepend').map((message) => message.id))
      .toEqual(['z-old-user', 'a-old-answer', 'current-answer']);
  });

  it('repairs a stale mobile order from the canonical active-turn snapshot', () => {
    const canonicalUser = user('user-latest', '刚发送的消息', 0);
    const canonicalAssistant: RemoteMessage = { ...user('assistant-latest', 'Codex 正文', 0), role: 'assistant' };
    const laterTool: RemoteMessage = { ...user('tool-later', '后续工具调用', 0), role: 'tool' };
    const staleMobileOrder = [laterTool, canonicalUser, canonicalAssistant];
    const canonicalOrder = [canonicalUser, canonicalAssistant, laterTool];
    expect(reconcileMessages(staleMobileOrder, canonicalOrder).map((message) => message.id))
      .toEqual(['user-latest', 'assistant-latest', 'tool-later']);
  });

  it('keeps later tools below canonical text when a partial snapshot refreshes the text', () => {
    const canonicalUser = user('user-latest', '刚发送的消息', 0);
    const canonicalAssistant: RemoteMessage = { ...user('assistant-latest', 'Codex 正文', 0), role: 'assistant' };
    const laterTool: RemoteMessage = { ...user('tool-later', '后续工具调用', 0), role: 'tool' };
    expect(reconcileMessages(
      [canonicalUser, canonicalAssistant, laterTool],
      [{ ...canonicalUser, content: '刚发送的消息（canonical）' }, { ...canonicalAssistant, content: 'Codex 正文（canonical）' }],
    ).map((message) => message.id)).toEqual(['user-latest', 'assistant-latest', 'tool-later']);
  });

  it('places a partial canonical snapshot before an event-only tail from the same turn', () => {
    const canonicalUser = { ...user('user-latest', '刚发送的消息', 0), turnId: 'turn-1' };
    const canonicalAssistant: RemoteMessage = { ...user('assistant-latest', 'Codex 正文', 0), role: 'assistant', turnId: 'turn-1' };
    const laterTool: RemoteMessage = { ...user('tool-later', '后续工具调用', 0), role: 'tool', turnId: 'turn-1' };
    expect(reconcileThreadSnapshot([laterTool], [canonicalUser, canonicalAssistant]).map((message) => message.id))
      .toEqual(['user-latest', 'assistant-latest', 'tool-later']);
  });

  it('repairs an already misordered same-turn tail using a repeated partial snapshot', () => {
    const canonicalUser = { ...user('user-latest', '刚发送的消息', 0), turnId: 'turn-1' };
    const canonicalAssistant: RemoteMessage = { ...user('assistant-latest', 'Codex 正文', 0), role: 'assistant', turnId: 'turn-1' };
    const laterTool: RemoteMessage = { ...user('tool-later', '后续工具调用', 0), role: 'tool', turnId: 'turn-1' };
    expect(reconcileThreadSnapshot(
      [laterTool, canonicalUser, canonicalAssistant],
      [canonicalUser, canonicalAssistant],
    ).map((message) => message.id)).toEqual(['user-latest', 'assistant-latest', 'tool-later']);
  });

  it('reorders only turns covered by the Desktop snapshot', () => {
    const old: RemoteMessage = { ...user('old', '旧 turn', 0), turnId: 'turn-0' };
    const canonicalUser = { ...user('user-latest', '刚发送的消息', 0), turnId: 'turn-1' };
    const canonicalAssistant: RemoteMessage = { ...user('assistant-latest', 'Codex 正文', 0), role: 'assistant', turnId: 'turn-1' };
    const laterTool: RemoteMessage = { ...user('tool-later', '后续工具调用', 0), role: 'tool', turnId: 'turn-1' };
    expect(reconcileThreadSnapshot(
      [old, laterTool, canonicalUser, canonicalAssistant],
      [canonicalUser, canonicalAssistant],
    ).map((message) => message.id)).toEqual(['old', 'user-latest', 'assistant-latest', 'tool-later']);
  });


  it('does not append stale app-server projections when a delayed Desktop snapshot arrives', () => {
    const syntheticUser: RemoteMessage = { ...user('item-471', '同一条用户消息', 0), turnId: 'turn-1', detail: { clientId: 'client-1' } };
    const syntheticAssistant: RemoteMessage = { ...user('item-473', '同一条 Codex 输出', 0), role: 'assistant', turnId: 'turn-1' };
    const canonicalUser: RemoteMessage = { ...user('desktop-user', '同一条用户消息', 0), turnId: 'turn-1', detail: { clientUserMessageId: 'client-1' } };
    const canonicalAssistant: RemoteMessage = { ...user('msg-canonical', '同一条 Codex 输出', 0), role: 'assistant', turnId: 'turn-1' };
    const liveTool: RemoteMessage = { ...user('call-live', 'snapshot 后的新工具', 0), role: 'tool', turnId: 'turn-1' };

    // Phase 1 represents thread.open. Phase 2 is the Desktop snapshot that may arrive
    // several seconds later over the public WSS connection.
    const afterOpen = [syntheticUser, syntheticAssistant, liveTool];
    const afterDelayedSnapshot = reconcileThreadSnapshot(afterOpen, [canonicalUser, canonicalAssistant]);

    expect(afterDelayedSnapshot.map((message) => message.id)).toEqual([
      'desktop-user', 'msg-canonical', 'call-live',
    ]);
    expect(afterDelayedSnapshot.filter((message) => message.content === '同一条 Codex 输出')).toHaveLength(1);
  });

  it('keeps unmatched projections instead of deleting them by id shape alone', () => {
    const oldSynthetic: RemoteMessage = { ...user('item-12', '旧历史', 0), role: 'assistant', turnId: 'turn-0' };
    const currentSynthetic: RemoteMessage = { ...user('item-473', '当前旧投影', 0), role: 'assistant', turnId: 'turn-1' };
    const canonical: RemoteMessage = { ...user('msg-canonical', '当前规范输出', 0), role: 'assistant', turnId: 'turn-1' };

    expect(reconcileThreadSnapshot([oldSynthetic, currentSynthetic], [canonical]).map((message) => message.id))
      .toEqual(['item-12', 'msg-canonical', 'item-473']);
  });


  it('preserves an unmatched live item even when its opaque id looks synthetic', () => {
    const liveTool: RemoteMessage = {
      ...user('item-900', '尚未进入快照的真实工具输出', 0),
      role: 'tool',
      itemType: 'commandExecution',
      turnId: 'turn-1',
    };
    const canonical: RemoteMessage = {
      ...user('msg-canonical', '当前规范输出', 0),
      role: 'assistant',
      turnId: 'turn-1',
    };

    expect(reconcileThreadSnapshot([liveTool], [canonical]).map((message) => message.id))
      .toEqual(['msg-canonical', 'item-900']);
  });

  it('does not collapse two tool calls merely because their rendered output matches', () => {
    const liveTool: RemoteMessage = {
      ...user('item-901', 'same output', 0),
      role: 'tool',
      itemType: 'commandExecution',
      turnId: 'turn-1',
    };
    const canonicalTool: RemoteMessage = {
      ...liveTool,
      id: 'call-canonical',
    };

    expect(reconcileThreadSnapshot([liveTool], [canonicalTool]).map((message) => message.id))
      .toEqual(['call-canonical', 'item-901']);
  });

  it('does not collapse same-text assistant items when their source details differ', () => {
    const first: RemoteMessage = {
      ...user('item-902', 'same answer', 0),
      role: 'assistant',
      itemType: 'agentMessage',
      turnId: 'turn-1',
      detail: { type: 'agentMessage', text: 'same answer', phase: 'commentary', sourceMarker: 'first' },
    };
    const canonical: RemoteMessage = {
      ...first,
      id: 'msg-canonical-different',
      detail: { type: 'agentMessage', text: 'same answer', phase: 'commentary', sourceMarker: 'second' },
    };

    expect(reconcileThreadSnapshot([first], [canonical]).map((message) => message.id))
      .toEqual(['msg-canonical-different', 'item-902']);
  });

  it('does not let a delayed snapshot downgrade a fresher same-id live message', () => {
    const current: RemoteMessage = {
      ...user('msg-live', '完整且更新的正文', 0),
      role: 'assistant',
      turnId: 'turn-1',
      status: 'complete',
      completedAt: 200,
    };
    const staleSnapshot: RemoteMessage = {
      ...current,
      content: '旧稿',
      status: 'streaming',
      completedAt: undefined,
    };

    expect(reconcileThreadSnapshot([current], [staleSnapshot])).toEqual([current]);
  });
});


describe('Desktop canonical item parsing', () => {
  it('keeps canonical active-turn text before later tool calls without timestamp sorting', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{
        id: 'active-turn',
        status: 'inProgress',
        startedAt: 100,
        items: [
          { type: 'steeringUserMessage', id: 'z-user', restoreMessage: { text: '刚发送的消息' } },
          { type: 'agentMessage', id: 'a-answer', text: 'Codex 正文' },
          { type: 'commandExecution', id: 'call-later', command: 'git status', status: 'completed' },
        ],
      }],
    } });
    expect(normalized.messages.map((message) => message.id)).toEqual(['z-user', 'a-answer', 'call-later']);
    expect(normalized.messages.map((message) => message.createdAt)).toEqual([100_000, 100_000, 100_000]);
    expect(normalized.messages.map((message) => message.timestampSource)).toEqual(['turn', 'turn', 'turn']);
  });

  it('marks only an item-level timestamp as exact', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{
        id: 'turn',
        status: 'inProgress',
        startedAt: 100,
        items: [{ type: 'commandExecution', id: 'call', command: 'pwd', createdAt: '2026-07-26T14:42:00+08:00' }],
      }],
    } });
    expect(normalized.messages[0]).toMatchObject({
      id: 'call',
      createdAt: new Date('2026-07-26T14:42:00+08:00').getTime(),
      timestampSource: 'item',
    });
  });

  it('does not let a later snapshot overwrite a precise live item time with the turn start time', () => {
    const live: RemoteMessage = {
      ...user('call', '$ pwd', new Date('2026-07-26T14:42:00+08:00').getTime()),
      role: 'tool',
      turnId: 'turn',
      itemType: 'commandExecution',
      toolName: '命令',
      timestampSource: 'live',
    };
    const fallback: RemoteMessage = {
      ...live,
      createdAt: new Date('2026-07-26T12:53:00+08:00').getTime(),
      timestampSource: 'turn',
    };
    expect(reconcileThreadSnapshot([live], [fallback])).toEqual([live]);
  });

  it('records the first observation time for a newly appearing item in the active turn', () => {
    const existing = { ...user('existing', 'earlier', 100_000), turnId: 'turn', timestampSource: 'turn' as const };
    const incoming = [
      existing,
      { ...user('new-tool', '$ git status', 100_000), role: 'tool' as const, turnId: 'turn', timestampSource: 'turn' as const },
    ];
    const observedAt = new Date('2026-07-26T15:04:00+08:00').getTime();
    expect(reconcileThreadSnapshot([existing], incoming, 'thread', 'turn', observedAt)[1]).toMatchObject({
      id: 'new-tool',
      createdAt: observedAt,
      timestampSource: 'observed',
    });
  });

  it('renders steeringUserMessage from restoreMessage without ambient context', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      title: 'task',
      status: { type: 'active', activeFlags: [] },
      turns: [{
        id: 'turn',
        status: 'inProgress',
        startedAt: 100,
        items: [{
          type: 'steeringUserMessage',
          id: 'steer',
          input: [{ type: 'text', text: '<ambient>hidden</ambient>\n真实输入' }],
          restoreMessage: { text: '真实输入' },
        }],
      }],
    } });
    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0]).toMatchObject({ id: 'steer', role: 'user', content: '真实输入' });
  });

  it('extracts the real request from an injected in-app browser context wrapper', () => {
    const raw = [
      '<in-app-browser-context source="ambient-ui-state">',
      'This block is automatically supplied ambient UI state, not part of the user request.',
      '## In app browser:',
      '- Current URL: http://127.0.0.1:4173/',
      '</in-app-browser-context>',
      '',
      '## My request for Codex:',
      '那如果电脑端 GUI 和客户端同时排队，怎么办？',
    ].join('\n');
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', items: [{ type: 'userMessage', id: 'user', content: [{ type: 'text', text: raw }] }] }],
    } });
    expect(normalized.messages[0]).toMatchObject({
      id: 'user',
      role: 'user',
      content: '那如果电脑端 GUI 和客户端同时排队，怎么办？',
    });
  });

  it('strips a standalone ambient block but preserves genuine marker text without injected context', () => {
    expect(visibleUserText('<in-app-browser-context source="ambient-ui-state">hidden</in-app-browser-context>\n真实输入')).toBe('真实输入');
    expect(visibleUserText('说明文字\n## My request for Codex:\n这是用户主动输入的标题')).toBe('说明文字\n## My request for Codex:\n这是用户主动输入的标题');
  });

  it('extracts Desktop GUI image attachments from canonical steering input', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', items: [{
        type: 'steeringUserMessage',
        id: 'image-message',
        input: [
          { type: 'text', text: '看看这张图' },
          { type: 'localImage', path: '/tmp/screenshot.png' },
        ],
        attachments: [{ label: '截图.png', fsPath: '/tmp/screenshot.png' }],
        restoreMessage: { text: '看看这张图', context: { imageAttachments: [{ filename: '截图.png', localPath: '/tmp/screenshot.png' }] } },
      }] }],
    } });
    expect(normalized.messages[0]).toMatchObject({
      id: 'image-message',
      content: '看看这张图',
      attachments: [{ type: 'image', name: '截图.png', path: '/tmp/screenshot.png' }],
    });
  });

  it('keeps uploaded image metadata on the optimistic first message', () => {
    expect(optimisticAttachmentsFromUploads([{
      type: 'image',
      fileName: 'first.jpg',
      mimeType: 'image/jpeg',
      localPath: '/tmp/example-codex-mobile-remote/uploads/id/first.jpg',
    }])).toEqual([{
      type: 'image',
      name: 'first.jpg',
      mimeType: 'image/jpeg',
      path: '/tmp/example-codex-mobile-remote/uploads/id/first.jpg',
    }]);
  });

  it('does not render a host image path as user text when restoreMessage is absent', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', items: [{
        type: 'userMessage',
        id: 'image-first-message',
        input: [
          { type: 'localImage', path: '/tmp/example-codex-mobile-remote/uploads/example/photo.jpg' },
          { type: 'text', text: '请分析这张图片' },
        ],
      }] }],
    } });
    expect(normalized.messages[0]).toMatchObject({
      id: 'image-first-message',
      content: '请分析这张图片',
      attachments: [{ type: 'image', name: 'photo.jpg', path: '/tmp/example-codex-mobile-remote/uploads/example/photo.jpg' }],
    });
    expect(normalized.messages[0]?.content).not.toContain('/Users/');
  });


  it('lets a shorter current reasoning snapshot replace a longer stale summary with the same id', () => {
    const stale: RemoteMessage = {
      id: 'reason', threadId: 'thread', turnId: 'turn', role: 'system',
      content: '正在继续排查数小时前的 JWT 更新与权限同步问题', createdAt: 1,
      status: 'streaming', itemType: 'reasoning', toolName: '思考梗概',
    };
    const current: RemoteMessage = {
      ...stale, content: '检查通知声音', createdAt: 2,
    };
    expect(reconcileThreadSnapshot([stale], [current])).toEqual([current]);
  });

  it('keeps a newer opaque live reasoning item that a delayed Desktop snapshot has not included yet', () => {
    const live: RemoteMessage = {
      id: 'rs_live', threadId: 'thread', turnId: 'turn', role: 'system',
      content: '实时新梗概', createdAt: 2, status: 'streaming', itemType: 'reasoning', toolName: '思考梗概',
    };
    const delayedSnapshot: RemoteMessage = {
      id: 'rs_old', threadId: 'thread', turnId: 'turn', role: 'system',
      content: 'Desktop 旧梗概', createdAt: 1, status: 'streaming', itemType: 'reasoning', toolName: '思考梗概',
    };
    expect(reconcileThreadSnapshot([live], [delayedSnapshot])).toEqual([delayedSnapshot, live]);
  });

  it('drops a stale synthetic reasoning tail when a newer Desktop snapshot is authoritative', () => {
    const stale: RemoteMessage = {
      id: 'turn_item/reasoning/summaryTextDelta', threadId: 'thread', turnId: 'turn', role: 'system',
      content: '旧 JWT 梗概', createdAt: 1, status: 'streaming', itemType: 'reasoning', toolName: '思考梗概',
    };
    const canonical: RemoteMessage = {
      id: 'reason-new', threadId: 'thread', turnId: 'turn', role: 'system',
      content: '正在修复 Subagent 同步', createdAt: 1, status: 'streaming', itemType: 'reasoning', toolName: '思考梗概',
    };
    expect(reconcileThreadSnapshot([stale], [canonical])).toEqual([canonical]);
  });


  it('recovers Subagent parent and nickname from wrapped lowercase source metadata', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'child',
      source: { desktopIpc: true, original: { subagent: { thread_spawn: {
        parent_thread_id: 'parent', agent_nickname: 'Singer', agent_role: 'reviewer',
      } } } },
      turns: [],
    } });
    expect(normalized.thread).toMatchObject({
      id: 'child', parentThreadId: 'parent', agentNickname: 'Singer', agentRole: 'reviewer',
    });
  });

  it.each(['inProgress', 'in_progress', 'running', 'active', 'started'])('recognizes %s as an active turn status', (status) => {
    expect(isActiveTurnStatus(status)).toBe(true);
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', status, items: [{ type: 'reasoning', id: 'reason', summary: ['当前梗概'] }] }],
    } });
    expect(normalized.currentTurnId).toBe('turn');
    expect(normalized.messages[0]?.status).toBe('streaming');
  });

  it.each(['completed', 'failed', 'interrupted', 'idle'])('does not recognize %s as an active turn status', (status) => {
    expect(isActiveTurnStatus(status)).toBe(false);
  });

  it('keeps reasoning from the active Desktop turn as transient streaming state', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', status: 'inProgress', items: [{ type: 'reasoning', id: 'reason', summary: ['正在核查协议'] }] }],
    } });
    expect(normalized.messages[0]).toMatchObject({ id: 'reason', itemType: 'reasoning', status: 'streaming', content: '正在核查协议' });
  });
});


describe('Thread ownership isolation', () => {
  it('drops parent turns and items while inheriting the outer child id only when owner is absent', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'child',
      turns: [
        {
          id: 'inherited-turn',
          items: [
            { type: 'userMessage', id: 'inherited-item', content: [{ type: 'text', text: 'inherit child' }] },
            { type: 'agentMessage', id: 'explicit-child-item', ownerConversationId: 'child', text: 'explicit child' },
            { type: 'agentMessage', id: 'parent-item-thread', threadId: 'parent', text: 'wrong parent' },
            { type: 'agentMessage', id: 'parent-item-conversation', conversationId: 'parent', text: 'wrong parent' },
            { type: 'agentMessage', id: 'parent-item-owner-thread', ownerThreadId: 'parent', text: 'wrong parent' },
            { type: 'agentMessage', id: 'parent-item-owner-conversation', ownerConversationId: 'parent', text: 'wrong parent' },
          ],
        },
        { id: 'parent-turn-thread', threadId: 'parent', items: [{ type: 'agentMessage', id: 'parent-turn-item-1', text: 'wrong parent' }] },
        { id: 'parent-turn-conversation', conversationId: 'parent', items: [{ type: 'agentMessage', id: 'parent-turn-item-2', text: 'wrong parent' }] },
        { id: 'parent-turn-owner-thread', ownerThreadId: 'parent', items: [{ type: 'agentMessage', id: 'parent-turn-item-3', text: 'wrong parent' }] },
        { id: 'parent-turn-owner-conversation', ownerConversationId: 'parent', items: [{ type: 'agentMessage', id: 'parent-turn-item-4', text: 'wrong parent' }] },
        { id: 'explicit-child-turn', conversationId: 'child', items: [{ type: 'agentMessage', id: 'explicit-child-turn-item', text: 'child turn' }] },
      ],
    } });

    expect(normalized.messages.map((message) => [message.id, message.threadId])).toEqual([
      ['inherited-item', 'child'],
      ['explicit-child-item', 'child'],
      ['explicit-child-turn-item', 'child'],
    ]);
  });
});


describe('Cross-source canonical item aliases', () => {
  it('drops app-server synthetic aliases when Desktop provides the same full item with a canonical id', () => {
    const text = '同一条 Codex commentary';
    expect(canonicalProjectedItems([
      { type: 'agentMessage', id: 'item-478', text, phase: 'commentary', memoryCitation: null },
      { type: 'commandExecution', id: 'call-later', command: 'git status' },
      { type: 'agentMessage', id: 'msg_canonical', text, phase: 'commentary', memoryCitation: null },
    ])).toEqual([
      { type: 'commandExecution', id: 'call-later', command: 'git status' },
      { type: 'agentMessage', id: 'msg_canonical', text, phase: 'commentary', memoryCitation: null },
    ]);
  });

  it('maps app-server user clientId to Desktop clientUserMessageId and keeps the canonical position', () => {
    const projected = canonicalProjectedItems([
      { type: 'userMessage', id: 'item-475', clientId: 'client-1', content: [{ type: 'text', text: '消息' }] },
      { type: 'commandExecution', id: 'call-before', command: 'git status' },
      { type: 'steeringUserMessage', id: 'steering-canonical', clientUserMessageId: 'client-1', input: [{ type: 'text', text: '消息' }] },
      { type: 'commandExecution', id: 'call-after', command: 'npm test' },
    ]);
    expect(projected.map((value) => (value as { id: string }).id)).toEqual([
      'call-before', 'steering-canonical', 'call-after',
    ]);
  });

  it('preserves a legitimate extra repeated item instead of deduplicating by text alone', () => {
    const text = '合法重复正文';
    const projected = canonicalProjectedItems([
      { type: 'agentMessage', id: 'item-1', text, phase: 'commentary' },
      { type: 'agentMessage', id: 'item-2', text, phase: 'commentary' },
      { type: 'agentMessage', id: 'msg_canonical', text, phase: 'commentary' },
    ]);
    expect(projected).toHaveLength(2);
    expect(projected.map((value) => (value as { id: string }).id)).toEqual(['item-2', 'msg_canonical']);
  });
});

describe('Context compaction evidence', () => {
  it('extracts canonical contextCompaction item ids', () => {
    expect(contextCompactionItemIdsFromThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', items: [{ type: 'contextCompaction', id: 'compact-1' }] }],
    } })).toEqual(['compact-1']);
  });

  it('recognizes an in-progress compaction turn', () => {
    expect(compactionStatusFromThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', status: 'inProgress', startedAt: 100, items: [{ type: 'contextCompaction', id: 'compact-1' }] }],
    } }, 101_000)).toMatchObject({ threadId: 'thread', phase: 'running', turnId: 'turn' });
  });
});

describe('Mobile optimistic correlation and TODO persistence inputs', () => {
  it('replaces an optimistic user message with canonical steering by clientUserMessageId', () => {
    const optimistic: RemoteMessage = {
      id: 'local_turn', threadId: 'thread', role: 'user', content: 'same', createdAt: 1, status: 'complete',
      detail: { clientUserMessageId: 'client-1' },
    };
    const canonical: RemoteMessage = {
      id: 'steering', threadId: 'thread', role: 'user', content: 'same', createdAt: 999_999, status: 'complete',
      detail: { clientUserMessageId: 'client-1', serverUserMessageId: 'server-1' },
    };
    expect(dedupeMessages([optimistic, canonical])).toEqual([canonical]);
  });

  it('keeps intentional repeated prompts with different correlation ids', () => {
    const first = { ...user('first', 'repeat', 1), detail: { clientUserMessageId: 'client-1' } };
    const second = { ...user('second', 'repeat', 2), detail: { clientUserMessageId: 'client-2' } };
    expect(dedupeMessages([first, second])).toHaveLength(2);
  });

  it('parses Desktop todo-list explanation and plan statuses', () => {
    const normalized = normalizeThreadPayload({ thread: {
      id: 'thread',
      turns: [{ id: 'turn', status: 'inProgress', items: [{
        type: 'todo-list', id: 'todo', explanation: '继续推进',
        plan: [
          { step: '完成项', status: 'completed' },
          { step: '进行项', status: 'inProgress' },
          { step: '待办项', status: 'pending' },
        ],
      }] }],
    } });
    expect(normalized.messages[0]).toMatchObject({ id: 'todo', itemType: 'todo-list', toolName: '计划' });
    expect(normalized.messages[0]?.content).toContain('- [x] 完成项');
    expect(normalized.messages[0]?.content).toContain('- [ ] 进行项');
    expect(normalized.messages[0]?.content).toContain('- [ ] 待办项');
  });
});
