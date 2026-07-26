# v0.3.7 Android / Host 发布记录

日期：2026-07-26

## 范围

本版本补齐原生 Computer Use 的 Host runtime、MCP 审批协议和 Android 审批通知去重。Windows Server 兼容性不在本次修改范围。

## Computer Use

- macOS Host 自动探测 ChatGPT/Codex Bundle 内的 `cua_node` Node REPL、Node、node_modules 和 Codex CLI。
- 不修改 `~/.codex/config.toml`；仅对当前 app-server 进程传入覆盖配置，兼容旧配置残留的 `/Applications/Codex.app` 路径。
- app-server 初始化启用 `mcpServerOpenaiFormElicitation`。
- `mcpServer/elicitation/request` 映射到手机审批卡。
- Desktop GUI-owned thread 的响应经 follower IPC 交回原 Desktop owner。
- app-server-owned thread 的响应直接交回 app-server。

## 真机证据

设备：Redmi Note 14 Pro+，Android 14 / SDK 34。

测试线程：`019f9dc5-ed9f-72d1-8af6-3108eeaf381f`。

1. 手机显示“允许 Computer Use 操作？”和 `Allow Computer Use to use "System Information"?`。
2. 手机批准后，原生 `node_repl` MCP item 状态为 `completed`。
3. Computer Use 读取 `com.apple.SystemProfiler` 成功。
4. turn 状态为 `completed`，持续 `59358 ms`，最终回复“读取成功。”。

## 审批通知去重

真机日志证明同一个审批在 `17:34:06.723` 和 `17:34:08.210` 两次进入音频兜底，相隔 `1487 ms`；旧的 900ms 按类别去重无法覆盖前台初始化延迟。

v0.3.7 改为按稳定 notificationId 原子认领：前台 WebView 与后台 Socket 只有一个发布者可播放，另一路只更新审批状态。不同审批即使相邻到达也不会因扩大时间窗而被误吞。

安装 v0.3.7 后的新请求在 `18:11:37.198` 只出现 1 次 `fallback requested kind=approval`；前台 WebView 到 `18:11:59.543` 才调用 `notifyApproval`，但没有第二次音频播放。

同时，`approval.resolved` 只有实际从 pending map 删除审批的路径可以广播，消除主动响应与 app-server `serverRequest/resolved` 的双事件。

## 版本

- 包名：`dev.codexmobile.remote`
- `versionName`：`0.3.7`
- `versionCode`：`11`
- APK：`apps/mobile/artifacts/codex-mobile-remote-v0.3.7-debug.apk`
- SHA-256：`807591cf75e5a1c30ee6fb807c4ea659fbe3496f2413642506e9a1d590333fb9`
- 发布地址：`https://git.qinmouren.cn/QinYuAdmin/CodexRemote/releases/tag/v0.3.7`
