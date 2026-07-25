# Android 后台与通知

## 能力

Android 原生 `CodexBackgroundService` 是用户主动启用的前台服务：

- `START_STICKY`；
- `android:stopWithTask="false"`；
- Android 14+ `foregroundServiceType="specialUse"`；
- 不注册 `BOOT_COMPLETED`，不开机自启；
- 忘记连接配置时主动停止。

从 v0.3.3 起，前台服务内运行独立的 `CodexBackgroundSocket`：

- 从 Android Keystore 加密存储读取配对令牌；
- 使用与 WebView 相同的 `codex-mobile-v1` + `token.<base64url>` WebSocket 子协议；
- 只发送 `threads.list` 应用消息；连接保活使用 OkHttp WebSocket ping frame，不发送提示词、审批决定、任务启动/中断等控制消息；
- 监听任务完成、显式审批、`waitingOnApproval`、`waitingOnUserInput`、任务列表快照和增量；
- 显式审批和完成事件与 WebView 使用相同通知 ID；粗粒度等待状态延迟 2 秒并在显式审批到达时取消；WebView 用 generation guard 阻止“取消后异步复活”；
- WebView 被 HyperOS 冻结时，前台 Service 仍可独立重连并产生本地通知；审批/等待通知的最小索引持久化在本机，Service 进程重建后由首个全量快照做差集清理。

通知渠道：

```text
codex_background_v1   Low   后台连接常驻状态
codex_approvals_v2    High  审批、权限和等待输入，内置 WAV + 震动
codex_completions_v2  High  任务完成/失败/中断，内置 WAV + 震动
```

审批/完成通知包含 `threadId`。点击后支持运行中事件和冷启动持久化两条路径，并用 `nonce` 去重。

## 连接与竞争边界

原生后台连接是只读观察者，不接管 Desktop owner，也不发送会改变任务状态的消息，因此不会与电脑 GUI 或 WebView 竞争审批、提示词队列和任务控制。它会额外占用一条 WebSocket，并只请求任务摘要，不请求会话历史和文件内容。

本地通知不是 FCM：

- Android“强行停止”、设备断网、电脑/bridge 离线时不能实时收到事件；
- 服务被系统终止后依赖 `START_STICKY` 重建，但厂商策略仍可能阻止；
- 不在开机后偷偷重启；
- 没有服务端离线推送队列，断线期间已经完成且重连后只剩 idle 的事件可能无法补发；
- Doze、HyperOS 省电白名单、锁屏和长期后台行为必须在目标手机上验收。

## 自动验证

- TypeScript/Vitest 校验通知渠道、声音资源、通知 ID、快照补偿、当前 turn 梗概和 Subagent 恢复；
- Java/JVM/Robolectric 行为测试校验同任务多审批、逐项解决、进程重建通知索引、首个全量快照清理和 JS/Java 通知 ID 边界；
- 静态校验原生连接不发送任务控制消息；
- Android `compileDebugJavaWithJavac`、`lintDebug`、`assembleDebug`；
- APK 内资源、版本、签名和隐私字符串检查。
