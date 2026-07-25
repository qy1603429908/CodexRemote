# Android 安全架构与验收方案

## 1. 范围

```text
Android App（Vite + React + Capacitor WebView）
        │ WebSocket：Sec-WebSocket-Protocol 鉴权
        ▼
电脑本地 Node.js bridge
        │ 私有 stdio
        ▼
codex app-server
        │
        └── 自定义 Endpoint / API Key（只在电脑）
```

当前版本仅支持 Android；不包含 iOS、Expo Go、账号系统、扫码配对、每设备令牌或应用商店 release 签名。app-server 映射基线为 `codex-cli 0.144.4` experimental 协议。

本文区分：

- **已实现**：源码和自动化测试已覆盖。
- **部署要求**：操作者必须满足的安全条件。
- **尚未实测**：因为本机没有连接 Android 真机而不能声称已验证。

## 2. 已实现事实与源码证据

| 事实 | 原始证据 |
|---|---|
| Android UI 为 Vite + React + Capacitor | `apps/mobile/package.json`、`apps/mobile/capacitor.config.ts` |
| server URL 存 Preferences | `apps/mobile/src/lib/configStore.ts` |
| token 由自有原生插件访问，不写入 Preferences | `configStore.ts`、`SecureTokenPlugin.java` |
| AndroidKeyStore AES-256-GCM，加密失败不降级 | `apps/mobile/android/app/src/main/java/dev/codexmobile/remote/SecureTokenPlugin.java` |
| Android 应用备份关闭 | `apps/mobile/android/app/src/main/AndroidManifest.xml` |
| `CMR_TOKEN` 少于 32 字符时服务端拒绝启动 | `apps/server/src/config.ts` |
| `npm run token` 使用 32-byte CSPRNG 生成 Base64URL token | `apps/server/scripts/generate-token.mjs` |
| WS subprotocol 为 `codex-mobile-v1` 与 `token.<base64url>` | `apps/mobile/src/lib/RemoteSocket.ts` |
| 服务端只选择并回显 `codex-mobile-v1` | `apps/server/src/auth.ts` |
| token digest 使用 timing-safe 比较 | `apps/server/src/auth.ts` |
| 默认监听 `127.0.0.1:8787` | `apps/server/src/config.ts` |
| 明文 WS 允许 localhost、模拟器、RFC1918 私有网段和 Tailscale 100.64/10 | `apps/mobile/src/lib/configStore.ts` 及对应测试 |
| app-server 通过 `codex app-server --listen stdio://` 启动 | `apps/server/src/app-server-bridge.ts` |
| app-server ready 前业务 RPC 会等待初始化 | `apps/server/src/app-server-bridge.ts` |
| 超过 1 MiB 或二进制 WS 消息会被拒绝 | `apps/server/src/gateway.ts` |
| 每 IP 的失败鉴权有 60 秒窗口限流 | `apps/server/src/gateway.ts` |
| 命令、文件和权限审批均路由回 app-server | `apps/server/src/gateway.ts`、`gateway.test.ts` |
| 晚到的文件 Diff 会刷新待审批卡片 | `apps/server/src/gateway.ts`、`gateway.test.ts` |
| 任务列表 UI 按 `cwd` 分组并具备父子层级组件 | `apps/mobile/src/components/ThreadList.tsx` |
| 模型和 effort 通过 `model/list`、`thread/settings/update` 与 `turn/start` 映射 | `apps/server/src/gateway.ts`、`apps/mobile/src/hooks/useRemote.ts` |
| 工具、计划、思考、计时和 token usage 由 app-server item/notification 映射 | `apps/mobile/src/hooks/useRemote.ts`、`MessageBubble.tsx` |
| Android 本地通知调度入口已接入完成与审批事件 | `apps/mobile/src/lib/notifications.ts`、`useRemote.ts` |

## 3. 鉴权协议

客户端建立连接时发送两个 WebSocket subprotocol：

```ts
new WebSocket(wsUrl, [
  "codex-mobile-v1",
  `token.${base64url(CMR_TOKEN)}`,
]);
```

服务端依次验证：

