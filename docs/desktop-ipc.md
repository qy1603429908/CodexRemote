# Desktop IPC 跟随与双端一致性

> 验证日期：2026-07-25。Desktop IPC 是 Codex GUI 私有、版本化协议，不是公开稳定 API。当前验证对象为 Desktop `CFBundleShortVersionString 26.721.41059` / `CFBundleVersion 5848`。

## 1. 原始传输

Socket：

```text
~/.codex/ipc/ipc.sock
srw-------，属主为当前 macOS 用户
```

帧格式：

```text
uint32 little-endian JSON_UTF8_length
JSON_UTF8_bytes
```

初始化：

```json
{"type":"request","requestId":"...","method":"initialize","params":{"clientType":"codex-mobile-remote"}}
```

## 2. 同一任务的 owner/follower 模型

手机 bridge 不再把桌面正在打开的任务当成另一个独立 app-server 会话。流程为：

1. 广播 `thread-stream-following-changed`，`following:true`；
2. Desktop owner 向 bridge 返回 `thread-stream-state-changed` snapshot；
3. bridge 发送 `thread-follower-load-complete-history`；
4. Desktop owner 返回完整 canonical `turnHistory` snapshot；
5. 手机发送 turn、设置、压缩、中断和审批决定时，定向请求 Desktop owner。

已接入的 follower 方法：

```text
thread-follower-start-turn
thread-follower-load-complete-history
thread-follower-compact-thread
thread-follower-interrupt-turn (version 3)
thread-follower-update-thread-settings
thread-follower-command-approval-decision
thread-follower-file-approval-decision
thread-follower-permissions-request-approval-response
```

Desktop owner 不可用时，历史打开/新任务仍回退到 bridge 自己的 `codex app-server`。这使未在 GUI 中打开的任务仍可从手机恢复；之后 Desktop 重新载入 rollout 时可看到已持久化内容。

## 3. canonical 历史

Desktop snapshot 的 `turns` 可能为空，真实历史位于：

```text
turnHistory.history.islands[].entries[]
turnHistory.history.entitiesByKey
```

bridge 按 island entry 顺序解析实体，并把包含 `items` 的 turn/tail 实体正规化到 `turns`，供手机客户端使用。不能用“`turns` 为空”等价于“没有历史”。

## 4. 2026-07-25 实机主机联调证据

原始落盘结果：

```text
/tmp/cmr-live-integration-result.json
/tmp/cmr-conversation-snapshot.json
/tmp/cmr-ipc-probe.log
/tmp/cmr-ipc-probe.err
```

关键结果：

```json
{
  "open": {
    "turns": 8,
    "status": { "type": "active", "activeFlags": [] },
    "historyComplete": true
  },
  "settings": "ipc-ack",
  "list": { "count": 446, "projectCount": 9 }
}
```

这证明：

- Desktop owner 的当前任务状态是 `active`，不是手机侧猜测的“空闲”；
- 完整 canonical 历史已通过 IPC 返回；
- follower 设置请求获得 Desktop owner 应答；
- 任务列表分页聚合后为 446 个任务、9 个 cwd，而不是首 50/100 条造成的 4 个 cwd。

## 5. 版本防护

- Socket 必须为当前用户所有且 group/other 权限为 0，否则 bridge 拒绝连接。
- 帧长度上限 256 MiB。
- follower 方法带显式版本号。
- 私有协议升级后必须重新执行真实 snapshot、history、settings/turn 和审批回归；不能只依赖静态字符串。

## 6. 活动 turn 必须 steer，不能再次 start

2026-07-25 对 Desktop `app.asar` 的静态核验确认两个 follower 方法职责不同：

```text
thread-follower-start-turn
  → thread-follower-start-turn-for-host
  → Ow(...turnStartParams)

thread-follower-steer-turn
  → thread-follower-steer-turn-for-host
  → _Tu(...input, restoreMessage, clientUserMessageId...)
  → app-server turn/steer
```

Desktop owner 内部对 steer 的定向参数为：

```ts
{
  conversationId: string;
  clientUserMessageId: string;
  input: UserInput[];
  serviceTier: string | null;
  attachments: unknown[];
  additionalContext: unknown | null;
  restoreMessage: {
    id: string;
    text: string;
    context: {
      prompt: string;
      addedFiles: unknown[];
      fileAttachments: unknown[];
      ideContext: unknown | null;
      imageAttachments: unknown[];
      workspaceRoots: string[];
    };
    cwd: string;
    createdAt: number;
  };
}
```

因此网关必须复制 Desktop 自己的原子选路策略，而不是依据可能滞后的 snapshot 猜测：

