# Codex Mobile Remote（Android）

一个自托管、可直接侧载的 Android Codex 遥控器。手机连接你自己的 Host bridge；模型 endpoint、provider 和 API Key 始终留在电脑端。

> 项目仍依赖 Codex Desktop 的私有 IPC 与实验性 app-server 协议。升级 Codex Desktop/CLI 后，应重新执行协议与真机回归。

```text
Android App（Capacitor + 原生前台服务）
        │  WebSocket/HTTP + 高熵配对令牌
        ▼
Host bridge（Node.js）
        ├── Desktop IPC follower（GUI 任务历史、turn、审批与状态）
        └── codex app-server（任务枚举、未打开任务与回退）
                │
                ▼
        主机侧 Codex 配置与 API Key
```

## 功能

- 按 `cwd`/项目目录分页展示 Codex 任务，支持打开、恢复和新建任务；
- 与 Desktop GUI 同时查看同一任务，并同步 Markdown 回复、工具调用、Subagent、TODO、思考状态、审批和 Git diff；
- 选择 Host 返回的模型、reasoning effort 与权限/审阅预设；
- 支持 `/status`、`/compact`、模型、effort 和 Skill 等引导命令；
- 连续工具调用整体折叠；阅读上文时不强制跳到底部；
- 图片/文件上传、受限下载、Android 后台前台服务与审批/完成通知；
- IndexedDB/localStorage 增量缓存、cursor 断点续传和手动“清空缓存并全量刷新”；
- Android Keystore + AES-GCM 保存配对令牌；
- 生成带 debug 签名、可直接侧载的 APK，不依赖 Expo Go。

## 安全边界

- 手机不会获得模型 API Key；bridge 只继承电脑已有的 Codex 配置和环境；
- WebSocket 使用至少 32 字符的随机 `CMR_TOKEN` 鉴权，令牌不放在 URL 中；
- 默认只监听 `127.0.0.1`；远程访问优先使用 Tailscale Serve、VPN 或 HTTPS/WSS 反向代理；
- 明文连接仅允许 localhost、Android 模拟器、RFC1918 私网和 Tailscale `100.64.0.0/10`；
- 不要把 bridge 端口直接映射到公网；
- 文件下载只允许 `CMR_FILE_ROOTS` 中的 canonical regular file，symlink 越界会被拒绝。

更多边界见 [`docs/security-and-testing.md`](docs/security-and-testing.md)。

## 1. 安装依赖

```bash
git clone <repository-url>
cd CodexRemote
npm install
```

要求：

- Node.js 22+；
- 本机可以运行 `codex`；
- 自定义 provider/endpoint/API Key 已在主机 Codex 中验证可用；
- 构建 APK 需要 JDK 21 和 Android SDK。

## 2. 初始化 Host

```bash
npm run host:setup
```

该命令创建权限为 `0600` 的 `.env`，并生成随机 `CMR_TOKEN`。默认配置：

```dotenv
CMR_HOST=127.0.0.1
CMR_PORT=8787
CMR_TOKEN=<generated-random-token>
# CMR_FILE_ROOTS=/path/to/allowed/root,/another/allowed/root
```

启动：

```bash
npm run host:start
curl http://127.0.0.1:8787/health
```

### 连接方式

- **Tailscale Serve / HTTPS**：保持 `CMR_HOST=127.0.0.1`，把 TLS 入口反向代理到 `127.0.0.1:8787`；
- **Tailscale IP**：绑定电脑的 `100.x.y.z` 地址，手机填写 `http://100.x.y.z:8787`；
- **可信局域网**：绑定如 `192.168.1.20`，手机填写 `http://192.168.1.20:8787`。

公网 Nginx 模板见 [`deploy/nginx/codex-mobile-remote.example.conf`](deploy/nginx/codex-mobile-remote.example.conf) 和 [`docs/public-reverse-proxy.md`](docs/public-reverse-proxy.md)。

## 3. App 首次设置

开源构建**不会预填任何维护者或生产服务器地址**。首次启动需要填写：

- 服务器地址，例如 `https://codex.example.com`、`http://100.x.y.z:8787` 或可信 LAN 地址；
- 主机 `.env` 中的 `CMR_TOKEN`。

App 自动连接服务器的 `/ws`。Android 原生环境中，配对令牌使用 Android Keystore AES-256-GCM 加密保存；应用备份已关闭。

## 4. 构建和安装 APK

```bash
npm run build:android
```

本地产物：

```text
apps/mobile/artifacts/codex-mobile-remote-v0.3.3-debug.apk
```

正式交付 APK 发布在 Gitea Releases，不提交进源码 Git。

安装：

```bash
adb install -r apps/mobile/artifacts/codex-mobile-remote-v0.3.3-debug.apk
```

这是 `versionName=0.3.3`、`versionCode=7` 的 debug 签名侧载包，不是应用商店正式签名包。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
npm run build:android
```

开发模式：

```bash
npm run host:dev
npm run dev
```

本地增量同步回归：

```bash
npm run test:public-sync -- ws://127.0.0.1:8787/ws
```

## 文档

- [`docs/requirements-and-todo.md`](docs/requirements-and-todo.md)：需求账本；
- [`docs/desktop-ipc.md`](docs/desktop-ipc.md)：Desktop 私有 IPC 探测结果；
- [`docs/app-server-protocol.md`](docs/app-server-protocol.md)：app-server 协议基线；
- [`docs/incremental-sync-v0.3.md`](docs/incremental-sync-v0.3.md)：增量同步与缓存；
- [`docs/android-background.md`](docs/android-background.md)：Android 后台与通知；
- [`docs/file-transfer.md`](docs/file-transfer.md)：文件安全边界；
- [`docs/test-evidence.md`](docs/test-evidence.md)：公开测试证据规则。

## License

MIT. See [`LICENSE`](LICENSE).
