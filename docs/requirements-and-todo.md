# 需求与 TODO（持续维护）

更新时间：2026-07-26

此文件是本项目的长期需求账本。聊天中的临时计划即使被上下文压缩，也不得替代本文件；新增反馈必须先补到这里，再实现、测试和提交。

## 产品范围

- 仅 Android，不开发 iOS。
- 直接生成可侧载 APK，不依赖 Expo Go。
- 手机通过局域网、Tailscale 或自定义 Host 地址操控电脑上的 Codex；模型 endpoint/API Key 只保留在电脑。
- 新目录独立 Git 管理；协议、测试、持久化与交付产物均落盘。
- UI 参考 Codex GUI：素净、低装饰、无大面积气泡；小屏优先。

## 功能与问题清单

| # | 需求 / 缺陷 | 当前状态 | 实现或证据 |
|---|---|---|---|
| 1 | Android 后台运行；非当前任务出现审批时通知；完成事件通知 | 部分完成 | 原生前台服务、高优先级审批 channel、完成通知、点击动作持久化已实现；无 Android 真机，Doze/厂商省电未证明。 |
| 2 | 手机与 Desktop GUI 同时打开同一任务，历史必须完整且持续同步 | 已完成 | 使用 `~/.codex/ipc/ipc.sock` follower 加载 Desktop canonical complete history；浏览器回归中本任务历史与最近 9 条用户反馈均可见。 |
| 3 | 图片/文件上传、发送与下载 | 部分完成 | Host bearer 上传、一次性下载票据、Android 文件选择器/Downloads 实现和 HTTP 回环测试完成；真机 MediaStore 未证明。 |
| 4 | 思考梗概不用气泡；运行时临时展示，带 Codex GUI 风格波动 | 已完成 | 仅显示当前 active turn 的梗概；canonical snapshot 会清理旧 synthetic tail；无当前 turn 时只显示“Codex 正在思考”，不复活缓存旧内容。 |
| 5 | 目标/TODO 放在输入框上方，可展开；局部快照不能把它清掉 | 已完成 | 独立 `todoByThread` 状态；解析 Desktop `todo-list`；局部 reconciliation 保留最后确认 TODO；浏览器实时显示 7/9 项完成。 |
| 6 | 新输出时阅读上文不能上下跳闪 | 已完成 | 仅接近底部时自动跟随；离开底部显示“有新内容”；固定 reasoning 槽位和 ResizeObserver 锚定。 |
| 7 | 权限/审阅模式可选：完全访问、替我审阅、严格审阅等 | 已完成 | 支持 `auto`、`granular`、`read-only`、`guardian-approvals`、`full-access`；设置区显示真实当前值。 |
| 8 | 与 Desktop 一致地按目录显示全部任务 | 已完成 | cursor 分页最多 1000 条；2026-07-25 最新浏览器回归为 450 个任务、9 个目录。 |
| 9 | 客户端偶发两个用户气泡 | 已完成 | Composer 同步提交锁；稳定 `clientUserMessageId`；optimistic/canonical 按 ID 关联；Gateway 10 分钟 TTL 幂等表；相同 ID 不同内容拒绝。 |
| 10 | 手机完成的输入/输出必须回到 Desktop GUI | 已完成 | Desktop owner 路径经 follower steer/start；`steeringUserMessage.restoreMessage` 恢复可见文本与时间。 |
| 11 | Markdown 渲染 | 已完成 | 普通消息渲染 Markdown；工具、Diff、Subagent 使用无气泡时间线。 |
| 12 | 状态不能显示“未知”或把未载入误报为空闲 | 已完成 | 明确区分未载入、可继续、执行中、待审批、待输入、异常；证据不足时显示“等待同步”。 |
| 13 | `/` 命令与模型选择 | 已完成 | 支持 `/status`、`/compact`、`/help`、`/models`、`/model:*`、`/effort:*`、`/skills`、`/skill:*`；模型来自 `model/list`。 |
| 14 | 显示 Subagent，数量多时可折叠；点击标签可查看详情 | 已完成 | 列表树和会话 chip 均可折叠；点击 chip 打开移动端 bottom sheet，可查看状态、角色、预览、模型和任务 ID，并可打开任务。 |
| 15 | 审批必须可确认；文件审批显示漂亮 Git diff | 已完成 | 命令/文件/权限审批闭环；晚到 diff 刷新；统一按行增删色块。真机通知点击未证明。 |
| 16 | 显示计时、工具调用详情、思考梗概 | 已完成 | turn/工具用时、折叠原始事件、临时思考状态均已接入。 |
| 17 | Host 重启后客户端不能永久“重连中” | 已完成 | 同端口重启后，不刷新页面自动恢复“已连接”；目标/TODO仍在。公开仓库保留自动回归，不提交私人会话日志。 |
| 18 | 上下文压缩必须显示请求、运行、重试、成功、失败和错误 | 已完成 | `thread.compaction.accepted` 只表示受理；结合 `contextCompaction`、`item/started`、`item/completed`、`error.willRetry`、`turn/completed` 驱动状态条和失败通知。 |
| 19 | 手机发送后 Desktop 再发送不能卡死 GUI | 已完成（机制修复） | Desktop owner 一律 steer-first；只有明确 `SteerTurnInactiveError` 才 start；超时/断连不 fallback；避免追加第二个本地 `inProgress` turn。没有复现原卡死现场，因此“原事故根因”仍是高置信推断。 |
| 20 | 已探测协议必须及时文档化 | 已完成 | `docs/desktop-ipc.md`、`docs/app-server-protocol.md` 与两份 live protocol raw log 已更新。 |
| 27 | Desktop 可见但手机缺失 Subagent；Subagent 元数据跨来源一致 | 客户端侧完成，Host 索引待后续 | 客户端解析 `source/subAgent`、`source/subagent`、`source.original.*`，保留 parent/nickname，并从缓存协作文本恢复 ID；现场已证明 Singer 不在 Host `threads.list`，本 Android-only 分支按约束不改服务端。 |
| 28 | Agent 工具调用直接显示 Subagent 跳转入口 | 已完成 | Agent 工具不进入普通连续工具折叠组；消息下方渲染可点击 Subagent chip，复用顶部详情交互。 |
| 29 | Redmi 横屏左右显示切口不得遮挡会话内容 | 已完成（待真机） | 消息流、设置栏、思考梗概、上下文压缩栏、Subagent strip、TODO、队列、Git diff 均消费左右 safe-area；竖屏/横屏真机待验收。 |

