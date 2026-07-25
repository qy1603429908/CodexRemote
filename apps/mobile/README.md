# Codex Remote Android

基于 Vite、React、TypeScript 和 Capacitor 的 Android 客户端。App 通过 WebSocket 连接电脑上的 Codex Mobile Remote bridge；自定义模型端点和 API Key 不进入手机。

当前 app-server 映射基线为本机 `codex-cli 0.144.4` experimental 协议；升级 Codex 后必须重新核对生成类型和真实 wire。

## 当前客户端能力

- 任务列表按工作目录分组；bridge 显式请求全部 Subagent source kinds，并兼容顶层 `parentThreadId` 与 `source.subAgent.thread_spawn.parent_thread_id`，展示主任务/Subagent 层级和 Agent nickname/role。
- 任务页可选择 `model/list` 返回的模型和模型支持的 reasoning effort；选择结果通过 `thread/settings/update` 和后续 `turn/start` 传给电脑端 app-server。
- 输入 `/` 会显示命令、模型和当前目录 Skill 候选。
- 客户端支持 `/status`、`/compact`、`/help`、`/models`、`/model:<id>`、`/effort:<level>`、`/skills` 和 `/skill:<name> <prompt>`；它们会被转换成明确的本地动作、`thread/settings/update`、`thread/compact/start` 或结构化 `turn/start` 输入。
- 助手回复以安全的 React Markdown 渲染（标题、列表、引用、链接、行内/围栏代码）；工具详情以可折叠卡片展示，统一 Diff 和 fileChange 采用按行增删色块。
- 命令、文件修改和额外权限请求以审批卡片显示；除本次允许、会话内允许、拒绝和取消外，也支持 app-server 提供的 execpolicy/network policy 结构化修订决策。Legacy 审批的 `conversationId`、`callId` 和 `command: string[]` 也会正规化。

### Desktop IPC、Subagent 与后台

打开 Desktop GUI 正在拥有的任务时，手机加入同一 `thread-stream` 作为 follower；完整 canonical 历史、手机新 turn、模型/权限设置、中断和审批决定都由 Desktop owner 处理。手机客户端不再用空 `turns` 覆盖历史。协议与验证证据见 `../../docs/desktop-ipc.md`。

任务列表使用 app-server cursor 分页，最多聚合 1000 条，并显示明确的 `未载入 / 空闲 / 执行中 / 待审批 / 待输入 / 异常` 状态。Subagent 在目录任务树中默认折叠；会话内活动以顶部横滑 chip 和无气泡工具时间线展示。

Android 原生前台服务提供后台运行基础，审批使用 High 渠道，完成通知使用 Default 渠道；只有未聚焦对应会话时通知。详细边界见 `../../docs/android-background.md`。

### 文件与权限

- 输入框 `＋` 可选图片或文件，先流式上传到电脑，再以 `localImage`/`mention` 输入发送给 Codex。
- `/download <电脑绝对路径>` 创建短 TTL、默认一次性的下载票据；Android 10+ 原生插件写入公共 Downloads；Android 7–9 写入 App 专用 Downloads 并返回 FileProvider URI。
- 权限选择对应 Desktop 的 `auto`、`granular`、`read-only`、`guardian-approvals`、`full-access` 预设。协议证据见 `../../docs/file-transfer.md`。

## 安全存储

- 服务器地址保存在 Capacitor Preferences。
- 配对令牌由项目内置的 Android 原生 `SecureTokenPlugin` 保存。
- 插件使用 Android Keystore 生成不可导出的 AES-256 密钥，以 AES-GCM 加密令牌；任何 Keystore 异常均失败关闭，不降级为 Base64 或明文。
- `android:allowBackup="false"`，避免应用数据进入 Android 备份。
- 令牌通过 WebSocket subprotocol 发送：`codex-mobile-v1` 与 `token.<base64url>`，不会写入 URL。
- 浏览器预览仅用于 UI 调试，会使用 localStorage；不要在浏览器预览中输入真实令牌。

## 开发

```bash
npm install
npm run dev -w @codex-mobile/mobile
```

## 同步 Android 工程

```bash
npm run android:sync -w @codex-mobile/mobile
npm run android:open -w @codex-mobile/mobile
```

Android 原生工程位于 `android/`，可直接用 Android Studio 打开。

## 构建 APK

```bash
npm run android:apk -w @codex-mobile/mobile
```

产物：

```text
artifacts/codex-mobile-remote-debug.apk
```

构建脚本只生成带 Android debug 签名的可安装包，不伪装成正式 release 包。应用商店发布需另行配置自己的 release signingConfig。

## 网络

客户端固定连接配置主机的 `/ws` 路径：

- `https://` 自动转换为 `wss://`；
- `http://` 自动转换为 `ws://`；
- 明文 `ws://` 允许 localhost、Android 模拟器 `10.0.2.2`、RFC1918 私有网段（`10/8`、`172.16/12`、`192.168/16`）或 Tailscale `100.64.0.0/10`；
- 其他地址必须使用 HTTPS/WSS。

推荐让 bridge 保持监听 `127.0.0.1`，并通过 Tailscale Serve 提供 HTTPS/WSS。可信家庭/办公局域网也可以把 bridge 绑定到具体的私有 IP，但该模式没有应用层 TLS。
