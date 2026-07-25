# Windows IPC 全量审计（Server）

> 审计与实机验证日期：2026-07-25。范围仅包含 `apps/server`；未修改、构建或测试 Android APK。

## 1. 实时链路

本项目没有 SSE endpoint。Windows 上的实时链路是：

```text
Codex Desktop
  -> \\.\pipe\codex-ipc
  -> uint32LE 长度 + UTF-8 JSON
  -> DesktopIpcBridge
  -> WebSocket /ws
  -> Android 客户端
```

独立启动的 `codex app-server --listen stdio://` 负责持久化历史、任务枚举和 IPC 不可用时的回退，但它不能替代 Desktop owner 的进程内活动状态。

## 2. Windows 实机证据

本机 Codex Desktop `26.721.3996.0`（应用内部版本 `26.721.31836`）暴露固定本地 named pipe：

```text
\\.\pipe\codex-ipc
```

实机握手、主动 following 状态发现和活动任务订阅均已验证：

- `initialize` 返回独立 `clientId`；
- `thread-stream-following-status-requested` 能触发 Desktop 客户端报告当前 following 会话；
- `thread-stream-state-changed` snapshot 返回 `threadRuntimeStatus.type = active`；
- 活动 turn 持续发送带 `baseRevision` / `revision` 的 patches；
- 本机 Server 在 `0.0.0.0:8788` 的 `/health` 返回 `desktopIpcReady: true`；
- WebSocket `sync.resume` 后能立即收到当前 `desktop/threadSnapshot`，无需等待 rollout/session 完成。

## 3. 本次修复

### 传输与初始化

- Windows 默认 endpoint 改为 `\\.\pipe\codex-ipc`；macOS/Linux 继续使用 `~/.codex/ipc/ipc.sock`。
- Windows 不再执行 Unix `lstat/isSocket/uid/mode` 检查；仅接受本机 `\\.\pipe\<simple-name>` 格式，拒绝文件路径和远程 UNC pipe。
- 初始化 requestId 必须匹配；增加 10 秒初始化超时。
- close/reset 时清理半帧 buffer、pending request、owner、revision 和会话状态，并进行有界重连。
- follower response 校验 method、owner client 和连接 generation，避免旧 owner/旧连接的迟到响应完成新请求。
- `/health` 同时报告 `desktopIpcSupported` 和 `desktopIpcReady`。
- 可用 `CMR_DESKTOP_IPC_ENDPOINT` 覆盖 endpoint；仍会执行对应平台的本地 endpoint 安全检查。

### 活动任务发现与恢复

- 初始化完成后主动广播 `thread-stream-following-status-requested`，解决 Desktop 任务先启动、Server 后启动的 late join。
- 处理携带 `conversationId` 的 following status request，并向请求方定向宣布 follower 状态。
- `sync.resume` 不再只恢复 WebSocket subscription；它也恢复 Desktop follow，并向重连客户端发送当前权威 snapshot。
- Desktop IPC 稍后 ready 时，会为当前 WebSocket subscriptions 自动补建 follows。
- `following:false`、IPC reset、pipe close 和 owner loss 会清除陈旧 Desktop overlay，并重新加载 app-server 索引，避免永久假 `active`。

### revisioned 实时状态

- snapshot 建立会话状态和 revision 基线。
- 连续 patches 直接应用到内存态，并立即发出新的 canonical snapshot。
- 旧 revision 被忽略；base revision 不连续、缺少基线或 patch 应用失败时才请求完整 snapshot。
- patch 支持 `add`、`replace`、`remove`，路径为 Desktop 使用的字符串/数字 segment 数组。
- Desktop 状态继续与 app-server 历史合并，避免同一 turn 重复，同时保留 live tail。

### 路由与审批

- Desktop owner 存在时才走 follower；IPC 未 ready 时 `thread.open` 立即回退 app-server，不再额外等待 2.5 秒。
- Desktop interrupt 会校验客户端 turnId 等于当前活动 turn，防止迟到操作中断新 turn。
- “conversation is not being streamed” 不再被当作安全的 inactive 证据，避免不确定状态下错误 fallback `start`。
- app-server offline 只清理 app-server approvals；Desktop approvals 保持有效。
- Desktop offline/reset/owner loss 只清理对应 Desktop approvals。
- legacy `execCommandApproval` / `applyPatchApproval` 映射到 Desktop command/file approval follower 方法。

## 4. 测试覆盖

Server 测试覆盖：

- Windows named pipe 默认 endpoint 与本地格式校验；
- fake named pipe initialize、主动发现、分片帧和 canonical snapshot；
- 连续 patch 即时应用和旧 revision 丢弃；
- Desktop snapshot 只发送给已订阅 WebSocket；
- app-server 与 Desktop 状态合并；
- Desktop offline 后清除陈旧 active overlay；
- reconnect/sync resume 的 Desktop snapshot 恢复；
- Windows/Unix 路径和 `CODEX_HOME` 行为。

验收命令：

```text
npm run typecheck -w @codex-mobile/server
npm run test -w @codex-mobile/server
npm run build -w @codex-mobile/protocol
npm run build -w @codex-mobile/server
```

## 5. 剩余边界

### Named pipe 身份验证

纯 Node `net` API 可以连接 named pipe，但不能直接读取 pipe server PID、token owner 和完整 ACL。因此当前安全边界是：

- endpoint 必须是固定本机 pipe 名；
- Server 与 Codex Desktop 应运行在同一受信 Windows 用户会话；
- 不允许把 `CMR_DESKTOP_IPC_ENDPOINT` 指向远程 pipe；
- `CMR_TOKEN`、allowed origins 和可信网络边界仍必须启用。

如果未来要求抵御“同一 Windows 用户预创建同名 pipe”的本机攻击，需要增加受控 Win32 native helper/addon，校验 server PID、进程签名、用户 SID 和 pipe ACL；这不是 Node 标准库能够完整实现的检查。

### 私有协议升级

Desktop IPC 是私有版本化协议。Codex Desktop 升级后必须复测：

- endpoint 与 framing；
- initialize response；
- broadcast version 表；
- owner discovery；
- snapshot/patch revision 连续性；
- start/steer/interrupt/settings/history/approval 的 wire shape。

发现未知版本时 Server 会记录 diagnostic 并拒绝把该广播当作已支持状态，避免静默误解析。
