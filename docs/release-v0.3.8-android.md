# v0.3.8 Android / Host 发布记录

日期：2026-07-26

## 范围

本版本针对三个现场问题修复：

1. Desktop GUI 没有审批、任务已经结束或审批已失效时，手机客户端仍显示幽灵审批卡；
2. 手机上传的图片/文件在一小时 TTL、提交后释放或 Host 重启后的 orphan cleanup 中消失；
3. Subagent 完成被误报为主任务完成，点击通知跳到 Subagent。

Windows Server 兼容性不在本次修改范围。

## 修复与协议

- Host 在 WebSocket 重连后发送 `approvals.snapshot`，客户端按快照全量删除离线期间漏掉 resolved 事件遗留的审批卡、状态和通知。
- Desktop-owned 任务的命令、文件和权限类 app-server 镜像审批不再转发到手机；`mcpServer/elicitation/request`（Computer Use）仍保留手机审批。
- `item/completed`、命令/文件 item 完成和 `turn/completed` 主动清除对应 app-server pending approval。
- 已进入持久化消息的上传目录写入 `.codex-remote-committed`，跳过一小时 TTL 和重启后的 orphan cleanup；未提交临时上传仍按 TTL 清理。
- WebView 和 Android 后台 Socket 均只对根任务发送完成通知，Subagent 完成只更新状态。

协议与持久化细节已同步到：

- `docs/app-server-protocol.md` 的“手机桥接层的审批权威快照（v0.3.8）”；
- `docs/file-transfer.md` 的“已提交上传的持久化与 Desktop canonical 附件信任”；
- `docs/android-background.md` 的后台通知说明。

## 自动化验证

- Protocol / Server / Mobile TypeScript typecheck：通过。
- Server Vitest：`81 passed, 2 skipped`（共 83 个测试）。
- Mobile Vitest：`162 passed`。
- Android `testDebugUnitTest`：通过。
- Android debug APK 构建：Gradle `BUILD SUCCESSFUL`。
- Host 重启后本地鉴权 WebSocket：收到 `welcome`，随后收到权威 `approvals.snapshot`，当前快照为 `[]`。
- 本地和公网 `https://qycode.qinmouren.cn/health`：均返回 `ok: true`，`desktopIpcReady: true`。

## APK

- 包名：`dev.codexmobile.remote`
- `versionName`：`0.3.8`
- `versionCode`：`12`
- APK：`apps/mobile/artifacts/codex-mobile-remote-v0.3.8-debug.apk`
- 文件大小：约 5.2 MiB
- SHA-256：`caeb19b5480e2c81d4bc311e288655075e1db9149900dea43d967db5ce6d67ea`
- 构建元数据已由 `aapt dump badging` 校验为 `versionCode='12' versionName='0.3.8'`。

## 安装校验

发布的是 debug APK。安装前请使用上面的 SHA-256 校验文件完整性。