```text
Desktop owner
  → 先 thread-follower-steer-turn
  → 仅当明确 SteerTurnInactiveError / active turn already ended
  → 再 thread-follower-start-turn

Desktop IPC timeout / socket close / owner disconnect / unknown error
  → 不得 fallback start
  → 返回 submission_state_unknown，要求刷新历史确认

无 Desktop owner
  → app-server turn/start
```

原因是 `turn/steer.expectedTurnId` 提供活动 turn 的原子前置条件；`threadRuntimeStatus` 和 canonical snapshot 在读取与发送之间存在 TOCTOU。active turn 上错误调用 `thread-follower-start-turn` 会让 Desktop 先追加第二个本地 `inProgress` placeholder，可能造成双端投影失配或 GUI 停滞。

同一个逻辑提交还必须携带唯一 `clientUserMessageId`。Gateway 维护 10 分钟、最多 1000 项的有界幂等表：同 ID/同内容复用同一个 Promise 和结果；同 ID/不同内容返回 `idempotency_conflict`。不能通过向 Desktop 重发同一个 ID 实现幂等，因为 Desktop 内部会把旧跟踪项标记为 superseded。

## 7. 真实 Desktop 投影增量

原始 wire 样本含私人任务正文，不进入公开仓库；下列字段由脱敏抓包和自动测试交叉确认。

已确认的 Desktop 私有项目类型：

```text
steeringUserMessage
  restoreMessage.text / restoreMessage.createdAt
  clientUserMessageId / serverUserMessageId

todo-list
  explanation
  plan[].step / plan[].status

contextCompaction
  completed
  source = manual | automatic
```

这些字段均须以 unknown-safe 方式解析；Desktop 更新后必须重新抓真实 snapshot 回归。

## 8. Desktop 私有提示词队列：为何不直接写入

2026-07-25 对 Desktop 26.721.41059 打包资源的原始审计确认：

```ts
type QueuedFollowUpsState = Record<string, QueuedMessage[]>;
```

`thread-follower-set-queued-follow-ups-state` 的 `params.state` 是**全部会话的全局对象**，owner handler 会直接覆盖 `queued-follow-ups` 全局键，并不会只 merge `params.conversationId`。该 follower 协议没有 getter、revision、CAS 或 per-conversation patch；广播 `thread-queued-followups-changed` 也只携带 `{conversationId, messages}`，无法恢复初始完整全局状态。

证据 → 决策：

1. 全局 setter + 无 getter → 外部 Host 只发送当前会话会删除其他会话的 Desktop 队列。
2. 无 revision/CAS → 即使曾读取快照，也可能覆盖 Desktop GUI 的并发队列修改。
3. 因此 Host **不调用该私有 setter**；提示词排队由 Host 自己以 0600 JSON 持久化，并在当前 turn 权威完成后调用新的 `turn/start`。
4. 当前 turn 被中断时，Host 队列转为 `paused`，只有用户显式恢复才继续；Host 在发送过程中重启则标记 `uncertain`，禁止自动重试。

Desktop 原生队列与 Host 队列目前是两套安全隔离的状态。只有 Desktop 将来提供 owner 侧原子 `enqueue/remove/reorder` IPC 后，才可无损同步。

## 9. 双队列协调的严格安全模式

Desktop 26.721.41059 内部确实有 `queued-follow-up-send-lock-acquire/release`，按 conversation 加锁，锁 TTL 120 秒、已发送记录 TTL 600 秒；但该锁只暴露给 Electron 内部队列消费者，外部 `thread-follower-*` 没有 acquire/release 方法。

同时没有：

```text
turn/startIfIdle(expectedRevision)
per-conversation queue enqueue/remove/get
queue revision/CAS
外部 follower 可参与的 native send lock
```

因此 Desktop 原生队列与 Host 队列无法共享一个原子 claim。仅监听 `thread-queued-followups-changed` 或等待固定毫秒数仍存在检查—启动之间的 TOCTOU。

本项目采用可证明的不竞争规则：

```text
Desktop owner 存在
  → Host 队列持久化，但绝不自动 start
  → active 时允许显式“立即引导”，走 steer(expectedTurnId)
  → idle 时禁止手机强制 promote/start

没有 Desktop owner
  → Host 根据 app-server 权威状态自动 drain
```

`thread-queued-followups-changed` 仍被解析用于诊断，但空广播不被解释为 Host 获得启动权。全局 `thread-follower-set-queued-follow-ups-state` 仍禁止调用。

## 10. Desktop canonical 用户正文与附件

Desktop GUI 可能把 ambient 上下文序列化进普通 `userMessage.content`：

```text
<in-app-browser-context ...>...</in-app-browser-context>
## My request for Codex:
真实正文
```