## 当前交付 TODO

- [x] 修复 Desktop owner 上的 steer-first 与明确 inactive fallback。
- [x] 增加稳定 `clientUserMessageId` 与 Gateway 幂等冲突保护。
- [x] 恢复 Desktop steering 用户消息、TODO 与思考临时状态。
- [x] 增加上下文压缩状态机与失败通知。
- [x] 增加可点击 Subagent bottom sheet。
- [x] 完成 TypeScript、89 个单元测试、生产构建和 390×844 浏览器回归。
- [x] 完成 Android debug APK 与 Lint、签名、包信息和哈希验证。
- [ ] 在真实 Android 设备完成安装、后台/Doze、通知点击、上传下载与局域网长连接验收。
- [ ] Codex Desktop 升级后重新探测私有 IPC 版本和真实 wire 样本。

## 不得误报为已完成的边界

- 当前 `adb devices -l` 无设备，因此真机安装、Android Keystore、MediaStore、通知权限、Doze 和厂商省电均未完成物理验收。
- 前台服务不是 FCM；手机被强行停止、主机离线或网络中断时，无法保证事件一定送达。
- Desktop IPC 是私有协议，当前证据只对应 Desktop 26.721.41059（build 5848）和随包 Codex 0.146.0-alpha.3.1。

## 追加反馈（2026-07-25 14:28 之后）

