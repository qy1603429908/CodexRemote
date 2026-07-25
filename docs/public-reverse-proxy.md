# 公网 HTTPS/WSS 反向代理

Codex Mobile Remote 默认只监听 `127.0.0.1:8787`。如需跨公网访问，建议让受信任的 TLS 反向代理提供 HTTPS/WSS，并继续使用高熵 `CMR_TOKEN`。

```text
Android App
  -> https://codex.example.com
  -> Nginx / Caddy / Tailscale Serve
  -> http://127.0.0.1:8787
  -> Codex Mobile Remote Host
```

## Nginx 示例

仓库模板：`deploy/nginx/codex-mobile-remote.example.conf`。

使用前必须替换域名、证书路径以及 `proxy_pass` 的可信 Host 地址。验证命令：

```bash
curl https://codex.example.com/health
npm run test:public-sync -- wss://codex.example.com/ws
```

## CDN / 长连接要求

- 必须允许 WebSocket Upgrade；
- 不应缓存 `/ws`、`/health` 和 `/api/files/*`；
- WebSocket idle timeout 应足够长；
- 源站 bridge 端口不要直接暴露到公网；
- CDN 不是身份认证，`CMR_TOKEN` 仍然必需；
- 上传大小限制需不小于 Host 的 `CMR_MAX_UPLOAD_BYTES`。

若无需公网共享，优先使用 Tailscale Serve、VPN 或可信局域网。客户端允许 RFC1918 和 Tailscale CGNAT 地址上的明文 `http/ws`，公网地址则要求 `https/wss`。
