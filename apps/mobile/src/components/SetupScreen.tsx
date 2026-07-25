import { useState, type FormEvent } from 'react';
import { DEFAULT_SERVER_URL, normalizeServerUrl, saveRemoteConfig, storageDescription, type RemoteConfig } from '../lib/configStore';
import { EyeIcon, ShieldIcon } from './Icons';

interface SetupScreenProps {
  initialConfig?: RemoteConfig | null;
  onSaved: (config: RemoteConfig) => void;
  onCancel?: () => void;
  onForget?: () => void;
  onFullRefresh?: () => Promise<void>;
}

export function SetupScreen({ initialConfig, onSaved, onCancel, onForget, onFullRefresh }: SetupScreenProps) {
  const [serverUrl, setServerUrl] = useState(initialConfig?.serverUrl ?? DEFAULT_SERVER_URL);
  const [pairingToken, setPairingToken] = useState(initialConfig?.pairingToken ?? '');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const saved = await saveRemoteConfig({
        serverUrl: normalizeServerUrl(serverUrl),
        pairingToken,
      });
      onSaved(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '配置保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="setup-screen">
      <section className="setup-card">
        <header className="setup-brand">
          <img src="/logo.svg?v=3" alt="" className="product-logo" />
          <div>
            <strong>Codex Remote</strong>
            <span>Android 客户端</span>
          </div>
        </header>

        <div className="setup-heading">
          <p className="eyebrow">连接设置</p>
          <h1>连接到电脑上的 Codex</h1>
          <p className="setup-intro">端点与 API Key 保留在主机端，手机仅保存连接信息。</p>
        </div>

        <form onSubmit={handleSubmit} className="setup-form">
          <label>
            <span>服务器地址</span>
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://codex.example.com"
              autoCapitalize="none"
              autoCorrect="off"
              inputMode="url"
              required
            />
            <small>支持可信私有局域网、Tailscale、localhost；公网请使用 HTTPS/WSS。</small>
          </label>

          <label>
            <span>配对令牌</span>
            <div className="secret-input">
              <input
                value={pairingToken}
                onChange={(event) => setPairingToken(event.target.value)}
                placeholder="粘贴主机端生成的令牌"
                type={showToken ? 'text' : 'password'}
                autoCapitalize="none"
                autoCorrect="off"
                required
              />
              <button type="button" onClick={() => setShowToken((value) => !value)} aria-label={showToken ? '隐藏令牌' : '显示令牌'}>
                <EyeIcon off={showToken} />
              </button>
            </div>
          </label>

          {error && <div className="form-error">{error}</div>}

          <div className="setup-actions">
            {onCancel && <button className="secondary-button" type="button" onClick={onCancel}>取消</button>}
            <button className="primary-button setup-submit" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '保存并连接'}
            </button>
          </div>
          {onFullRefresh && (
            <div className="cache-refresh-action">
              <button
                className="secondary-button"
                type="button"
                disabled={refreshing}
                onClick={async () => {
                  if (!window.confirm('将清空本机所有任务缓存并从 Host 全量重新下载。连接地址和配对令牌会保留。是否继续？')) return;
                  setRefreshing(true);
                  setError('');
                  try {
                    await onFullRefresh();
                  } catch (reason) {
                    setError(reason instanceof Error ? reason.message : '全量刷新失败');
                    setRefreshing(false);
                  }
                }}
              >
                {refreshing ? '正在全量刷新…' : '清空缓存并全量刷新'}
              </button>
              <small>删除所有版本的本地任务缓存，保留连接信息，并重新下载任务索引和当前会话。</small>
            </div>
          )}
          {onForget && (
            <button className="danger-text-button" type="button" onClick={onForget}>清除本机连接信息</button>
          )}
        </form>

        <div className="security-note">
          <ShieldIcon />
          <p>{storageDescription()}</p>
        </div>
      </section>
    </main>
  );
}
