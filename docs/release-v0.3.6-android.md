# v0.3.6 Android 发布记录

日期：2026-07-26

## 范围

本版本只包含 Android/移动客户端、测试和文档变更，不包含 Windows Server 或服务端协议改动。

## 修复

- Android 状态栏、刘海和底部手势区安全区域。
- 审批、等待输入、任务完成的独立通知通道、不同提示音和迟到通知竞争。
- 运行中权限/审阅模式选择与状态提示。
- 活跃状态、思考梗概快照和缓存一致性。
- Subagent 结构化名称解析、对应工具行内 16px 紧凑跳转标签。
- item 时间来源分级：精确时间、实时事件时间、首次观察时间和隐藏的 turn 回退时间。
- 新 snapshot 不得把准确/观察时间覆盖回 turn 开始时间。

## 真机证据

设备：Redmi Note 14 Pro+，型号 `24115RA8EC`，Android 14 / SDK 34。

- `Subagent · sendInput` 与 `Lorentz` 标签同一行。
- 标签测量约 `49.6 × 16 CSS px`。
- 旧工具项不再显示错误的 turn 开始时间 `12:53`。
- 在线新增工具项显示 `≈15:38`、`≈15:39`，明确表示客户端首次观察时间。

## 测试

```text
npm run typecheck
npm test
```

结果：12 个测试文件、160 项测试全部通过。

## Computer Use 审批验证边界

独立目录任务的两轮原始证据：

1. `granular`：managed workspace-write，但 `sandbox_approval=false`，没有审批事件。
2. `auto`：`approval_policy=on-request`，产生真实 `item/commandExecution/requestApproval`；Redmi 上存在 `codex_approvals_v4` 活动通知和审批音。

但 app-server 创建的任务没有 Codex GUI 注入的 Computer Use tool surface。任务实际用 `exec_command` 手动启动 Computer Use launcher，因此手机审批卡显示“允许执行命令”，这不是原生 Computer Use 工具审批。原生 Computer Use 手机审批仍需在 GUI 创建的任务中复验。

app-server `thread.start` 创建的任务也不会自动出现在 Desktop GUI；当前 Desktop IPC 只有跟随/启动已有 Desktop-owned thread 的接口，没有创建 GUI 任务的 IPC。

## Desktop GUI 完成提示音兜底

2026-07-26 16:11:04（北京时间），当前 GUI 任务原始 rollout 已写入一字回复的 `task_complete`，但 Redmi logcat 没有对应 completion fallback。修复后 Android 后台 socket 会将已知任务的 active→idle/error 状态转换视为缺失 `turn/completed` 时的完成信号，延迟 900ms 等待显式事件；显式事件与状态 fallback 在 2.5 秒内去重。Xiaomi MediaPlayer 兜底音按类别再做 900ms 去重，避免 WebView/后台双通道重复播放。

## APK

- 包名：`dev.codexmobile.remote`
- `versionName`：`0.3.6`
- `versionCode`：`10`
- APK：`apps/mobile/artifacts/codex-mobile-remote-v0.3.6-debug.apk`
- SHA-256：`1cd32663e5cf1b7347ea56e283d53d04edad1df1cc41ad0a5b43e961abc97837`
