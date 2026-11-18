# Agent 主动提问

当任务出现 `item/tool/requestUserInput` 或 Desktop 的 `agentMessage.questions` 时，手机显示独立的待答卡片，支持选项、自由输入及请求明确允许的多选。提交后，答案回到产生问题的原始 Desktop owner 或辅助 app-server callback。

历史 `<send_user_message_question_reply>` 封装显示为问题与答案卡片。加载旧版 schema 4 缓存时同步转换有效封装，保留其他正文、附件和消息身份；异常格式及代码示例保留原文。

## 消息与归属

认证后的现有 WebSocket 增加以下消息，不增加公网接口：

| 方向 | 消息 | 用途 |
| --- | --- | --- |
| 手机 → Bridge | `user-input.list` | 查询指定会话当前待答问题 |
| 手机 → Bridge | `user-input.answer` | 携带问题身份、答案和稳定客户端消息 ID 提交 |
| Bridge → 手机 | `user-input.snapshot` | 权威替换待答列表；空列表清除已处理的问题 |
| Bridge → 手机 | `user-input.submitted` | 确认提交 |

原生问题使用 `thread-follower-submit-user-input` v1；异步问题使用 Desktop 已有的结构化用户回复封装。异步回复优先引导当前 turn，只有明确的 inactive 错误才启动后续 turn；超时或归属变化不会回退到另一个 app-server 启动相同任务。

原生请求身份包含 turn、RPC ID 的类型与值，防止旧卡片回答后来复用 RPC ID 的问题。异步身份包含当前待答题目集合，桌面部分回答后手机更新为剩余问题。服务端在异步落盘后、实际投递前再次核对 owner 和待答状态。

`user-input.snapshot` 不进入增量回放日志。重新连接后手机保留草稿，但必须先取得新的查询回执才能提交。Bridge 和 App 应一起更新；旧 Bridge 不认识新增消息，会返回 `unknown_message`。

## 不确定结果与去重

Bridge 在 `prompt-queue.json` 同目录的 `submissions.json` 保存版本 1 的 SHA256 去重记录，不保存问答正文。客户端消息、问题分组和每道题分别保护，防止多设备同时回答、Bridge 重启或问题重新分组造成重复投递。

逐题预留以整个批次为单位检查；遇到已尝试题目时，不占用同批的新题目。只有确认尚未调用任何投递接口的最终校验失败，才能释放刚取得的逐题预留。一旦调用投递接口，超时也保留记录。不要删除账本来重试未知结果，应先核对 Desktop 历史。

普通提示词和队列沿用原有提交策略；本次新增的持久预留仅用于问答提交。正常审批仍使用已有审批流程。

## 协议与验证边界

结构对照：Desktop `26.1111.2228.0` / 资源 CLI `0.169.0-alpha.11.1` 的问答消息。此补丁保留仓库原有 snapshot/start/interrupt 版本协商，不包含其他 Desktop 版本的整体适配；不同 Desktop 版本仍需单独核对协议。

本分支用合成 fixture 覆盖原生/异步问答、旧请求、断线重连、owner 变更、重复回答、部分回答、结果未知及 Bridge 重启，并验证历史卡片和旧缓存迁移。分离后的上游分支未连接实际 Desktop/手机或替换运行中的部署。