| # | 追加反馈 | 状态 | 实现与证据 |
|---|---|---|---|
| 23 | Desktop GUI 没有打开任务时，真实运行任务不能显示“未载入” | 已实现 | app-server `turn/started`、`turn/completed`、`thread/status/changed` 与 Desktop 快照分源保存并合并；任一可靠来源 active 即显示执行中，迟到 notLoaded/旧 turn completed 不覆盖。服务器 50 项测试通过；真实当前任务显示“执行中”。 |
| 24 | 一个目录任务很多时目录本身必须可折叠 | 已实现 | cwd 标题可折叠，≥6 个任务默认折叠；执行中/待审批/待输入/未读目录默认展开；用户选择持久化到 `codex-mobile.project-collapse.v1`。移动端定向测试 9 项通过。 |
| 25 | 任务级 Git Diff 只在任务 cwd 属于 Git worktree 时显示 | 已实现 | 只执行 `git -C <task cwd> rev-parse --show-toplevel`；不再扫描子目录，不读取工具调用 cwd；非 Git 或 cwd 未同步时整个面板不渲染。服务器 Git 测试 4 项、移动端显示判定测试通过。 |
| 26 | 从任务返回列表再进入后出现无内容横向 scroller | 已实现 | 补齐会话 DOM 链路的 `max-width:100%` / `min-width:0`；消息主流只纵向滚动，Diff/表格/Subagent 等局部横向查看器保留。返回—重进实测页面宽 390/390，布局回归测试 3 项通过。 |

## 追加反馈（2026-07-25 14:49 之后）

| # | 追加反馈 | 状态 | 实现与证据 |
|---|---|---|---|
| 27 | Desktop GUI 消息不能把 `<in-app-browser-context>` 环境块显示成用户正文 | 已实现 | 仅在 Desktop canonical user item 解析时识别注入前缀，优先取 `restoreMessage.text`，普通 `userMessage` 则提取 `## My request for Codex:` 后真实正文；用户主动输入同名标题不误删。真实页面中注入英文块和 marker 均为 0。 |
| 28 | Desktop GUI 附图必须在手机客户端展示并可下载 | 已实现 | 从 canonical user item 的 `input.localImage`、`attachments`、`restoreMessage.context.imageAttachments` 提取；Host 仅临时信任 Desktop snapshot 中出现的精确 canonical 文件路径，手机客户端通过 bearer ticket 拉取 Blob。实测图片自然尺寸 692×406。 |
| 29 | Desktop 原生队列与手机 Host 队列同时存在时不得竞争双 start | 已实现（严格安全模式） | Desktop owner 存在时 Host 队列只持久化、不自动 `turn/start`；活动 turn 中仍可显式“立即引导”走原子 `turn/steer(expectedTurnId)`。无 Desktop owner 时 Host 正常自动消费。当前 Desktop 没有 follower 可参与的队列锁或 per-thread CAS mutation，因此未使用不安全的全局 setter。 |


## 紧急回归与交互改进（v0.3.1，2026-07-25 17:22 之后）

以下内容是当前交付目标，完成前不得标记为已解决：

| # | 需求 / 缺陷 | 当前状态 | 验收标准 |
|---|---|---|---|
| 30 | 最新 APK 偶发显示两份完全相同的 Codex/assistant 输出 | 已完成 | 对实时 delta、`item/completed`、`desktop/threadSnapshot`、历史分页和 `sync.replay` 建立稳定消息身份并 exactly-once 合并；不得仅按文本隐藏，也不能误删不同 turn 中合法重复的回答。 |
| 31 | 用户消息与 Codex 输出时间顺序错位；首条带图用户消息可能显示在回答之后 | 已完成 | 保留 canonical turn/item 顺序；同一 turn 内时间戳相同或缺失时按来源顺序稳定排列，禁止退回按随机/字典序 ID 排列。Desktop GUI 与手机顺序一致。 |
| 32 | 从父任务的 Subagent 标签/详情进入 Subagent 任务后，返回层级错误 | 已完成 | 建立明确导航栈：父任务详情 → Subagent 详情 → Subagent 任务；返回恢复进入前的页面和面板状态，不得直接清空到任务列表或跳到默认主任务页。Android 系统返回键与页面返回按钮行为一致。 |
| 33 | 会话顶部标题栏错位、cwd 挤入标题下沿、固定区与 Subagent 横条/正文覆盖 | 已完成（自动化） | 正确处理 Android safe-area；返回键、标题、连接状态同一基线；cwd 单独一行并截断；顶部实际高度参与布局，Subagent 横条和正文不被遮挡。 |
| 34 | 一个 turn 中连续多个工具调用在手机上占据过多空间 | 已完成 | 将连续工具/命令/文件修改/MCP/Subagent 活动合并为一个“工具调用 · N”分组，默认可整体折叠；展开后仍可逐项查看状态、用时、输出和 Diff，用户/assistant 正文不得被并入。 |
| 35 | Composer 按 Enter 会直接发送，无法自然换行 | 已完成 | Enter 永远插入换行且兼容中文输入法 composing；只有明确点击发送按钮才发送。可保留 Ctrl/Cmd+Enter 作为物理键盘可选快捷键，但普通 Enter 禁止发送。 |
| 36 | 首轮会话先选图片再输入提示词时，图片可能不展示，只出现主机绝对路径 | 已完成 | 发送前等待上传完成并原子提交文本+附件；optimistic、实时 canonical、历史分页、缓存恢复均保留图片附件；有附件元数据时绝不把主机路径作为干巴巴正文替代图片。覆盖“新任务第一条消息、先选图后输入”复现路径。 |

