import { useState } from 'react';
import type { GitDiffSnapshot } from '../types/protocol';
import { DiffView } from './DiffView';

interface GitDiffPanelProps {
  snapshot: GitDiffSnapshot | null;
  onRefresh: () => void;
}

export function shouldShowGitDiff(snapshot: GitDiffSnapshot | null): boolean {
  return Boolean(snapshot?.repositoryRoot);
}

export function GitDiffPanel({ snapshot, onRefresh }: GitDiffPanelProps) {
  const [expanded, setExpanded] = useState(false);
  if (!shouldShowGitDiff(snapshot)) return null;
  return (
    <section className="git-diff-panel" aria-label="Git 变更">
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary aria-label={`Git 变更，${expanded ? '点击收起' : '点击展开'}`}>
          <span className="git-diff-disclosure" aria-hidden="true">›</span>
          <span className="git-diff-title"><strong>Git 变更</strong><small>{snapshot?.repositoryRoot || '等待读取仓库'}</small></span>
          <span className="git-diff-counts">
            {snapshot && !snapshot.error ? <><b>{snapshot.files} 文件</b><i>+{snapshot.additions}</i><em>-{snapshot.deletions}</em></> : <b>未载入</b>}
          </span>
          <span className="git-diff-toggle-label">{expanded ? '收起' : '展开'}</span>
        </summary>
        <div className="git-diff-content">
          <header>
            <div>
              <strong>{snapshot?.error ? '暂时无法读取' : snapshot?.files ? '工作区未提交变更' : '工作区干净'}</strong>
              <small>{snapshot?.generatedAt ? new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未刷新'}{snapshot?.truncated ? ' · 已截断' : ''}</small>
            </div>
            <button type="button" onClick={onRefresh}>刷新</button>
          </header>
          <div className="git-diff-scroll" tabIndex={0} aria-label="Git 变更文件，可上下滚动">
            {snapshot?.error ? <p className="git-diff-error">{snapshot.error}</p> : <DiffView diff={snapshot?.diff ?? ''} />}
          </div>
        </div>
      </details>
    </section>
  );
}