而 `steeringUserMessage` 通常同时提供干净的 `restoreMessage.text`。客户端解析规则：

1. 优先 `restoreMessage.text`；
2. 普通 userMessage 仅在检测到已知注入前缀时，提取 `My request for Codex` 后正文；
3. 没有注入前缀时保留用户主动输入的同名 Markdown 标题。

Desktop 附图原始投影已确认位于：

```text
input[].type = localImage, input[].path
attachments[].fsPath/path
restoreMessage.context.imageAttachments[].localPath
```

## 11. Canonical turn 身份与消息顺序（v0.3.1）

2026-07-25 的真实 WSS 抓包证明，Desktop snapshot 中的 turn 经常只有 `turnId`、没有 `id`。旧 `mergeTurns` 仅使用 `turn.id`，同一个活动 turn 同时来自 `recent` 与 `active`、或来自 app-server 历史页与 Desktop live snapshot 时，会分别生成 `turn_1`、`turn_2`，从而把其中相同的 assistant/reasoning/tool items 发送两遍。

修正规则：

```text
canonicalTurnId = turn.id ?? turn.turnId ?? 本次合并内的 fallback
canonicalItemId = item.id ?? item.itemId ?? turn内稳定位置
```

同一 canonical turn 的元数据以后到来源为准，`items` 则按 canonical item ID 原位合并；无 ID item 仍保留，不使用正文文本去重。生产 WSS 验收样本：19 turns / 19 unique turns，968 items / 968 unique items，重复数均为 0。

客户端不得再以 `createdAt || id.localeCompare` 对 canonical items 重排。Desktop/app-server 的 item 数组顺序就是权威顺序；turn 级时间戳只用于展示，不能用于打破同 turn 内 user/assistant 的先后关系。历史分页显式 prepend，实时 snapshot 显式替换其重叠窗口并 append。


## 12. 当前 active turn 的稳定时间线与可见更新（v0.3.1）

2026-07-25 对当前真实任务抓取的 Desktop IPC/WSS 快照显示，同一 active turn 内：`steeringUserMessage`、随后的 `agentMessage`、再随后的 `commandExecution` 均已按实际发生顺序排列。公开仓库仅保留脱敏顺序结论和回归测试，不提交原始会话正文。因此客户端不得根据 `createdAt` 或随机 item ID 二次排序，也不得在 snapshot/replay 到达时把 authoritative 窗口简单 append 到尾部；应按重叠 canonical item ID 原位替换窗口。

连续工具事件的折叠组身份固定为首个 canonical tool item ID。组处于关闭状态时，内部新增工具、输出 delta 或状态更新只改变隐藏内容，不计作“新增可见时间线内容”；组展开后，内部变化重新纳入可见内容键。这样既保留实时工具详情，又不会在用户阅读上文时制造虚假的“有新内容/回到底部”提示。

## 12. 跨来源 item 身份与延迟 snapshot（v0.3.2）

同一个 turn 可能先经 `thread.open` 返回 app-server 历史页与 Desktop live 投影的组合，随后再经订阅连接收到 `desktop/threadSnapshot`。两种来源对同一逻辑 item 不保证使用相同 ID：

```text
app-server history projection: item-<number>
Desktop canonical projection:  msg_... / call_... / UUID
```

真实公网链路中，`desktop/threadSnapshot` 可以在 `thread.open` 后数百毫秒到数秒才到达，也可能只覆盖 Desktop 当前已加载的最近 turns。它的到达时间不能被解释为消息发生时间。

### 合并规则

1. 移动端解析混合 `thread.open` 时，以完整结构指纹或用户 correlation ID 去除 app-server 与 Desktop canonical item 的一一对应别名。
2. `itemId` 是不透明字符串；不能仅凭 `item-数字` 外形删除消息。只有同 turn、角色/类型、正文和附件完全对应 canonical snapshot 的计数型别名才可移除。
3. 未被 snapshot 命中的 live item 保留在同 turn 的 event tail，后续 snapshot 收录后再按 canonical 顺序归位。
4. 相同 item ID 的延迟 snapshot 不得把更长的 live delta 覆盖成更短正文，也不得把 terminal 状态降级回 streaming。
5. Gateway 继续按 item ID 保守合并 page/live 数据，避免 Desktop 部分快照覆盖掉 app-server 中未加载的历史 item。
6. 不能按 `createdAt` 或 item ID 排序；很多 item 只有 turn 级时间戳，随机/来源相关 ID 也不具备时序语义。

这组规则专门防止“会话刚打开正常，数秒后旧用户/Codex 正文自行移动到最下面”的二阶段同步回归。
