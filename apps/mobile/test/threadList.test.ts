import { describe, expect, it } from 'vitest';
import {
  PROJECT_AUTO_COLLAPSE_THRESHOLD,
  PROJECT_COLLAPSE_STORAGE_KEY,
  defaultProjectCollapsed,
  groupThreadsByCwd,
  projectCollapsed,
  readProjectCollapsePreferences,
  toggleProjectCollapsePreference,
  writeProjectCollapsePreferences,
} from '../src/components/ThreadList';
import type { RemoteThread, ThreadState } from '../src/types/protocol';

function thread(
  id: string,
  cwd: string,
  updatedAt: number,
  state: ThreadState = 'idle',
  unread = 0,
): RemoteThread {
  return {
    id,
    title: id,
    preview: '',
    updatedAt,
    state,
    unread,
    cwd,
    modelProvider: '',
    parentThreadId: null,
    agentNickname: null,
    agentRole: null,
    source: null,
  };
}

function manyThreads(cwd: string, state: ThreadState = 'idle'): RemoteThread[] {
  return Array.from(
    { length: PROJECT_AUTO_COLLAPSE_THRESHOLD },
    (_, index) => thread(`${cwd}-${index}`, cwd, index, state),
  );
}

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('ThreadList project grouping', () => {
  it('keeps directory and task counts intact while sorting groups and tasks by recency', () => {
    const groups = groupThreadsByCwd([
      thread('a-old', '/work/a', 10),
      thread('b-new', '/work/b', 30),
      thread('a-new', '/work/a', 20),
      thread('without-cwd', '', 5),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => [group.cwd, group.items.length])).toEqual([
      ['/work/b', 1],
      ['/work/a', 2],
      ['未指定目录', 1],
    ]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['a-new', 'a-old']);
    expect(groups.reduce((total, group) => total + group.items.length, 0)).toBe(4);
  });
});

describe('ThreadList project collapse defaults', () => {
  it('keeps small directories expanded and collapses task-heavy inactive directories', () => {
    expect(defaultProjectCollapsed(manyThreads('/work/a').slice(0, PROJECT_AUTO_COLLAPSE_THRESHOLD - 1))).toBe(false);
    expect(defaultProjectCollapsed(manyThreads('/work/a'))).toBe(true);
  });

  it.each([
    ['running', 0],
    ['waiting_approval', 0],
    ['waiting_input', 0],
    ['idle', 2],
  ] as const)('keeps a task-heavy directory expanded when it needs attention (%s)', (state, unread) => {
    const items = manyThreads('/work/a');
    items[0] = thread('attention', '/work/a', 100, state, unread);
    expect(defaultProjectCollapsed(items)).toBe(false);
  });

  it('toggles from the computed default and preserves independent cwd choices', () => {
    const heavy = manyThreads('/work/heavy');
    const light = [thread('light', '/work/light', 1)];

    const afterHeavyToggle = toggleProjectCollapsePreference('/work/heavy', heavy, {});
    expect(projectCollapsed('/work/heavy', heavy, afterHeavyToggle)).toBe(false);

    const afterLightToggle = toggleProjectCollapsePreference('/work/light', light, afterHeavyToggle);
    expect(projectCollapsed('/work/heavy', heavy, afterLightToggle)).toBe(false);
    expect(projectCollapsed('/work/light', light, afterLightToggle)).toBe(true);
  });
});

describe('ThreadList project collapse persistence', () => {
  it('round-trips explicit expanded and collapsed choices through local storage', () => {
    const storage = new MemoryStorage();
    writeProjectCollapsePreferences({ '/work/a': true, '/work/b': false }, storage);

    expect(storage.getItem(PROJECT_COLLAPSE_STORAGE_KEY)).toBe('{"/work/a":true,"/work/b":false}');
    expect(readProjectCollapsePreferences(storage)).toEqual({ '/work/a': true, '/work/b': false });
  });

  it('ignores malformed and non-boolean stored values without breaking the list', () => {
    const storage = new MemoryStorage();
    storage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, '{"/work/a":true,"/work/b":"yes","":false}');
    expect(readProjectCollapsePreferences(storage)).toEqual({ '/work/a': true });

    storage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, '{broken');
    expect(readProjectCollapsePreferences(storage)).toEqual({});
  });
});
