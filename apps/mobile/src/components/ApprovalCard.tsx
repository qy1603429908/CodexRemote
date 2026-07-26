import type { ApprovalDecision, ApprovalRequest, PermissionMode } from '../types/protocol';
import { AlertIcon } from './Icons';

function stringDecision(decision: ApprovalDecision): string | null {
  return typeof decision === 'string' ? decision : null;
}

export function ApprovalCard({ approval, permissionMode, onResolve }: { approval: ApprovalRequest; permissionMode: PermissionMode; onResolve: (approvalId: string, decision: ApprovalDecision) => void }) {
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
      <p className="approval-source">来源：<code>{approval.method}</code></p>
      {permissionMode === 'full-access' && <p className="approval-mode-note">当前任务已选择完全访问。切换前已经产生的审批不会自动撤销；若这是切换后新产生的请求，请保留下方来源用于排查。</p>}
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
