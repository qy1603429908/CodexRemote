# v0.3.4 Android 发布记录

日期：2026-07-26

> 状态：APK 已完成本地自动化构建与校验，等待 Git 提交和 Gitea Release 上传；Redmi K80 真机项目仍未证明。

## 范围与交付顺序

本版本先完成 Android/移动客户端的 Subagent 一致性、弱网导航、窄屏布局和长会话性能修复。Android APK 构建与发布完成后，才继续合并 Windows Desktop IPC 分支。当前 Android 批次不依赖任何服务端改动。

## 修复目标

### 弱网导航

- 已打开任务的 `thread.open` 响应即使迟到，也只能更新该任务缓存和历史。
- 用户已返回任务列表或切换到其他任务时，迟到响应不得改变页面、模型、思考强度和权限。
- 只有客户端仍持有的 `thread.start` 激活意图可以自动打开新建任务。

### Subagent 历史与状态

- 实时事件不得用“当前正在查看的任务”猜测缺失的 threadId。
- snapshot、历史分页、reconcile、缓存和 selector 均强制 `bucket threadId === message.threadId`。
- turn/item 存在显式 `threadId`、`conversationId`、`ownerThreadId` 或 `ownerConversationId` 时，归属不匹配的内容不得写入 Subagent。
- 手机端展示的 Subagent、状态和思考梗概需与 Desktop 当前任务保持一致；无法仅靠客户端恢复的 Host 索引缺失必须明确记录。

### 工具调用与性能

- Agent/Subagent 工具调用重新与相邻工具调用合并到同一“工具调用 · N”折叠组。
- 折叠摘要和展开明细均保留直达相关 Subagent 的入口，但不得把所有 Agent 工具单独拆出时间线。
- 关闭的工具组不挂载内部消息；原始事件仅在实际展开时序列化。
- 运行计时使用局部组件，避免整条任务列表或整段会话每秒重渲染。
- Markdown 和消息组件减少无效重渲染；ResizeObserver/内容更新滚动写入按 animation frame 合并。

### Android 窄屏与安全区

- 主页多层 Subagent 下拉按钮始终受项目容器宽度约束，不产生横向溢出或空白 scroller。
- Redmi K80 的状态栏、挖孔、三键导航和手势导航仍使用 Capacitor SystemBars CSS inset 单一来源。
- 顶部标题栏和底部输入区需在真实设备再次验收。

### 通知与提示音

- 任务完成、失败、审批、权限请求和等待输入均应产生系统通知。
- Android 13+ 权限、高优先级渠道、内置声音、前台 Service 和后台 WebSocket 链路需重新核对。
- 前台未聚焦、后台和锁屏场景需真机验证；解决审批后不得留下旧占位通知或重复响铃。

## 自动验证清单

- [x] `git diff --check`
- [x] Mobile TypeScript typecheck
- [x] Mobile Vitest 全量测试
- [x] Mobile production build
- [x] Android JVM/Robolectric 测试
- [x] Capacitor sync
- [x] Android `assembleDebug`
- [x] Android `lintDebug`
- [x] APK `versionName` / `versionCode` 检查
- [x] APK 签名检查
- [x] APK 私有 Host、令牌、用户名和绝对路径扫描
- [x] APK SHA-256


## 自动验证结果

- Mobile Vitest：`11` 个测试文件、`116` 项通过。
- Mobile TypeScript：`tsc -b --pretty false` 通过。
- Vite production build：通过。
- Android JVM/Robolectric：`15/15` 通过。
- Android Lint：`0 errors`；现有警告不阻断构建。
- Android `assembleDebug`：通过。
- APK 元数据：包名 `dev.codexmobile.remote`，`versionName=0.3.4`，`versionCode=8`，`minSdk=24`，`targetSdk=36`。
- APK 签名：v2 校验通过。
- APK 内容：包含 `res/raw/codex_notification.wav` 和 Web 入口资源。
- 私密字符串扫描：未发现维护者私人域名、IP、用户名或 `/Users/qinyu` 绝对路径。

## 真机待验收

- [ ] Redmi K80：竖屏/横屏，三键导航/手势导航，输入法开关，多行输入。
- [ ] 弱网打开任务后立即返回，等待 10 秒不被拉回。
- [ ] 主任务和多个 Subagent 之间来回切换，历史不串线。
- [ ] 100+ 工具调用的折叠、展开和上下滚动无明显卡顿或跳闪。
- [ ] 任务完成、审批、权限请求、等待输入在前台未聚焦、后台、锁屏下均有通知和声音。

## 最终产物

- 版本：`0.3.4`
- `versionCode`：`8`
- Git 提交：待提交后填写
- APK：`apps/mobile/artifacts/codex-mobile-remote-v0.3.4-debug.apk`
- APK 大小：约 `5.1 MiB`
- 签名：Android debug certificate，APK Signature Scheme v2 验证通过
- SHA-256：`35fa41287948ecff5f647001e08d0f76d3c99bdce615451cc2eedf203f0ca205`
- Gitea Release：待上传后填写
