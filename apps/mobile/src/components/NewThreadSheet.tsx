import { useState, type FormEvent } from 'react';
import type { ModelOption } from '../types/protocol';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './Icons';

interface NewThreadSheetProps {
  models: ModelOption[];
  defaultModel: string;
  onClose: () => void;
  onStart: (cwd: string, model?: string, modelProvider?: string) => boolean;
}

export function NewThreadSheet({ models, defaultModel, onClose, onStart }: NewThreadSheetProps) {
  const [cwd, setCwd] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState(defaultModel);
  const [modelProvider, setModelProvider] = useState('');
  const [error, setError] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!cwd.trim().startsWith('/')) {
      setError('请输入电脑上的绝对路径');
      return;
    }
    if (onStart(cwd, model || undefined, modelProvider || undefined)) onClose();
    else setError('任务创建请求未发送，请确认连接状态');
  }

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="bottom-sheet" role="dialog" aria-modal="true" aria-labelledby="new-thread-title" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div><p className="eyebrow">新任务</p><h2 id="new-thread-title">选择工作目录</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        </div>
        <form className="new-thread-form" onSubmit={submit}>
          <label>
            <span>电脑工作目录</span>
            <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project" autoCapitalize="none" autoCorrect="off" />
          </label>
          <button className="advanced-toggle" type="button" onClick={() => setShowAdvanced((value) => !value)}>
            <span>模型高级设置</span>{showAdvanced ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
          {showAdvanced && (
            <div className="advanced-fields">
              <label>
                <span>模型（可选）</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">使用主机默认值</option>
                  {models.filter((option) => !option.hidden).map((option) => <option key={option.id} value={option.model}>{option.displayName || option.model}</option>)}
                </select>
              </label>
              <label><span>模型提供方（自定义端点时可选）</span><input value={modelProvider} onChange={(event) => setModelProvider(event.target.value)} placeholder="使用主机默认值" autoCapitalize="none" /></label>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
          <div className="sheet-actions">
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit">创建任务</button>
          </div>
        </form>
      </section>
    </div>
  );
}