### v0.3.1 当前 TODO

- [x] 抓取重复 assistant 输出的两条原始 wire/normalized message，证明来自哪个来源以及 ID 差异。
- [x] 以 `id ?? turnId` 建立 canonical turn 身份，并让客户端保留 canonical 数组顺序，修复重复与乱序。
- [x] 增加“同一 turn 相同时间戳仍保持 user → assistant”回归测试。
- [x] 增加父任务/Subagent 详情/Subagent 会话的导航栈与 Android back 回归测试。
- [x] 重构 Android 非 overlay 状态栏、不可收缩 header/cwd/工具栏/Subagent strip 布局并增加 CSS 回归；当前无连接的 adb 真机，安装后仍需肉眼复核。
- [x] 实现连续工具调用分组整体折叠及逐项展开。
- [x] 修改 Composer：Enter 换行，发送按钮发送，IME composing 不误触；Ctrl/Cmd+Enter 保留为显式快捷键。
- [x] 修复首条图片上传时序、附件 canonical 化和历史/缓存渲染。
- [x] 完成 typecheck、113 项单元测试、生产 WSS 回归、Android build/lint/APK v2 签名。
- [x] 版本递增到 0.3.1/versionCode 5，更新协议/测试证据并生成新版 APK；Git 提交见本次交付提交。

### 追加回归（2026-07-25 17:48）

| # | 需求 / 缺陷 | 当前状态 | 验收标准 |
|---|---|---|---|
| 37 | Git 仓库存在大量变更文件（例如 100 个）时，变更面板无法完整上下浏览，且展开/收起入口不明确 | 已完成 | Git 变更展开区必须有受视口约束的独立纵向滚动容器、始终可见/可拖动的滚动条；摘要行显示明确的展开/收起文案与方向箭头，点击整行仍可切换；100 个文件时可从首项滚动到末项且不挤压消息区/Composer。 |

- [x] 为 Git 变更面板增加明确的展开/收起提示和独立纵向 scroller，并覆盖大文件数回归测试。

### 真机追加回归（2026-07-25 18:08）

| # | 需求 / 缺陷 | 当前状态 | 验收标准 |
|---|---|---|---|
| 38 | 当前 turn 中刚发送的用户消息和 Codex 正文总被渲染到最下面，晚于它们发生的工具调用却留在前面的折叠组 | 已完成 | 手机时间线必须严格遵循 canonical item 顺序：用户输入 → Codex 阶段性正文 → 随后工具调用；后续 snapshot/replay/完成事件不得把已存在正文移动到工具组之后或把旧正文重新 append 到最底部。 |
| 39 | 已折叠的工具调用组内部新增/更新工具事件时，错误弹出“有新内容/回到底部”提示 | 已完成 | 当用户停留上文且变化只发生在关闭的工具组内部、不改变可见布局高度时，不显示“有新内容”；只有新增可见正文、审批、打开组的可见内容等真正增加可见时间线时才提示。 |

