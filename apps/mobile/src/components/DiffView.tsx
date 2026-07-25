interface DiffRow {
  kind: 'context' | 'add' | 'remove' | 'meta' | 'hunk';
  text: string;
}

interface DiffFile {
  path: string;
  rows: DiffRow[];
  additions: number;
  deletions: number;
}

function rowFromLine(text: string): DiffRow {
  if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('new file mode') || text.startsWith('deleted file mode')) return { kind: 'meta', text };
  if (text.startsWith('@@')) return { kind: 'hunk', text };
  if (text.startsWith('+')) return { kind: 'add', text };
  if (text.startsWith('-')) return { kind: 'remove', text };
  return { kind: 'context', text };
}

export function filesFromDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  const ensureCurrent = () => {
    if (!current) {
      current = { path: '变更详情', rows: [], additions: 0, deletions: 0 };
      files.push(current);
    }
    return current;
  };
  for (const line of diff.replace(/\r\n?/g, '\n').split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      current = { path: header[2] ?? header[1] ?? '文件', rows: [], additions: 0, deletions: 0 };
      files.push(current);
    }
    const file = ensureCurrent();
    const row = rowFromLine(line);
    file.rows.push(row);
    if (row.kind === 'add') file.additions += 1;
    if (row.kind === 'remove') file.deletions += 1;
  }
  return files.filter((file) => file.rows.some((row) => row.text.trim()));
}

function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <pre className="diff-lines"><code>{rows.map((row, index) => (
      <span className={`diff-row diff-${row.kind}`} key={`${index}:${row.text}`}>
        <span className="diff-number">{index + 1}</span><span>{row.text || ' '}</span>
      </span>
    ))}</code></pre>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const files = filesFromDiff(diff);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  if (files.length === 0) return <p className="diff-empty">当前仓库没有未提交变更。</p>;
  return (
    <section className="diff-view" aria-label="代码差异">
      <header className="diff-header">
        <div><strong>{files.length} 个文件</strong><span>按文件展开查看</span></div>
        <span className="diff-stat"><b>+{additions}</b><i>-{deletions}</i></span>
      </header>
      <div className="diff-file-list">
        {files.map((file, index) => (
          <details className="diff-file" key={`${file.path}:${index}`} open={files.length === 1}>
            <summary>
              <span className="diff-file-disclosure" aria-hidden="true">›</span>
              <code>{file.path}</code>
              <span className="diff-stat"><b>+{file.additions}</b><i>-{file.deletions}</i></span>
            </summary>
            <DiffRows rows={file.rows} />
          </details>
        ))}
      </div>
    </section>
  );
}
