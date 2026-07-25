import type { ApprovalDecision, ApprovalRequest } from '../types/protocol';
import { AlertIcon } from './Icons';

function stringDecision(decision: ApprovalDecision): string | null {
  return typeof decision === 'string' ? decision : null;
}

export function ApprovalCard({ approval, onResolve }: { approval: ApprovalRequest; onResolve: (approvalId: string, decision: ApprovalDecision) => void }) {
  const findString = (value: string) => approval.availableDecisions.find((decision) => stringDecision(decision) === value);
  const execpolicy = approval.availableDecisions.find((decision) => typeof decision === 'object' && decision.kind === 'acceptWithExecpolicyAmendment');
  const networkPolicy = approval.availableDecisions.find((decision) => typeof decision === 'object' && decision.kind === 'applyNetworkPolicyAmendment');
  const decline = findString('decline');
  const cancel = findString('cancel');
  const accept = findString('accept');
  const acceptForSession = findString('acceptForSession');

  return (
    <article className="approval-card">
      <div className="approval-heading">
        <span className="approval-icon"><AlertIcon /></span>
        <div><p>需要批准</p><h3>{approval.title}</h3></div>
      </div>
      {approval.description && <p className="approval-description">{approval.description}</p>}
      {approval.command && <pre className="approval-command"><code>{approval.command}</code></pre>}
      {approval.cwd && <p className="approval-cwd">目录：{approval.cwd}</p>}
      <div className="approval-actions">
        {decline && <button className="deny-button" type="button" onClick={() => onResolve(approval.id, decline)}>拒绝</button>}
        {!decline && cancel && <button className="deny-button" type="button" onClick={() => onResolve(approval.id, cancel)}>取消</button>}
        {accept && <button className="once-button" type="button" onClick={() => onResolve(approval.id, accept)}>本次允许</button>}
        {execpolicy && <button className="once-button" type="button" onClick={() => onResolve(approval.id, execpolicy)}>允许同类命令</button>}
        {networkPolicy && <button className="once-button" type="button" onClick={() => onResolve(approval.id, networkPolicy)}>应用网络规则</button>}
        {acceptForSession && <button className="approve-button" type="button" onClick={() => onResolve(approval.id, acceptForSession)}>会话内允许</button>}
      </div>
    </article>
  );
}
