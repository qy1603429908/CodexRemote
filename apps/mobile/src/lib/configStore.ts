import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';


interface SecureTokenPluginApi {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const SecureTokenPlugin = registerPlugin<SecureTokenPluginApi>('SecureToken');

// Open-source builds must never ship a maintainer-specific endpoint.
export const DEFAULT_SERVER_URL = '';

const SERVER_URL_KEY = 'codex.remote.server-url';
const PAIRING_TOKEN_KEY = 'codex.remote.pairing-token';

export interface RemoteConfig {
  serverUrl: string;
  pairingToken: string;
}

export function normalizeServerUrl(input: string): string {
  let value = input.trim();
  if (!value) return '';
  if (!/^[a-z]+:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, '');
}

function isAllowedCleartextHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '10.0.2.2' || hostname === '[::1]') return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  const [first, second] = parts;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

export function toWebSocketUrl(serverUrl: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const url = new URL(normalized);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  if (!/^wss?:$/.test(url.protocol)) throw new Error('服务器地址必须使用 http、https、ws 或 wss');
  if (url.protocol === 'ws:' && !isAllowedCleartextHost(url.hostname)) {
    throw new Error('明文 ws:// 只允许 localhost、Android 模拟器、RFC1918 私有局域网或 Tailscale 100.64.0.0/10 地址；其他地址必须使用 https/wss');
  }
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function getSecureToken(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return window.localStorage.getItem(PAIRING_TOKEN_KEY) ?? '';
  try {
    const result = await SecureTokenPlugin.get({ key: PAIRING_TOKEN_KEY });
    return result.value ?? '';
  } catch {
    return '';
  }
}

export async function loadRemoteConfig(): Promise<RemoteConfig | null> {
  const [{ value: serverUrl }, pairingToken] = await Promise.all([
    Preferences.get({ key: SERVER_URL_KEY }),
    getSecureToken(),
  ]);
  if (!serverUrl || !pairingToken) return null;
  return { serverUrl, pairingToken };
}

export async function saveRemoteConfig(config: RemoteConfig): Promise<RemoteConfig> {
  const serverUrl = normalizeServerUrl(config.serverUrl);
  toWebSocketUrl(serverUrl);
  const pairingToken = config.pairingToken.trim();
  if (!pairingToken) throw new Error('请输入配对令牌');

  await Preferences.set({ key: SERVER_URL_KEY, value: serverUrl });
  if (Capacitor.isNativePlatform()) {
    await SecureTokenPlugin.set({ key: PAIRING_TOKEN_KEY, value: pairingToken });
  } else {
    window.localStorage.setItem(PAIRING_TOKEN_KEY, pairingToken);
  }
  return { serverUrl, pairingToken };
}

export async function clearRemoteConfig(): Promise<void> {
  await Preferences.remove({ key: SERVER_URL_KEY });
  if (Capacitor.isNativePlatform()) {
    try {
      await SecureTokenPlugin.remove({ key: PAIRING_TOKEN_KEY });
    } catch {
      // Missing secure-storage entries are safe to ignore.
    }
  } else {
    window.localStorage.removeItem(PAIRING_TOKEN_KEY);
  }
}

export function storageDescription(): string {
  return Capacitor.isNativePlatform()
    ? '服务器地址保存在 Preferences；令牌由本应用的 Android Keystore AES-GCM 存储保存；应用备份已关闭。'
    : '浏览器预览模式不具备系统级安全存储，仅用于界面调试。';
}