- [x] 用脱敏的真实 active turn item 类型/匿名化 ID/位置交叉核对 GUI 与手机顺序；私人正文和原始 wire 不进入公开仓库。
- [x] 为 snapshot 覆盖窗口、live tool event、正文消息交错建立稳定时间线回归测试；证明相同 turn 时间戳下仍保持 user → assistant → later tool。
- [x] 将滚动提示的变化键从隐藏内容长度中剥离，按当前可见 entry/折叠状态判定；关闭组采用稳定首项 ID，组内追加/流式更新不触发“有新内容”，展开后可见变化仍触发。

### v0.3.2 延迟快照与开源发布回归

| # | 需求 / 缺陷 | 当前状态 | 验收标准 |
|---|---|---|---|
| 40 | 清缓存或重装后，会话初始正常，但打开数秒后旧用户/Codex 消息自行移动到最下面 | 已完成（自动化与原始包重放） | `thread.open` 后延迟到达的 `desktop/threadSnapshot` 必须按 covered turn 替换 canonical 窗口；app-server 的 `item-数字` 历史投影不得作为 live event tail 追加到末尾；同一正文只保留 canonical 一份。 |
| 41 | 需要用户可见的全量缓存刷新机制 | 已完成 | 设置页提供“清空缓存并全量刷新”；删除 IndexedDB 及所有历史 localStorage schema，保留 Host 地址与配对令牌，随后重建任务索引和当前会话。 |
| 42 | 开源 APK 不得写死维护者私人 Host | 已完成 | 首次安装服务器地址为空；仅显示 `codex.example.com` 中性 placeholder；生产域名、IP、用户名、绝对主目录、私人 wire/截图不进入公开仓库。 |
| 43 | 延迟 snapshot 去重不能误删真实 live item，也不能覆盖更新内容 | 已完成 | `itemId` 视为不透明；只移除与 canonical 消息语义完全一致的计数型别名；未匹配 live item 保留；同 ID 的更长正文和 terminal 状态禁止被旧 snapshot 降级。 |

- [x] 以生产 WSS 脱敏抓包复现 `thread.open → 延迟 desktop/threadSnapshot` 两阶段时序。
- [x] 用 v0.3.1 和 v0.3.2 reducer 重放同一原始包，证明旧版 synthetic assistant 被移动到尾部、新版保持单份 canonical 位置。
- [x] 缓存 schema 升级到 4，并实现跨 schema 全量清除入口；缓存不再被误报为根因。
- [x] 首次启动默认 Host 改为空，示例域名改为 `codex.example.com`。
- [x] 移除公开仓库中的私人部署配置、原始会话日志和截图；以可复现命令与脱敏摘要替代。
- [x] 完成 v0.3.2 最终 APK 构建、lint、签名/元数据与隐私字符串验证；源码以 `v0.3.2` 标签发布，APK 通过 Gitea Release 附件分发。
- [ ] 在真实 Android 设备确认打开该长会话 10 秒以上不再发生历史消息下沉。

### v0.3.3 Android 系统栏与通知回归

| # | 需求 / 缺陷 | 当前状态 | 验收标准 |
|---|---|---|---|
| 44 | Redmi K80 顶部标题栏进入状态栏/挖孔区域，底部输入区被三键或手势导航栏遮挡 | 已完成（自动化，待真机） | 使用 Capacitor 8 `SystemBars.insetsHandling=css` 注入的 `--safe-area-inset-*`，所有顶栏、输入栏、列表、bottom sheet、toast 和 Subagent 弹层统一消费上下左右安全区；不手写第二套原生 WindowInsets。 |
| 45 | 任务完成、失败、审批和权限请求没有系统通知或提示音 | 已完成（事件到达客户端时；待真机） | 完成与人工介入事件即使在当前任务前台也产生通知；使用新的高优先级 v2 渠道和内置提示音；初始化失败/拒绝后允许重试，失败不得永久写入去重状态。 |
| 46 | `waitingOnUserInput` 只显示状态，不通知用户 | 已完成（自动化，待真机） | `waiting_input` 与仅状态型 `waiting_approval` 进入时产生可点击的高优先级通知；状态退出或审批解决后取消占位通知；generation guard 会取消晚到的失效异步通知，显式审批不会与状态通知产生双重提示音；原生通知索引跨 Service 进程重建持久化并由全量快照清理。 |

