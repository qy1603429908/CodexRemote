# v0.3.2 发布记录

日期：2026-07-25

## 修复

- 修复 `thread.open` 后延迟 `desktop/threadSnapshot` 到达时，app-server `item-数字` 历史投影被当作实时尾项，导致旧用户/Codex 消息数秒后移动到最下面的问题。
- Desktop snapshot 以 covered turn 为 canonical 窗口；只移除与 canonical 消息语义完全一致的跨来源别名，未匹配 live event 保留为 event tail。
- `itemId` 按不透明字符串处理；延迟 snapshot 不得覆盖更长 live delta，也不得把 terminal 状态降级为 streaming。
- Gateway 保持保守的按 ID 合并，避免 Desktop 部分快照覆盖 app-server 中未加载的历史 item。
- 增加“清空缓存并全量刷新”：等待既有缓存写入完成后清除 IndexedDB 和所有历史 localStorage cache schema，保留 Host 地址与配对令牌；清理失败会明确报错。
- 缓存 schema 升级到 4。
- 开源构建不再预填维护者 Host；首次服务器地址为空，仅展示 `https://codex.example.com` placeholder。

## 延迟 snapshot 脱敏重放证据

对同一组生产 WSS 原始包进行离线重放（不保存 Token、任务标题和消息正文）：

```text
thread.open:                +2.103s
first desktop/threadSnapshot: +2.742s
```

v0.3.1 reducer：

```text
synthetic assistant item-473: 初始 index 704
canonical assistant msg_*:    初始 index 848
snapshot 后 item-473:         index 1058（接近末尾）
snapshot 后 canonical:        index 801
```

v0.3.2 reducer：

```text
初始：只保留 canonical assistant，一份
snapshot 后：仍只保留 canonical assistant，一份，位于历史原位置
目标用户/Codex 语义别名数：0（未匹配 opaque live item 保留）
```

另一次公网观测中，后续 Desktop snapshot 在连接后约 7 秒到达，说明用户观察到“打开五六秒后才移动”符合真实网络时序，而非缓存触发。

## 自动验证

```text
server: 8 files / 55 tests passed
mobile: 10 files / 74 tests passed
protocol/server/mobile typecheck passed
production build passed
Android assembleDebug passed
Android lintDebug passed
```

APK：

```text
local build: apps/mobile/artifacts/codex-mobile-remote-v0.3.2-debug.apk
package: dev.codexmobile.remote
versionName: 0.3.2
versionCode: 6
minSdk: 24
targetSdk: 36
signature: APK Signature Scheme v2 verified
size: 4,630,632 bytes
SHA-256: 647251a49ccd2befa19a7f1d976d66591752991881774f4c32af2c97bcd8a04d
```

APK 内容扫描未发现维护者私人域名、IP、用户名或绝对主目录。最终 APK 不进入源码 Git/LFS，通过 Gitea Release 附件分发。

## 部署说明

v0.3.2 Android 客户端兼容当前 v0.3.1 Host，因此无需为了安装 APK 中断正在运行的 Host。生产服务不因本次客户端发布而重启。

## 尚需真机确认

- 在目标 Android 设备打开长会话并保持至少 10 秒，确认旧消息不再下沉；
- Doze、厂商省电、通知点击与 MediaStore 下载仍需目标设备物理验收。
