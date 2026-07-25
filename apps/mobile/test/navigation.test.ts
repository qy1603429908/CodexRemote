import { describe, expect, it } from 'vitest';
import { popThreadBackStack } from '../src/App';

describe('thread navigation stack', () => {
  it('returns from a Subagent task to its immediate parent before the task list', () => {
    expect(popThreadBackStack(['parent', 'child'])).toEqual({ previousThreadId: 'child', remaining: ['parent'] });
    expect(popThreadBackStack(['parent'])).toEqual({ previousThreadId: 'parent', remaining: [] });
    expect(popThreadBackStack([])).toEqual({ previousThreadId: null, remaining: [] });
  });
});