1. 请求路径必须是 `/ws`。
2. 如果请求携带 `Origin`，必须与 allowlist 精确匹配。
3. 必须包含 `codex-mobile-v1`。
4. 必须包含可解码的 `token.<base64url>`。
5. 解码后的 token SHA-256 digest 与配置 digest 做 timing-safe 比较。
6. 成功响应只选择 `codex-mobile-v1`，不回显 `token.*`。

`Origin` 是纵深防御，不是身份凭据；真正鉴权边界是随机高熵 token。当前 token 是长期共享秘密，因此必须结合 tailnet/TLS 网络边界。

## 4. Token 保存与轮换

电脑端：

```bash
cd /path/to/codex-mobile-remote
npm run host:setup
stat -f '%Sp %N' .env
```

期望 `.env` 权限为 `-rw-------`。要求：

- 不把 `.env`、token、模型 API Key 提交到 Git。
- 不把 token 放入 URL、命令行参数、截图、日志或工单。
- 自定义模型 API Key 与 `CMR_TOKEN` 是两个不同秘密，均不得下发到手机。

Android 原生端：

- Preferences 只存服务器地址。
- `SecureTokenPlugin` 使用 AndroidKeyStore AES-GCM 保存 token。
- Keystore 初始化、加密或解密失败时返回错误或视为无有效配置，不降级到明文。
- “清除配置”同时移除地址和加密 token。
- 浏览器预览使用 localStorage，仅用于界面开发；不得输入生产 token。

手机丢失时：

1. 在电脑生成新 `CMR_TOKEN`。
2. 更新 `.env` 并重启 bridge，使旧连接和旧 token 失效。
3. 从 Tailscale 移除丢失手机。
4. 可信设备重新输入新 token。

当前不支持单设备撤销；轮换会影响所有手机。

## 5. 网络部署要求

### 推荐方案

```text
bridge：127.0.0.1:8787
Tailscale Serve / TLS reverse proxy：https://<host>.<tailnet>.ts.net -> http://127.0.0.1:8787
Android：https/wss + tailnet
```

### 可接受的简化方案

- bridge 直接绑定电脑的 Tailscale `100.x` 地址，Android 使用 `http://100.x.y.z:8787`。传输由 tailnet 承载，但应用层不是 TLS。
- 在可信家庭/办公网络中，bridge 可绑定具体 RFC1918 地址，例如 `192.168.1.20`，Android 使用 `http://192.168.1.20:8787`。该模式没有应用层 TLS，同一二层网络、恶意接入点或被攻陷的路由设备可能观察握手中的长期 token。

### 禁止或拒绝

- App 拒绝公网 IP、非私有地址和域名上的 `ws://`；这些目标必须使用 HTTPS/WSS。
- 不应设置 `CMR_HOST=0.0.0.0` 后直接暴露到不可信网络。
- 不应启用 Tailscale Funnel 或公网端口映射。
- WSS 必须由 Tailscale Serve 或可信 TLS 反向代理终止；Node bridge 本身只提供 HTTP/WS。

Android manifest 保留 `usesCleartextTraffic=true`，用于私有局域网、Tailscale 直连和模拟器；JS 配置校验会拒绝公网等其他明文目标。服务端无法阻止恶意自制客户端，所以网络暴露仍由部署者负责。

## 6. 审批安全

支持的 app-server 反向请求：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- 兼容旧协议的 `execCommandApproval`
- 兼容旧协议的 `applyPatchApproval`

规则：

- 未知 callback 返回 `-32601`，不得默认同意。
- app-server 离线或发送 `serverRequest/resolved` 时清除待审批项。
- 权限审批按 turn/session scope 返回请求过的非空权限。
- 文件 Diff 先到则直接附加；Diff 后到则重新广播同一审批 ID，Android 端 upsert 更新卡片。
- App 只在真实 `turn/completed` 到达时结束 turn；中断 RPC 成功不伪造完成事件。


## 6.5 运行态、Subagent 与通知边界

### Desktop IPC 与真实状态同步

bridge 仍会启动自己的 `codex app-server --listen stdio://` 读取历史，但 macOS Desktop GUI 还持有用户私有 UDS：`~/.codex/ipc/ipc.sock`。原始验证：socket 权限为 `srw-------`、属主为当前用户；静态检查 Desktop `app.asar` 证明它是 4-byte little-endian JSON frame 的 IPC router；一次只读订阅实际返回当前 GUI 任务的 `threadRuntimeStatus: { type: "active", activeFlags: [] }`。

