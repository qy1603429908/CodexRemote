import { ElapsedTime } from './ElapsedTime';

interface TransientActivityProps {
  running: boolean;
  content?: string;
  startedAt?: number;
}

function compact(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '正在检查代码…')
    .replace(/^\s*[-*#>]\s*/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function TransientActivity({ running, content = '', startedAt }: TransientActivityProps) {
  const summary = compact(content);
  return (
    <div className={`activity-status-slot ${running ? 'is-active' : ''}`} aria-live="polite" aria-atomic="true">
      {running && (
        <div className="activity-status">
          <span className="activity-wave" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="activity-copy">{summary ? `思考梗概 · ${summary}` : 'Codex 正在思考'}</span>
          <ElapsedTime startedAt={startedAt} />
        </div>
      )}
    </div>
  );
}
