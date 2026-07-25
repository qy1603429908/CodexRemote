import type { ClientMessage, ConnectionPhase, ServerMessage } from '../types/protocol';
import { isServerMessage, WIRE_PROTOCOL } from '../types/protocol';
import { toWebSocketUrl } from './configStore';

interface RemoteSocketOptions {
  serverUrl: string;
  token: string;
  onMessage: (message: ServerMessage) => void;
  onPhase: (phase: ConnectionPhase, detail?: string) => void;
}

const MAX_RECONNECT_DELAY = 20_000;
const HEARTBEAT_INTERVAL = 20_000;

function base64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export class RemoteSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectAttempts = 0;
  private manuallyClosed = false;
  private welcomed = false;
  private networkListenersInstalled = false;

  constructor(private readonly options: RemoteSocketOptions) {}

  connect(): void {
    this.manuallyClosed = false;
    this.installNetworkListeners();
    if (navigator.onLine === false) {
      this.options.onPhase('offline', '手机当前没有网络连接；访问局域网主机时请连接同一 Wi-Fi');
      return;
    }
    this.open(false);
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.welcomed = false;
    this.clearTimers();
    this.removeNetworkListeners();
    this.socket?.close(1000, 'client disconnect');
    this.socket = null;
    this.options.onPhase('offline');
  }

  reconnectNow(): void {
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
    this.reconnectAttempts = 0;
    this.manuallyClosed = false;
    this.open(false);
  }

  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.welcomed) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private open(reconnecting: boolean): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    if (navigator.onLine === false) {
      this.options.onPhase('offline', '手机当前没有网络连接；访问局域网主机时请连接同一 Wi-Fi');
      return;
    }

    let wsUrl: string;
    try {
      wsUrl = toWebSocketUrl(this.options.serverUrl);
    } catch (error) {
      this.options.onPhase('error', error instanceof Error ? error.message : '服务器地址无效');
      return;
    }

    this.options.onPhase(reconnecting ? 'reconnecting' : 'connecting');
    const tokenProtocol = `token.${base64UrlUtf8(this.options.token)}`;
    const socket = new WebSocket(wsUrl, [WIRE_PROTOCOL, tokenProtocol]);
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.welcomed = false;
    };

    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      try {
        const payload: unknown = JSON.parse(String(event.data));
        const messages = Array.isArray(payload) ? payload : [payload];
        for (const message of messages) {
          if (!isServerMessage(message)) continue;
          if (message.type === 'welcome') {
            this.welcomed = true;
            this.reconnectAttempts = 0;
            this.options.onPhase('connected', message.codexReady ? undefined : 'Bridge 已连接，但 Codex app-server 尚未就绪');
            this.startHeartbeat();
          }
          this.options.onMessage(message);
        }
      } catch {
        this.options.onPhase('error', '收到无法解析的服务器消息');
      }
    };

    socket.onerror = () => {
      if (socket === this.socket && !this.welcomed) {
        this.options.onPhase('error', '连接失败，请检查地址和配对令牌');
      }
    };

    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.welcomed = false;
      this.stopHeartbeat();
      if (!this.manuallyClosed) {
        const detail = event.reason
          || (event.code === 1006
            ? '无法连接主机，请检查手机 Wi-Fi、服务器地址和配对令牌'
            : `连接已关闭（代码 ${event.code}）`);
        this.scheduleReconnect(detail);
      }
    };
  }


  private readonly handleNetworkOffline = (): void => {
    if (this.manuallyClosed) return;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    socket?.close(1000, 'device offline');
    this.options.onPhase('offline', '手机当前没有网络连接；访问局域网主机时请连接同一 Wi-Fi');
  };

  private readonly handleNetworkOnline = (): void => {
    if (!this.manuallyClosed) this.reconnectNow();
  };

  private installNetworkListeners(): void {
    if (this.networkListenersInstalled) return;
    window.addEventListener('offline', this.handleNetworkOffline);
    window.addEventListener('online', this.handleNetworkOnline);
    this.networkListenersInstalled = true;
  }

  private removeNetworkListeners(): void {
    if (!this.networkListenersInstalled) return;
    window.removeEventListener('offline', this.handleNetworkOffline);
    window.removeEventListener('online', this.handleNetworkOnline);
    this.networkListenersInstalled = false;
  }

  private sendRaw(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(reason?: string): void {
    this.reconnectAttempts += 1;
    const exponential = Math.min(MAX_RECONNECT_DELAY, 800 * 2 ** (this.reconnectAttempts - 1));
    const jitter = Math.floor(Math.random() * 400);
    const delay = exponential + jitter;
    const timing = `${Math.ceil(delay / 1000)} 秒后重试`;
    this.options.onPhase('reconnecting', reason ? `${reason}，${timing}` : timing);
    this.reconnectTimer = window.setTimeout(() => this.open(true), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendRaw({ type: 'ping', id: `ping_${Date.now()}` });
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
  }
}
