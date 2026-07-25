import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { filesFromDiff } from '../src/components/DiffView';
import { shouldShowGitDiff } from '../src/components/GitDiffPanel';

describe('filesFromDiff', () => {
  it('groups a repository diff by file and counts changed content lines', () => {
    const files = filesFromDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-const oldValue = 1;',
      '+const newValue = 2;',
      ' unchanged',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1,2 @@',
      '+export const first = true;',
      '+export const second = true;',
    ].join('\n'));

    expect(files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions }))).toEqual([
      { path: 'src/a.ts', additions: 1, deletions: 1 },
      { path: 'src/b.ts', additions: 2, deletions: 0 },
    ]);
  });

  it('handles an empty diff as a clean workspace', () => {
    expect(filesFromDiff('')).toEqual([]);
  });
});


describe('GitDiffPanel visibility', () => {
  it('stays hidden unless the task cwd resolves to a Git worktree', () => {
    expect(shouldShowGitDiff(null)).toBe(false);
    expect(shouldShowGitDiff({
      threadId: 'thread', cwd: '/tmp/plain', repositoryRoot: '', diff: '', files: 0, additions: 0, deletions: 0, truncated: false, generatedAt: 1, error: 'not git',
    })).toBe(false);
    expect(shouldShowGitDiff({
      threadId: 'thread', cwd: '/repo', repositoryRoot: '/repo', diff: '', files: 0, additions: 0, deletions: 0, truncated: false, generatedAt: 1,
    })).toBe(true);
  });
});


describe('Git diff large-list scrolling affordance', () => {
  it('defines an independent vertical scroller and explicit disclosure label', () => {
    const source = readFileSync(new URL('../src/components/GitDiffPanel.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(source).toContain('git-diff-toggle-label');
    expect(source).toContain('Git 变更文件，可上下滚动');
    expect(styles).toMatch(/\.git-diff-scroll\s*\{[^}]*max-height:[^}]*overflow-y:\s*scroll/s);
    expect(styles).toMatch(/\.git-diff-scroll::-webkit-scrollbar\s*\{[^}]*width:/s);
  });
});