`DesktopIpcBridge` 以 `codex-mobile-remote` clientType 注册，响应 client discovery 为 `canHandle:false`，作为 follower 订阅 `thread-stream-state-changed`。它会请求完整 canonical history，并把 turn、设置、压缩、中断、命令/文件/权限审批决定定向发给同一 Desktop owner；owner 不可用时才回退独立 app-server。可用 `CMR_DESKTOP_IPC=0` 停用。Desktop IPC 是私有版本化协议，Codex Desktop 更新后须复核。原始联调见 `docs/desktop-ipc.md`。

### Subagent 边界

当前 gateway 已显式请求所有交互式及 Subagent `sourceKinds`，并兼容顶层 `parentThreadId` 与 `source.subAgent.thread_spawn.parent_thread_id`。本机真实 wire 联调已观察到目录内父任务和 Subagent 层级；Android 真机小屏触控仍未验证。

### Android 本地通知边界

本地通知不是推送服务：

- 没有 FCM；
- 有用户主动启动的原生前台 Service 作为后台运行基础，但 WebSocket 重连仍由客户端连接层负责；
- 没有离线完成事件的服务端持久队列、跨主机推送或开机自启补偿；
- 只有 App/WebSocket 实际收到 `turn/completed` 或审批事件时，通知才可靠；
- App 被休眠、杀死或断网时可能漏通知；
- 同一文件审批因 Diff 更新被再次广播时，审批卡片更新，但通知按 request ID 去重。

通知权限、渠道显示、前后台行为、Doze 和进程被杀后的表现均尚未在 Android 真机验证。

## 7. 自动化验收

```bash
cd /path/to/codex-mobile-remote
npm run typecheck
npm test
npm run build
npm run build:android
```

源码静态核对：

```bash
rg -n 'SecureTokenPlugin|AndroidKeyStore|AES/GCM/NoPadding' apps/mobile/src apps/mobile/android/app/src/main/java
rg -n 'Preferences\.(set|get|remove)' apps/mobile/src/lib/configStore.ts
rg -n 'CMR_TOKEN|token\.|codex-mobile-v1|allowedOrigins' apps/server/src apps/mobile/src
rg -n 'spawn\(|stdio://|shell: false' apps/server/src/app-server-bridge.ts
! rg -n 'console\.(log|debug).*token' apps/mobile/src apps/server/src
```

注意：`configStore.ts` 的 browser-only 分支会出现 localStorage，这是预期的 UI 预览兼容代码；原生 Android 分支不走该路径。

## 8. 手工服务端验收

启动：