- [x] 修复后置 `.conversation-top-bar` 规则覆盖顶部安全区的问题。
- [x] 使用 Capacitor 8 SystemBars CSS 变量兼容旧版 Android System WebView，并覆盖横屏左右挖孔安全区。
- [x] 浅色 UI、启动背景、主题色和系统栏深色图标保持一致。
- [x] 通知渠道升级为 `codex_approvals_v2` / `codex_completions_v2`，显式绑定内置 WAV 提示音和振动模式。
- [x] 增加任务完成、审批、待输入、权限重试、重连快照补偿和安全区静态回归测试。
- [x] 将只读事件连接迁入 Android 原生前台 Service；仅发送任务摘要请求，保活使用 WebSocket ping frame，不发送控制消息；与 WebView 使用相同通知 ID 去重。
- [ ] Redmi K80 分别在三键导航/手势导航、前台/后台、锁屏场景完成真机验收。


### v0.3.4 Subagent 一致性、弱网导航与长列表性能回归

> 本节是 2026-07-26 当前交付批次的唯一验收清单。未完成项不得因聊天上下文压缩而丢失；Android 完成并发布 APK 后，才继续合并 Windows IPC 分支。

| # | 需求 / 缺陷 | 当前状态 | 验收标准 |
|---|---|---|---|
| 47 | 弱网进入任务详情后立即返回，迟到响应会把用户强行拉回详情页 | 已完成（自动化） | `thread.open` 等迟到响应只允许更新对应任务缓存与历史，不得改变当前导航、模型、思考强度或权限；只有仍有效的 `thread.start` 激活意图可以打开新任务。 |
| 48 | Subagent 历史混入主会话或其他 Subagent 内容 | 已完成（自动化） | 实时事件、snapshot、历史分页、reconcile、缓存落盘/恢复和最终 selector 均执行 threadId 归属不变量；turn/item 有显式 owner 且与外层任务不一致时必须丢弃。 |
| 49 | 手机端 Subagent 数量、状态与 Desktop 不一致，思考梗概长期停留在旧任务 | 已完成（客户端链路，待现场） | 手机必须及时显示 Desktop 已存在的 Subagent 及真实运行/完成/失败状态；思考梗概只跟随当前 active turn，不能复活几小时前的缓存梗概。 |
| 50 | Agent 工具调用没有按连续工具折叠，或为了按钮把所有 Subagent 单独拎出 | 已完成（自动化） | `spawnAgent`/Subagent 等调用与相邻工具调用进入同一折叠组；关闭组不挂载重型子树；折叠摘要和展开内容保留可直达相关 Subagent 的按钮。 |
| 51 | 从 Subagent 详情返回错误地回到主任务菜单 | 已完成（自动化） | 维护任务内导航栈；从 Subagent 任务返回来源任务详情，再返回才退出到任务列表。 |
| 52 | 主页任务下的 Subagent 下拉在窄屏/多层嵌套时变形或横向溢出 | 已完成（自动化，待真机） | 下拉宽度始终受项目容器约束，多层缩进不增加页面总宽度，不出现空白横向滚动条。 |
| 53 | 长会话上下滑动、工具组展开/折叠明显卡顿并伴随跳闪 | 已完成（自动化，待真机） | 移除整页/整列表每秒重渲染；计时局部更新；Markdown memo；原始事件按需 stringify；关闭工具组不挂载消息；滚动跟随每帧最多一次且阅读上文时不抢位置。 |
| 54 | Redmi K80 状态栏/挖孔和底部导航安全区回归 | 已完成（静态/构建，待真机） | 顶部标题栏、主页、详情页、弹层与底部输入区统一使用系统 CSS inset；三键与手势导航均不遮挡内容。 |
| 55 | 完成、审批、等待输入等人工介入事件无通知或无提示音 | 已完成（自动化，待真机） | Android 13+ 权限、通知渠道、内置声音、前台 Service 和后台 WebSocket 链路完整；前台未聚焦、后台、锁屏均能提示，解决后取消占位通知且不重复响铃。 |
| 56 | Android 回归、APK 与 Windows IPC 合并顺序 | 已完成 | 先完成上述 Android 自动化测试、版本升级和新版 APK/Gitea Release；随后才将 Windows IPC PR 的 source 幂等与 owner/target 校验修复合并到主分支。 |

