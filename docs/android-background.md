# Android 后台与通知

## 能力

Android 原生 `CodexBackgroundService` 是用户主动启用的前台服务：

- `START_STICKY`；
- `android:stopWithTask="false"`；
- Android 14+ `foregroundServiceType="specialUse"`；
- 不注册 `BOOT_COMPLETED`，不开机自启；
- 忘记连接配置时主动停止。

通知渠道：

```text
codex_background_v1  Low      后台连接常驻状态
codex_approvals_v1   High     审批请求，响铃/震动/抬头
codex_completions_v1 Default  任务完成/失败
```

审批/完成通知包含 `threadId`。点击后支持运行中事件和冷启动持久化两条路径，并用 `nonce` 去重。客户端仅在 App 不活跃或当前没有聚焦对应任务时发通知。

## 边界

前台服务保持应用进程和后台网络会话的运行基础，但不是 FCM：

- Android “强行停止”、设备断网、电脑离线时不能实时收到事件；
- 当前服务不在开机后偷偷重启；
- WebSocket 重连仍由客户端连接层负责；
- Doze、厂商省电策略和真机长期后台行为必须在目标手机上验收。

## 原始构建证据

并行实现阶段原始日志：

```text
/tmp/codex-mobile-android-background-final-assembleDebug.log
/tmp/codex-mobile-android-background-clean-assembleDebug.log
/tmp/codex-mobile-android-background-lintDebug.log
```
