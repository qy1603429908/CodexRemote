# v0.3.5 Android 发布记录

日期：2026-07-26

## 背景

v0.3.4 的自动化测试通过，但 Redmi K80 真机仍报告长会话明显卡顿。此次不假设任何服务端修改，只针对移动端流式更新、React 引用稳定性和 Android WebView 长列表挂载进行修复。

## 主要修复

- 流式文本 delta 按 32ms 合并，同一 item 的内容顺序保持不变；完成、快照等非 delta 事件会先刷新待处理文本。
- 当前任务 selector 对其他任务更新、等价 snapshot 和未变化消息保持稳定引用。
- Subagent 目标解析按消息对象缓存；工具组不再反复解析同一历史。
- `MessageBubble` 使用可见字段比较，避免等价 canonical clone 重渲染 Markdown。
- 默认仅挂载最近 80 个时间线条目；更早的已载入记录按 80 条展开。
- 向上阅读时冻结当前窗口。新输出留在窗口之后，不会为保持锚点而无限扩大 DOM。
- 可见内容 revision 限定在当前窗口，同时能检测窗口内非尾部消息替换。
- Android WebView 离屏消息、工具组和审批卡启用 `content-visibility: auto`。

## 性能证据

使用相同 5000 条富文本消息在本机执行 React server-render 合成基准：

| 模式 | 实际渲染消息节点 | HTML 大小 | 渲染耗时 |
|---|---:|---:|---:|
| 旧式全量挂载模拟 | 5000 | 2,766,390 bytes | 556.17 ms |
| v0.3.5 尾部窗口 | 80 | 47,308 bytes | 115.57 ms |

节点数减少 98.4%，该合成基准初始渲染耗时下降约 79%。这是本地 React/DOM 证据，不替代 Redmi K80 真机帧率验收。

## 自动验证

- Mobile Vitest：12 个测试文件、132 项通过。
- Server Vitest：9 个测试文件、71 项通过、2 项跳过。
- TypeScript：protocol/server/mobile 全部通过。
- Production build：protocol/mobile/server 全部通过。
- Android JVM：`testDebugUnitTest` 构建成功。
- Android `assembleDebug`：通过。
- Android `lintDebug`：通过，应用模块无新增问题。
- APK 元数据：包名 `dev.codexmobile.remote`，`versionName=0.3.5`，`versionCode=9`，`minSdk=24`，`targetSdk=36`。
- APK 签名：Android debug certificate，APK Signature Scheme v2 验证通过。
- APK 内容：包含通知声音和 Web 入口资源。
- 私密字符串扫描：未发现维护者私人域名、IP、用户名、私钥文件名或 `/Users/qinyu` 绝对路径。
- APK 大小：5,721,319 bytes。
- SHA-256：`e48b8b2653fc942b7e37bb543a92276789d0fda2f0cbfd8c7ec068ea40d0e578`。

## 真机待验收

- Redmi K80 打开本项目超长任务并持续接收流式输出。
- 停留底部时连续输出无明显掉帧。
- 向上阅读至少 30 秒，新增输出不改变当前阅读位置，DOM 窗口不增长。
- 点击“有新内容”回到底部后显示最新输出。
- 展开/收起大型工具组时滑动无明显卡顿。

## 产物

- APK：`apps/mobile/artifacts/codex-mobile-remote-v0.3.5-debug.apk`
- `versionName`：`0.3.5`
- `versionCode`：`9`
- 发布渠道：Gitea Release `v0.3.5`