- [x] 完成 `thread.open` 迟到响应、A→B 切换和有效 `thread.start` 的导航回归测试。
- [x] 完成父/子 turn、item owner、污染缓存和无 threadId 实时事件的隔离回归测试。
- [x] 完成连续工具组、Agent 直达按钮、关闭组零子项挂载和滚动稳定性回归测试。
- [x] 完成主页多层 Subagent 下拉窄屏布局和无横向 overflow 回归测试。
- [ ] 完成通知前台/后台/锁屏及 Redmi K80 三键/手势导航真机验收；无法在当前环境证明的部分必须明确标为未证明。
- [x] 构建、校验并发布 v0.3.4 APK；记录 SHA-256、versionCode、versionName、测试命令和结果。
- [x] Android 发布后合并 Windows IPC 分支，并重新执行 Protocol、Server、Mobile 全量测试和 build。

### v0.3.5 安卓长会话性能回归（2026-07-26）

用户真机确认 v0.3.4 在长任务中仍明显卡顿，因此撤销“长列表性能已经验收”的判断；本轮只修改安卓/移动客户端，不要求服务端协议变更。

- [x] 证明每次流式增量存在重复全历史派生、无效消息引用和全量 DOM 常驻。
- [x] 将流式文本 delta 以 32ms 窗口合并；同一 item 保持字节顺序，完成/快照等非 delta 事件前立即 flush。
- [x] 稳定当前任务消息数组与未变化消息对象的引用；其他任务更新不得带动当前会话重渲染。
- [x] 缓存单条消息的 Subagent 目标解析结果，避免每个 delta 重新解析全部协作工具文本。
- [x] `MessageBubble` 使用可见字段比较；等价 canonical clone 不再重渲染 Markdown。
- [x] 默认只挂载最近 80 个时间线条目；已载入的更早记录可按 80 条显式展开。
- [x] 用户向上阅读时冻结当前窗口尾部；后续新增 500 条也不扩大已挂载窗口，并显示“有新内容”。
- [x] 可见内容 revision 只扫描当前窗口，但能识别非尾部消息替换；关闭工具组内部更新继续不制造错误下滑提示。
- [x] 为消息、工具组和审批卡增加 `content-visibility: auto`，减少 Android WebView 离屏布局/绘制。
- [x] 删除思考梗概和 TODO 查找中的数组复制/reverse。
- [x] 增加 5000 条消息派生、固定窗口、冻结阅读窗口、selector 引用和 delta 合并回归测试。
- [x] 构建并发布 `versionName=0.3.5`、`versionCode=9` APK；Gitea Release `v0.3.5`，SHA-256 见发布记录。
- [ ] Redmi K80 安装 v0.3.5 后复验：持续流式输出、向上阅读、展开工具组、回到底部均无明显卡顿或跳闪。


### v0.3.6 安卓实时一致性、审批提醒与工具时间（2026-07-26）

本轮继续只修改 Android/移动客户端及其文档，不要求服务端变更。