```bash
cd /path/to/codex-mobile-remote
npm run host:start >/tmp/cmr-server-test.log 2>&1 &
CMR_PID=$!
trap 'kill "$CMR_PID" 2>/dev/null || true' EXIT
sleep 2
curl -fsS http://127.0.0.1:8787/health
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

期望：

- `/health` 只返回 `ok/service/version`。
- 默认监听 `127.0.0.1:8787`，不是 `*:8787`。
- 正确 token 可连接，错误 token、错误 Origin 或缺少主协议会被拒绝。
- 成功握手选择的协议只有 `codex-mobile-v1`。

这些鉴权路径已固化为 server 单元测试。

## 9. APK 验收

```bash
APK=/path/to/codex-mobile-remote/apps/mobile/artifacts/codex-mobile-remote-debug.apk
shasum -a 256 "$APK"
$ANDROID_HOME/build-tools/35.0.0/apksigner verify --verbose "$APK"
$ANDROID_HOME/build-tools/35.0.0/aapt dump badging "$APK"
```

期望：APK 可通过签名验证，包名为 `dev.codexmobile.remote`，minSdk 24，包含 `android.permission.INTERNET`。

## 10. Android 真机验收（尚未执行）

因为开发机当前没有已连接设备，以下必须在真机上补做：

```bash
adb devices -l
adb install -r /path/to/codex-mobile-remote/apps/mobile/artifacts/codex-mobile-remote-debug.apk
```

使用测试 canary token 后检查：

```bash
adb logcat -c
# 在 App 中保存 TEST_TOKEN 并连接一次
adb logcat -d | rg -n 'TEST_TOKEN_CANARY|token\.' && exit 1 || true
adb shell run-as dev.codexmobile.remote grep -R 'TEST_TOKEN_CANARY' . && exit 1 || true
```

还需验证：

- 首次保存、重启后读取、清除配置后的 Keystore 完整闭环。
- 前后台切换、旋转、系统返回键和长消息滚动。
- Tailscale/WSS 实网连接、断网重连和 token 轮换。
- 文件/命令/权限审批在真机上的可读性与操作确认。
- Android 13+ 通知权限、完成/失败/中断/审批通知渠道和点击行为。
- 前台、后台、Doze、断网、App 被系统杀死时的通知边界；预期被杀死/离线时不保证收到，因为没有 FCM 或补偿。
- 目录分组、明确的“未载入”状态、模型/effort 选择、Slash 候选、工具详情和思考梗概的小屏可用性。

## 11. 后续增强

- 每设备独立 token、设备列表和单设备撤销。
- 扫码首次配对和短时单次 pairing secret。
- 短期 WebSocket ticket，避免长期 token 出现在握手 subprotocol。
- Android 生物识别解锁和后台任务画面遮罩。
- 每连接消息速率、并发连接和会话配额。
- 正式 release signingConfig 与应用商店发布流程。

## Host 队列与 Git Diff 安全边界（2026-07-25）

### 提示词队列

- 默认持久化：`~/.codex-mobile-remote/prompt-queue.json`。
- 父目录权限 `0700`，文件权限 `0600`，临时文件写完后原子 `rename`。
- 排队项保留文本、turn 参数和 Host 侧附件路径，因此该文件按敏感本地数据处理，不进入 Git。
- `clientUserMessageId` 同内容幂等；同 ID 不同内容拒绝。
- `sending` 状态遇到 Host 重启恢复为 `uncertain`，禁止自动重试，避免重复用户消息。
- 不直接写 Desktop `thread-follower-set-queued-follow-ups-state`：该接口整份覆盖全局队列且没有 CAS，会破坏其他会话队列。

### Git Diff

- 仓库检测仅执行 `git -C <任务 cwd> rev-parse --show-toplevel`；不递归扫描子目录，不采信工具调用过程中出现的 cwd。
- 所有 Git 命令使用 `execFile` 参数数组，不经过 shell；启用 `GIT_OPTIONAL_LOCKS=0`。
- 单命令超时 15 秒；总 diff 最多 2 MiB；未跟踪文件最多 40 个，单个未跟踪文件最多展开 256 KiB。
- 非 Git 任务目录不向 UI 暴露占位面板。

## Desktop 附件与双队列安全边界（2026-07-25 15:26）

### Desktop canonical 附件

- Host 只从 canonical user/steeringUserMessage 的 `input.localImage`、`attachments`、`restoreMessage.context.imageAttachments/fileAttachments` 注册附件。
- 注册单位是精确 canonical realpath，不是父目录；工具输出和任意命令文本中的 path 不产生权限。
- 注册时验证 regular file 与下载大小上限；记录按 TTL 过期。
- 实际下载仍需 bearer token 创建一次性 ticket，并在 claim 时再次校验 inode/dev/size，防止换文件竞态。
- 回归测试证明：被注册的临时图片可下载，同目录 sibling 仍返回 `PATH_NOT_ALLOWED`。

### Desktop 原生队列与 Host 队列

- Desktop 的 `thread-follower-set-queued-follow-ups-state` 是整份全局状态覆盖；没有 getter、revision 或 CAS，禁止调用。
- Electron 内部 `queued-follow-up-send-lock-acquire/release` 没有 follower 入口，Host 无法加入同一原子 claim。
- 因此 Desktop owner 存在时 Host 队列只持久化、不自动 `turn/start`；空闲时手机强制 promote 返回 `desktop_queue_coordination_required`。
- 只有活动 turn 的显式“立即引导”走 `turn/steer(expectedTurnId)`；只有 Desktop owner 不存在时 Host 才通过 app-server 自动 drain。
