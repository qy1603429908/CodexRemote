# v0.3.3 Android 发布记录

日期：2026-07-25

## 范围隔离

本版本仅修改 Android/移动客户端与对应测试、文档；没有修改 `apps/server`、Desktop IPC 或 Windows 兼容实现。开发位于独立分支 `fix/android-safe-area-notifications-v0.3.3`，供后续 Windows 分支合并。

## 系统栏与安全区

- 改用 Capacitor 8 内置 `SystemBars` 作为唯一 Android inset 所有者，启用 `insetsHandling: css`。
- 使用 `--safe-area-inset-*` → Web 标准 `env(safe-area-inset-*)` 的统一 fallback，兼容较旧 Android System WebView。
- 修复后置 `.conversation-top-bar` 覆盖顶部安全区，导致标题、返回按钮进入挖孔区域的问题。
- 顶部栏、任务列表、输入区、思考梗概栏、上下文压缩栏、bottom sheet、toast、Subagent 弹层均处理上下左右安全区。
- 主题色、启动背景和系统栏图标调整为与浅色 UI 一致。

## Android 通知与提示音

- 任务完成、失败、中断在当前任务前台也会发送系统通知。
- 显式审批、额外权限请求、`waitingOnUserInput`、仅状态型 `waitingOnApproval` 均接入高优先级通知。
- 通知初始化使用可重试共享 Promise，不再因首次竞态、异常或权限暂时拒绝而在整个 WebView 生命周期内永久失效。
- 通知成功与去重状态关联；发送失败会允许重试并显示可见错误。
- 使用新的 Android 通知渠道：
  - `codex_approvals_v2`
  - `codex_completions_v2`
- 两个渠道均为高优先级，绑定内置 `codex_notification.wav` 提示音及振动。
- 状态型审批通知延迟 2 秒，优先等待带 request ID 的显式审批；显式审批到达时取消粗粒度占位通知。WebView 使用 generation guard，已失效的异步通知即使晚到也会立即按相同 ID 取消。
- 同一任务的多个审批按 request ID 集合跟踪，每个审批均可独立通知；解决其中一个不会误清除其他待审批项。
- 全量任务列表、增量列表、打开任务快照和 Desktop 快照都会统一补发或取消等待通知，覆盖断线重连后的状态恢复。原生 Service 将最小通知索引持久化，进程重建后由首个全量快照清理已解决或已消失任务的旧通知。


## 实时状态一致性

- 思考梗概只绑定当前 active turn；缓存中的旧 `streaming` reasoning 不会在新任务运行时复活。
- Desktop canonical snapshot 到达后会丢弃同 turn 的旧 synthetic reasoning/plan tail，避免状态栏回退到数小时前的文字。
- Subagent ID 可从原始活动详情及压缩缓存中的协作文本恢复；`subagentActivity` 的独立 UUID 行仅在明确的 Subagent 活动类型中解析，避免误把普通提示词 UUID 当作 Agent；`source.original.subagent` 等元数据路径也会被解析，且空字段不会覆盖已知父任务和昵称。
- Agent/Subagent 工具调用不再埋入普通工具调用组，并在消息下方直接显示对应 Subagent 打开按钮。
- 现场只读验证表明：未进入 Host `threads.list` 的 Subagent 仍可通过已知任务 ID 执行 `thread.open`；因此活动消息和详情页均允许按 ID 直接打开。若手机从未收到该 Agent 的任何活动事件，纯客户端无法凭空发现 ID，本 Android-only 分支不修改 Host 索引。

## 自动验证目标

- Mobile TypeScript typecheck
- Mobile Vitest
- Vite production build
- Android Capacitor sync
- Android `assembleDebug`
- Android `lintDebug`
- APK 元数据、签名、内容及 SHA-256

本次自动验证结果：Mobile Vitest 11 个文件/101 项通过；Android JVM/Robolectric 15 项通过；typecheck、Vite production build、Capacitor sync、`assembleDebug`、`lintDebug`、`git diff --check` 通过。最终 debug APK SHA-256：`b4fa10e488851ee4896772d9d45999ed90619418c24449e9040b0d69ce5cc11e`。

## Android 原生后台事件连接

- 前台 Service 新增经过配对令牌认证的只读 WebSocket，即使 WebView 被 HyperOS 冻结也可接收完成、审批和等待输入事件。
- 原生连接只发送 `threads.list` 应用消息；半开探测使用 OkHttp WebSocket ping frame，不发送任务控制、提示词或审批决定，不与电脑 GUI/WebView 争夺操作权。
- 原生与 WebView 对显式审批和完成事件使用相同通知 ID，并启用 `setOnlyAlertOnce(true)`；粗粒度等待状态采用延迟占位并在显式事件到达时取消。
- Android 强行停止、断网、bridge 离线或厂商禁止前台服务重建时仍无法保证提醒；没有服务端离线推送队列。

## 真机待验收

- Redmi K80 三键导航和手势导航；
- 竖屏和横屏；
- 输入法关闭/打开及多行输入；
- 任务完成、审批、权限请求、等待输入的通知、声音与点击跳转；
- App 前台、后台和锁屏场景。