- [x] 修复 Android 刘海/状态栏与底部手势区安全区域，避免标题栏和输入框被系统区域遮挡。
- [x] 审批、等待输入、任务完成使用三个独立高优先级通知通道和不同提示音；前台、后台 socket 共用稳定通知 ID，并处理迟到通知取消竞争。
- [x] 运行中允许修改权限/审阅模式，并明确提示设置已发出；已经挂起的旧审批仍须单独处理。
- [x] 活跃 turn 状态兼容 `inProgress`、`running`、`active`、`started`；思考梗概允许短的新快照替换长的旧快照，不再按文本长度错误保留旧状态。
- [x] Subagent 工具目标优先读取 `receiverThreads[].thread.agentNickname` 等结构化字段；不再把 UUID 当显示名。
- [x] 工具组关闭时不挂载 Agent 按钮；展开后只在对应工具调用行内显示 16px 高紧凑 Agent 标签，不单独抽出全部 Subagent。
- [x] 区分 item 原始时间、实时事件时间、客户端首次观察时间和 turn 排序回退时间：turn 开始时间不再冒充工具/消息时间；首次观察时间用 `≈HH:mm` 标识。
- [x] 精确/观察时间一旦得到，不允许后续缺少 item 时间的 Desktop snapshot 回退覆盖。
- [x] Redmi Note 14 Pro+ 真机验证：Agent 标签与 `Subagent · sendInput` 同一行；旧工具不显示伪 `12:53`；在线新增工具显示 `≈15:38`、`≈15:39`。
- [x] 移动端 TypeScript 类型检查与 12 个测试文件、160 项测试通过。
- [x] 在独立临时工作目录创建新任务并证明权限映射：`granular` turn 原始策略为 managed workspace-write，但 `sandbox_approval=false`，没有产生审批；`auto` turn 原始策略为 `approval_policy=on-request`，产生真实 `item/commandExecution/requestApproval`，手机收到 `codex_approvals_v4` 通知和审批音。
- [x] 原生 Computer Use 工具审批已证明：Host 自动探测 ChatGPT/Codex 随包 Node REPL runtime，声明 MCP form elicitation 能力；Redmi 真机显示 `mcpServer/elicitation/request` 审批，手机批准后原生 Computer Use 恢复并完成。
- [x] 证明 app-server `thread.start` 新任务只进入 app-server/手机客户端任务索引，不会自动出现在 Desktop GUI：现有 Desktop IPC 仅支持跟随/启动已有 Desktop-owned thread，没有创建 GUI 任务的 IPC。
- [x] 证明 16:11:04 的一字回复已有 rollout `task_complete`，但 Redmi logcat 没有对应 completion fallback；根因是 Desktop GUI 路径可只发 running→idle snapshot/status 而不发 `turn/completed`。
- [x] Android 后台 socket 增加 active→terminal 状态转换的 900ms completion fallback；显式 `turn/completed` 到达时取消 fallback，并对同任务 2.5 秒内完成事件去重。
- [x] Xiaomi/Redmi MediaPlayer 兜底提示音按类别做 900ms 去重，避免 WebView 与后台 socket 同时收到同一事件时重复播放。
- [x] Redmi 真机复验 Desktop GUI 当前任务完成提示音。
- [x] 构建、校验 `versionName=0.3.6`、`versionCode=10` APK；SHA-256 已写入 v0.3.6 发布记录。
### v0.3.7 原生 Computer Use 与审批通知去重（2026-07-26）

- [x] 自动探测 `/Applications/ChatGPT.app` 当前 `cua_node` Node REPL、Node、node_modules 和随包 Codex CLI；用进程级配置覆盖修复旧 `/Applications/Codex.app` 路径，不改用户全局配置。
- [x] app-server 初始化声明 `mcpServerOpenaiFormElicitation: true`。
- [x] 将 `mcpServer/elicitation/request` 映射为手机审批卡；一次允许/会话允许/拒绝使用 Codex GUI 原生响应结构。
- [x] Desktop GUI-owned thread 通过 `thread-follower-submit-mcp-server-elicitation-response` 回传审批。
- [x] 真机端到端：Computer Use 审批可见、审批音可闻、手机批准后 `com.apple.SystemProfiler` 只读调用完成。
- [x] 修复 `approval.resolved` 被主动响应与 app-server 权威事件重复广播。
- [x] 修复前台 WebView 与后台 Socket 对同一审批各发一次声音：按稳定 notificationId 原子认领，不用扩大时间窗误伤相邻的不同审批。
- [x] 构建并安装 v0.3.7（versionCode 11）到 Redmi Note 14 Pro+；新 Computer Use 审批真机日志仅出现 1 次 approval fallback，前台迟到 notifyApproval 被 notificationId 认领拦截。
- [x] 记录 APK SHA-256：`807591cf75e5a1c30ee6fb807c4ea659fbe3496f2413642506e9a1d590333fb9`。
- [x] 完成真机单次铃声复验、Git 审查和 Gitea v0.3.7 Release 发布。
