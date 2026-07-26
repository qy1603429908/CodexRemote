# Codex app-server 协议核验（0.144.4，experimental）

> 结论基于本机 `codex-cli 0.144.4` 由 `codex app-server generate-ts --experimental` 生成的类型，以及本机 stdio 只读探测。**0.144.4 是当前实现的固定协议基线**；本文只覆盖手机 Remote 所需的初始化、线程、模型、Skills、turn、流式通知和审批。升级 Codex 后必须重新生成类型并执行真实 wire 回归。

## 1. 线协议与连接初始化

### 1.1 帧格式

app-server 使用 JSON-RPC 风格对象，但本版本生成的 wire schema **没有 `jsonrpc: "2.0"` 字段**：

```ts
type RequestId = string | number;

type JSONRPCRequest = {
  id: RequestId;
  method: string;
  params?: unknown;
  trace?: {
    traceparent?: string | null;
    tracestate?: string | null;
  } | null;
};

type JSONRPCResponse = {
  id: RequestId;
  result: unknown;
};

type JSONRPCError = {
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JSONRPCNotification = {
  method: string;
  params?: unknown;
};
```

- stdio transport：每个 JSON 对象一行（NDJSON）。本机探测确认请求和响应均为单行 JSON。
- WebSocket transport：`codex app-server --help` 确认支持 `ws://IP:PORT`；本文未实测 WebSocket 帧边界和鉴权握手。
- `id` 可为字符串或整数。桥接层应原样保存和回传，不能只按 number 处理。
- stdio 的日志写 stderr，协议消息写 stdout，不能把两者混流。

### 1.2 `initialize`

请求：

```json
{
  "id": "init-1",
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "codex-mobile-remote",
      "title": "Codex Mobile Remote",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true,
      "requestAttestation": false,
      "mcpServerOpenaiFormElicitation": true,
      "optOutNotificationMethods": null
    }
  }
}
```

精确参数类型：

```ts
type InitializeParams = {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
};
```

> **Computer Use 必需能力**：Host 必须声明 `mcpServerOpenaiFormElicitation: true`。原生 Computer Use 通过 `node_repl` MCP 发出 `mcpServer/elicitation/request`；若不声明该能力，`nodeRepl.createElicitation` 不可用，工具会在审批前失败。

成功响应：

```json
{
  "id": "init-1",
  "result": {
    "userAgent": "...",
    "codexHome": "/absolute/path/to/.codex",
    "platformFamily": "unix",
    "platformOs": "macos"
  }
}
```

```ts
type InitializeResponse = {
  userAgent: string;
  codexHome: string;       // AbsolutePathBuf
  platformFamily: string;  // 例如 unix/windows
  platformOs: string;      // 例如 macos/linux/windows
};
```

随后客户端应发送协议定义的无响应通知：

```json
{"method":"initialized"}
```

已实测的边界：

- 未先 `initialize` 就调用 `thread/list`，服务端返回：
  `{"error":{"code":-32600,"message":"Not initialized"},"id":99}`。
- 本机 0.144.4 在 `initialize` 成功后，即使尚未发送 `initialized`，也接受 `thread/list`；但客户端仍应发送 `initialized`，不要依赖这一宽松行为。

---

## 2. 通用核心对象

下面几个对象会嵌套在多种响应和通知中。

```ts
type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | {
      type: "active";
      activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">;
    };

type Thread = {
  id: string;
  extra: unknown | null; // 实际类型为 ThreadExtra
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  historyMode: "legacy" | "paginated";
  modelProvider: string;
  createdAt: number;     // Unix seconds
  updatedAt: number;     // Unix seconds
  recencyAt: number | null;
  status: ThreadStatus;
  path: string | null;
  cwd: string;           // AbsolutePathBuf
  cliVersion: string;
  source: SessionSource;
  threadSource: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: GitInfo | null;
  name: string | null;
  turns: Turn[];
};

type Turn = {
  id: string;
  items: ThreadItem[];
  itemsView: "notLoaded" | "summary" | "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: {
    message: string;
    codexErrorInfo: unknown | null;
    additionalDetails: string | null;
  } | null;
  startedAt: number | null;   // Unix seconds
  completedAt: number | null; // Unix seconds
  durationMs: number | null;
};
```

`Thread.turns` 的重要语义：

- `thread/resume`、`thread/rollback`、`thread/fork`，以及 `thread/read(includeTurns=true)` 可填充 turns。
- 其他返回 `Thread` 的响应/通知中，`turns` 通常为空数组。
- `ThreadItem` 是带 `type` 的联合类型。手机 UI 至少要识别：`userMessage`、`agentMessage`、`plan`、`reasoning`、`commandExecution`、`fileChange`；未知 `type` 必须容错保留，不能导致整条流断开。

### 2.1 `notLoaded` 不是“空闲”

`notLoaded` 只证明当前 app-server 进程没有加载该线程，不能证明线程在其他 Codex 进程中没有运行。Mobile Remote bridge 通过 `codex app-server --listen stdio://` 启动独立进程；它不能读取 Codex 桌面 App 所属另一个 app-server 的内存运行态。

因此前端状态语义应为：

| app-server 状态 | 手机端含义 |
|---|---|
| `notLoaded` | 明确显示“未载入”；打开后优先跟随 Desktop owner |
| `idle` | 当前 bridge 已知为空闲 |
| `active` 且无等待 flag | 执行中 |
| `active + waitingOnApproval` | 等待审批 |
| `active + waitingOnUserInput` | 等待用户输入 |
| `systemError` | app-server 系统异常 |

2026-07-25 的只读探测中，默认 `thread/list` 返回的 36 个历史任务状态全部为 `notLoaded`。把未知状态兜底为 `idle` 会直接造成“所有任务都显示空闲”的错误结论。

---

## 3. `thread/list`

请求：

```json
{
  "id": "thread-list-1",
  "method": "thread/list",
  "params": {
    "cursor": null,
    "limit": 20,
    "sortKey": "recency_at",
    "sortDirection": "desc",
    "modelProviders": null,
    "sourceKinds": null,
    "archived": false,
    "cwd": null,
    "useStateDbOnly": false,
    "searchTerm": null,
    "parentThreadId": null,
    "ancestorThreadId": null
  }
}
```

所有参数字段均可省略：

```ts
type ThreadListParams = {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | "recency_at" | null;
  sortDirection?: "asc" | "desc" | null;
  modelProviders?: string[] | null;
  sourceKinds?: Array<
    | "cli" | "vscode" | "exec" | "appServer"
    | "subAgent" | "subAgentReview" | "subAgentCompact"
    | "subAgentThreadSpawn" | "subAgentOther" | "unknown"
  > | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
  parentThreadId?: string | null;
  ancestorThreadId?: string | null; // 与 parentThreadId 互斥
};
```

响应：

```ts
type ThreadListResponse = {
  data: Thread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
};
```

```json
{
  "id": "thread-list-1",
  "result": {
    "data": [],
    "nextCursor": null,
    "backwardsCursor": null
  }
}
```

实现注意：`sourceKinds` 省略或空数组时，服务端默认交互式来源；`archived` 为 false/null 时仅返回未归档线程。

### 3.1 目录分组与 Subagent

目录分组可直接使用 `Thread.cwd`；项目名可以取 `cwd` 最后一级，同时保留完整绝对路径供核对。

Subagent 列表不能依赖默认查询。`sourceKinds` 省略/为空时只返回默认交互式来源，当前 bridge 应显式请求需要的来源：

```json
{
  "sourceKinds": [
    "cli", "vscode", "exec", "appServer",
    "subAgent", "subAgentReview", "subAgentCompact",
    "subAgentThreadSpawn", "subAgentOther", "unknown"
  ]
}
```

2026-07-25 对 `codex-cli 0.144.4` 的同进程只读探测结果：

```text
默认 sourceKinds：36 条，来源只有 cli/vscode
显式全部 sourceKinds：前 100 条中包含大量 subAgent 来源
```

另一个运行时事实是：部分持久化 Subagent 返回顶层 `parentThreadId: null`，父任务 ID 只存在于嵌套来源：

```json
{
  "parentThreadId": null,
  "source": {
    "subAgent": {
      "thread_spawn": {
        "parent_thread_id": "<parent-thread-id>",
        "agent_nickname": "Meitner"
      }
    }
  }
}
```

因此父子归组优先使用非空 `parentThreadId`，并兼容 `source.subAgent.thread_spawn.parent_thread_id`。当前 gateway 的初次索引查询会显式请求全部 Subagent `sourceKinds` 并实现这两种父任务字段的兼容映射。

**现场限制（2026-07-25）**：Desktop 运行中后创建的 Subagent 可能尚未进入 Host 的 `threads.list` 增量索引；Singer 即出现“Desktop 可见、`thread.open(<id>)` 成功、但 `threads.list` 缺失”的情况。Android v0.3.3 客户端会从父任务协作活动中恢复 Subagent ID，并支持按 ID 直接打开；若 Host 从未向客户端发送过该 ID，纯客户端无法凭空发现，需后续修复 Host 索引刷新。

---

## 4. `thread/start`

### 4.1 请求字段

```ts
type ThreadStartParams = {
  model?: string | null;
  modelProvider?: string | null;
  allowProviderModelFallback?: boolean;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null; // 必须为绝对路径
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent" | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  permissions?: string | null; // 命名 profile；不能与 sandbox 同时提供
  config?: Record<string, JsonValue> | null;
  serviceName?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  multiAgentMode?: { custom: string } | "explicitRequestOnly" | "proactive" | null; // deprecated
  ephemeral?: boolean | null;
  historyMode?: "legacy" | "paginated" | null;
  sessionStartSource?: "startup" | "clear" | null;
  threadSource?: string | null;
  environments?: Array<{ environmentId: string; cwd: string }> | null;
  dynamicTools?: DynamicToolSpec[] | null;
  selectedCapabilityRoots?: SelectedCapabilityRoot[] | null;
  mockExperimentalField?: string | null;
  experimentalRawEvents?: boolean;
};

type AskForApproval =
  | "untrusted"
  | "on-request"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };
```

MVP 建议请求：

```json
{
  "id": "thread-start-1",
  "method": "thread/start",
  "params": {
    "modelProvider": "custom",
    "cwd": "/absolute/workspace/path",
    "approvalPolicy": "on-request",
    "approvalsReviewer": "user",
    "sandbox": "workspace-write",
    "ephemeral": false
  }
}
```

不要从手机传 API Key；`modelProvider` 只选择电脑上已配置的 provider，凭据继续由电脑环境或 Codex 配置读取。

### 4.2 响应字段

```ts
type ThreadStartResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  instructionSources: string[];
  approvalPolicy: AskForApproval;
  approvalsReviewer: "user" | "auto_review" | "guardian_subagent";
  sandbox: SandboxPolicy;
  activePermissionProfile: ActivePermissionProfile | null;
  reasoningEffort: string | null;
  multiAgentMode: { custom: string } | "explicitRequestOnly" | "proactive";
};
```

响应 envelope：

```json
{
  "id": "thread-start-1",
  "result": {
    "thread": { "id": "...", "turns": [] },
    "model": "...",
    "modelProvider": "custom",
    "serviceTier": null,
    "cwd": "/absolute/workspace/path",
    "runtimeWorkspaceRoots": [],
    "instructionSources": [],
    "approvalPolicy": "on-request",
    "approvalsReviewer": "user",
    "sandbox": { "type": "workspaceWrite", "writableRoots": [], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false },
    "activePermissionProfile": null,
    "reasoningEffort": null,
    "multiAgentMode": "explicitRequestOnly"
  }
}
```

同时存在通知：

```ts
// method: thread/started
type ThreadStartedNotification = { thread: Thread };
```

不要只靠 `thread/started` 代替 request response；request response 还包含生效后的 model、cwd、sandbox、approval policy 等配置。

---

## 5. `thread/resume`

### 5.1 请求字段

```ts
type ThreadResumeParams = {
  threadId: string;
  history?: ResponseItem[] | null; // unstable，Codex Cloud 用途，不建议 Remote 使用
  path?: string | null;            // unstable，优先使用 threadId
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent" | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  permissions?: string | null; // 不能与 sandbox 同时提供
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  excludeTurns?: boolean;
  initialTurnsPage?: {
    limit?: number | null;
    sortDirection?: "asc" | "desc" | null;
    itemsView?: "notLoaded" | "summary" | "full" | null;
  } | null;
};
```

推荐的手机端恢复请求：

```json
{
  "id": "thread-resume-1",
  "method": "thread/resume",
  "params": {
    "threadId": "THREAD_ID",
    "excludeTurns": false,
    "initialTurnsPage": {
      "limit": 20,
      "sortDirection": "desc",
      "itemsView": "full"
    }
  }
}
```

恢复选择规则（来自生成类型注释）：

1. 可按 `threadId`、`history` 或 `path` 恢复。
2. 非运行线程的优先级：`history` > 非空 `path` > `threadId`。
3. 运行中的 `threadId` 会重新加入已有线程；此时非空 `path` 仅作 active rollout path 一致性校验。
4. Remote 应优先只用 `threadId`。

### 5.2 响应字段

```ts
type ThreadResumeResponse = {
  thread: Thread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  instructionSources: string[];
  approvalPolicy: AskForApproval;
  approvalsReviewer: "user" | "auto_review" | "guardian_subagent";
  sandbox: SandboxPolicy;
  activePermissionProfile: ActivePermissionProfile | null;
  reasoningEffort: string | null;
  multiAgentMode: { custom: string } | "explicitRequestOnly" | "proactive";
  initialTurnsPage: TurnsPage | null;
};
```

响应 envelope：

```json
{
  "id": "thread-resume-1",
  "result": {
    "thread": { "id": "THREAD_ID", "turns": [] },
    "model": "...",
    "modelProvider": "custom",
    "serviceTier": null,
    "cwd": "/absolute/workspace/path",
    "runtimeWorkspaceRoots": [],
    "instructionSources": [],
    "approvalPolicy": "on-request",
    "approvalsReviewer": "user",
    "sandbox": { "type": "readOnly", "networkAccess": false },
    "activePermissionProfile": null,
    "reasoningEffort": null,
    "multiAgentMode": "explicitRequestOnly",
    "initialTurnsPage": null
  }
}
```

`excludeTurns=true` 表示只拿线程元数据和 live-resume 状态；如果前端准备立即走分页接口，这是更轻的路径。

---

## 6. `thread/read`

请求：

```ts
type ThreadReadParams = {
  threadId: string;
  includeTurns?: boolean;
};
```

```json
{
  "id": "thread-read-1",
  "method": "thread/read",
  "params": {
    "threadId": "THREAD_ID",
    "includeTurns": true
  }
}
```

响应：

```ts
type ThreadReadResponse = { thread: Thread };
```

```json
{
  "id": "thread-read-1",
  "result": {
    "thread": { "id": "THREAD_ID", "turns": [] }
  }
}
```

`includeTurns=true` 才要求从 rollout history 填充 turns。用于“查看”可以调用 `thread/read`；要继续执行该线程，应调用 `thread/resume`。

---

## 7. `turn/start`

### 7.1 请求字段

```ts
type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "image"; detail?: ImageDetail; url: string }
  | { type: "localImage"; detail?: ImageDetail; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

type TurnStartParams = {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  responsesapiClientMetadata?: Record<string, string> | null;
  additionalContext?: Record<string, AdditionalContextEntry> | null;
  environments?: Array<{ environmentId: string; cwd: string }> | null;
  cwd?: string | null;
  runtimeWorkspaceRoots?: string[] | null;
  approvalPolicy?: AskForApproval | null;
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent" | null;
  sandboxPolicy?: SandboxPolicy | null;
  permissions?: string | null; // 不能与 sandboxPolicy 同时提供
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: "auto" | "concise" | "detailed" | "none" | null;
  personality?: "none" | "friendly" | "pragmatic" | null;
  outputSchema?: JsonValue | null;
  collaborationMode?: CollaborationMode | null; // experimental
  multiAgentMode?: { custom: string } | "explicitRequestOnly" | "proactive" | null; // deprecated/ignored
};
```

最小文本请求中 `text_elements` 是必填数组，即使为空也要发送：

```json
{
  "id": "turn-start-1",
  "method": "turn/start",
  "params": {
    "threadId": "THREAD_ID",
    "clientUserMessageId": "mobile-message-uuid",
    "input": [
      {
        "type": "text",
        "text": "请检查当前项目并运行测试",
        "text_elements": []
      }
    ]
  }
}
```

### 7.2 响应字段

```ts
type TurnStartResponse = { turn: Turn };
```

```json
{
  "id": "turn-start-1",
  "result": {
    "turn": {
      "id": "TURN_ID",
      "items": [],
      "itemsView": "full",
      "status": "inProgress",
      "error": null,
      "startedAt": 0,
      "completedAt": null,
      "durationMs": null
    }
  }
}
```

前端不能把 request response 当作完整结果；实际内容通过通知增量到达。

---

## 8. `turn/interrupt`

请求：

```ts
type TurnInterruptParams = {
  threadId: string;
  turnId: string;
};
```

```json
{
  "id": "turn-interrupt-1",
  "method": "turn/interrupt",
  "params": {
    "threadId": "THREAD_ID",
    "turnId": "TURN_ID"
  }
}
```

成功响应是空对象：

```ts
type TurnInterruptResponse = Record<string, never>;
```

```json
{"id":"turn-interrupt-1","result":{}}
```

最终状态仍应以 `turn/completed` 中 `turn.status === "interrupted"` 为准；响应 `{}` 只表示 interrupt 请求被处理，不应在 UI 中直接伪造 turn 已结束。

---

## 9. 流式通知

所有通知均没有 `id`：

```json
{"method":"通知名","params":{}}
```

### 9.1 生命周期和状态

| method | 精确 params |
|---|---|
| `thread/started` | `{ thread: Thread }` |
| `thread/status/changed` | `{ threadId: string, status: ThreadStatus }` |
| `thread/tokenUsage/updated` | `{ threadId: string, turnId: string, tokenUsage: ThreadTokenUsage }` |
| `turn/started` | `{ threadId: string, turn: Turn }` |
| `turn/completed` | `{ threadId: string, turn: Turn }` |
| `item/started` | `{ item: ThreadItem, threadId: string, turnId: string, startedAtMs: number }` |
| `item/completed` | `{ item: ThreadItem, threadId: string, turnId: string, completedAtMs: number }` |
| `error` | `{ error: TurnError, willRetry: boolean, threadId: string, turnId: string }` |
| `warning` | `{ threadId: string \| null, message: string }` |

```ts
type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
```

### 9.2 文本、推理和计划增量

| method | 精确 params |
|---|---|
| `item/agentMessage/delta` | `{ threadId: string, turnId: string, itemId: string, delta: string }` |
| `item/plan/delta` | `{ threadId: string, turnId: string, itemId: string, delta: string }`；experimental，且注释明确说不能假设拼接结果等于最终 plan item |
| `item/reasoning/summaryPartAdded` | `{ threadId: string, turnId: string, itemId: string, summaryIndex: number }` |
| `item/reasoning/summaryTextDelta` | `{ threadId: string, turnId: string, itemId: string, delta: string, summaryIndex: number }` |
| `item/reasoning/textDelta` | `{ threadId: string, turnId: string, itemId: string, delta: string, contentIndex: number }` |
| `turn/plan/updated` | `{ threadId: string, turnId: string, explanation: string \| null, plan: Array<{ step: string, status: "pending" \| "inProgress" \| "completed" }> }` |

### 9.3 命令、文件修改和 diff

| method | 精确 params |
|---|---|
| `item/commandExecution/outputDelta` | `{ threadId: string, turnId: string, itemId: string, delta: string }` |
| `item/commandExecution/terminalInteraction` | `{ threadId: string, turnId: string, itemId: string, processId: string, stdin: string }` |
| `item/fileChange/patchUpdated` | `{ threadId: string, turnId: string, itemId: string, changes: FileUpdateChange[] }` |
| `item/fileChange/outputDelta` | `{ threadId: string, turnId: string, itemId: string, delta: string }`；**deprecated，服务端注释明确“不再发出”** |
| `turn/diff/updated` | `{ threadId: string, turnId: string, diff: string }`，其中 `diff` 是当前 turn 全部文件修改的最新聚合 unified diff |

```ts
type FileUpdateChange = {
  path: string;
  kind:
    | { type: "add" }
    | { type: "delete" }
    | { type: "update"; move_path: string | null };
  diff: string;
};
```

### 9.4 推荐的前端归并规则

1. 用 `(threadId, turnId, itemId)` 作为流式 item 主键。
2. `item/started` 创建临时 item。
3. delta 通知只更新对应 item 的临时展示。
4. `item/completed.item` 是该 item 的权威最终快照，应替换/校准临时状态。
5. `turn/diff/updated.diff` 是全量最新聚合 diff，不是 append-only delta，应整体覆盖。
6. `turn/completed.turn` 是 turn 的权威最终状态。
7. `thread/status/changed` 的 `activeFlags` 可直接驱动“等待审批/等待用户输入”徽标。
8. 生成类型没有规定 request response 与同一生命周期通知之间的绝对到达顺序；状态管理器应允许先收到通知、后收到 response，反之亦然。

---

## 10. 命令审批：`item/commandExecution/requestApproval`

这是 **server → client request**，带有 `id`，客户端必须用同一个 `id` 回 JSON-RPC response。

服务端请求：

```ts
type CommandExecutionRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  environmentId: string | null;
  reason?: string | null;
  networkApprovalContext?: {
    host: string;
    protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
  } | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  additionalPermissions?: AdditionalPermissionProfile | null;
  proposedExecpolicyAmendment?: string[] | null;
  proposedNetworkPolicyAmendments?: Array<{
    host: string;
    action: "allow" | "deny";
  }> | null;
  availableDecisions?: CommandExecutionApprovalDecision[] | null;
};

type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: NetworkPolicyAmendment } }
  | "decline"
  | "cancel";
```

wire 示例：

```json
{
  "id": "server-approval-42",
  "method": "item/commandExecution/requestApproval",
  "params": {
    "threadId": "THREAD_ID",
    "turnId": "TURN_ID",
    "itemId": "ITEM_ID",
    "startedAtMs": 1784900000000,
    "approvalId": null,
    "environmentId": null,
    "reason": "需要执行受限命令",
    "command": "some-command",
    "cwd": "/absolute/workspace/path",
    "commandActions": [],
    "additionalPermissions": null,
    "proposedExecpolicyAmendment": null,
    "proposedNetworkPolicyAmendments": null,
    "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]
  }
}
```

客户端批准一次：

```json
{
  "id": "server-approval-42",
  "result": {
    "decision": "accept"
  }
}
```

拒绝：

```json
{
  "id": "server-approval-42",
  "result": {
    "decision": "decline"
  }
}
```

允许本会话：

```json
{
  "id": "server-approval-42",
  "result": {
    "decision": "acceptForSession"
  }
}
```

关键实现约束：

- 回应审批时只需相同 RPC `id` 和 `{decision: ...}`；不要把 `threadId`/`turnId`/`itemId` 塞回 result。
- `approvalId` 不是 JSON-RPC `id`。普通 shell/unified_exec 审批通常为 null；zsh-exec-bridge 的子命令审批可用独立 UUID 区分同一 `itemId` 下多个 callback。
- `availableDecisions` 存在时，手机 UI 应只展示服务端允许的决定。
- `serverRequest/resolved` 通知的 params 为 `{ threadId: string, requestId: string | number }`。若审批已在另一客户端处理，应据此关闭手机上的待审批卡片。

---

## 11. 文件修改审批：`item/fileChange/requestApproval`

服务端请求：

```ts
type FileChangeRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null; // unstable
};

type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";
```

wire 示例：

```json
{
  "id": "server-file-approval-7",
  "method": "item/fileChange/requestApproval",
  "params": {
    "threadId": "THREAD_ID",
    "turnId": "TURN_ID",
    "itemId": "ITEM_ID",
    "startedAtMs": 1784900000000,
    "reason": "需要写入工作区外路径",
    "grantRoot": "/absolute/root"
  }
}
```

批准：

```json
{
  "id": "server-file-approval-7",
  "result": {
    "decision": "accept"
  }
}
```

响应精确类型：

```ts
type FileChangeRequestApprovalResponse = {
  decision: FileChangeApprovalDecision;
};
```

文件审批请求自身不携带 patch 内容。用于展示的修改内容来自同一 `itemId` 的：

- `item/started` / `item/completed` 中 `type: "fileChange"` 的 `ThreadItem`；
- `item/fileChange/patchUpdated`；
- turn 级 `turn/diff/updated`。

因此审批卡片必须从流状态仓库按 `(threadId, turnId, itemId)` 联合查找 diff，不能期待审批 params 自带 diff。

---

## 12. 相关的权限审批

虽然不属于“命令/文件修改”两个直接 method，但现代命令执行还可能发：

```text
item/permissions/requestApproval
```

请求：

```ts
type PermissionsRequestApprovalParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  environmentId: string | null;
  startedAtMs: number;
  cwd: string;
  reason: string | null;
  permissions: {
    network: { enabled: boolean | null } | null;
    fileSystem: {
      read: string[] | null;
      write: string[] | null;
      globScanMaxDepth?: number;
      entries?: FileSystemSandboxEntry[];
    } | null;
  };
};
```

响应不是 `{decision: ...}`，而是：

```ts
type PermissionsRequestApprovalResponse = {
  permissions: {
    network?: { enabled: boolean | null };
    fileSystem?: {
      read: string[] | null;
      write: string[] | null;
      globScanMaxDepth?: number;
      entries?: FileSystemSandboxEntry[];
    };
  };
  scope: "turn" | "session";
  strictAutoReview?: boolean;
};
```

Remote MVP 若忽略该 server request，某些 turn 会停在等待状态。该响应类型没有独立的 `decision`/`decline` 字段，因此不能套用命令审批的拒绝格式；实现前需要实测“空授权”是否代表拒绝。未补测前，安全做法是把此类型标记为暂不支持并提示用户转到桌面端处理，同时避免在手机端启用会触发该请求的权限策略。

---

## 13. Legacy 审批方法

`ServerRequest` 联合类型仍包含：

- `execCommandApproval`
- `applyPatchApproval`

其字段和决定值与 v2 不同：

```ts
type ExecCommandApprovalResponse = { decision: ReviewDecision };
type ApplyPatchApprovalResponse = { decision: ReviewDecision };

type ReviewDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "timed_out"
  | "abort"
  | { approved_execpolicy_amendment: { proposed_execpolicy_amendment: string[] } }
  | { network_policy_amendment: { network_policy_amendment: NetworkPolicyAmendment } };
```

新实现应优先处理 v2：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

但协议分发层不要把 legacy 请求当作未知垃圾直接丢弃；至少应返回可观测错误或在 UI 中标记“不支持的旧版审批”。

---

## 14. 建议的桥接状态机

```text
connect
  -> initialize(request)
  <- initialize(response)
  -> initialized(notification)
  -> thread/list | thread/start | thread/resume

turn/start(request)
  <- turn/start(response)
  <- turn/started
  <- item/started
  <- zero or more delta notifications
  <- optional server approval request
  -> approval response using the same request id
  <- item/completed
  <- turn/completed
```

桥接层至少维护四类相关 ID：

1. client request `id`：手机/网关发往 app-server 的请求关联。
2. server request `id`：app-server 发来的审批关联；必须原样回传。
3. `threadId`。
4. `turnId` + `itemId`；命令审批的 zsh bridge 场景还要保存 `approvalId`。

不能把 server request 当通知转发后即丢弃：网关必须保留 pending request，直到手机回应、收到 `serverRequest/resolved`、连接断开或本地超时。

---

## 15. 已确认事实与未确认边界

### 已确认

1. **初始化是硬门槛**：初始化前调用 `thread/list` 返回 `-32600 Not initialized`。
2. **wire envelope 不带 `jsonrpc`**：生成的 JSONRPC schema没有该字段；stdio 实机响应也不带。
3. **stdio 为一行一个 JSON 对象**：本机探测已得到 initialize 和 thread/list 的单行 response。
4. **`RequestId` 是 `string | number`**。
5. **审批是反向 RPC request，不是 notification**：请求含 `id`，客户端须用同一 `id` 回 `{result: ...}`。
6. **`turn/interrupt` 成功结果为 `{}`**。
7. **`item/fileChange/outputDelta` 已废弃且服务端不再发出**，应依赖 patchUpdated/diffUpdated/item completed。

### 仍不确定或未实测

1. WebSocket 每个 JSON 对象对应一个 text frame，还是允许一帧多对象/分片；生成类型不定义 transport framing。
2. `--listen ws://...` 下 capability-token 与 signed-bearer-token 的实际 HTTP/WebSocket header、错误码和刷新流程；本次只核对了 `--help`，未做鉴权握手。
3. 同一 turn 中 request response 与 `turn/started`、`thread/status/changed` 等通知的严格先后顺序；生成类型不提供 ordering contract。
4. 服务端断线重连后，尚未回应的 server approval request 是否会重放；不能假设会重放，应通过 `thread/resume` + thread status 做恢复。
5. `availableDecisions` 省略/null 时各审批场景的默认合法决定集合；客户端宜保守展示一次批准、拒绝和取消，并以实机矩阵补测。
6. `grantRoot` 注释本身标记为 unstable，且注明当前是否真正生效并不明确。
7. legacy 审批在 0.144.4 的实际触发条件；这里只确认它们仍存在于生成的 `ServerRequest` 联合类型。

---


## 16. 当前 Mobile Remote 功能映射与已知限制

### 16.1 模型、reasoning effort 与 Skills

- 模型目录来自 `model/list`；当前使用字段为 `id`、`model`、`displayName`、`description`、`hidden`、`isDefault`、`defaultReasoningEffort` 和 `supportedReasoningEfforts`。
- 任务设置通过 `thread/settings/update` 的 `model`、`effort`、`summary` 更新；后续 `turn/start` 也携带所选值。
- Skills 来自 `skills/list({ cwds: [cwd] })`，结构化调用使用 `turn/start.input` 中的 `{ type: "skill", name, path }`，不是把 Skill 名仅拼成普通文本。
- app-server 没有一套供本项目直接调用的通用 Slash Command RPC。手机端 `/` 命令属于客户端约定。

当前发送处理器明确实现：

| 命令 | 行为 |
|---|---|
| `/status` | 本地展示当前已知状态、目录、模型和 effort |
| `/compact` | 调用 `thread/compact/start` |
| `/skill:<name> <prompt>` | 结构化 Skill 输入后调用 `turn/start` |

`/help`、`/models`、`/skills`、`/model:<id>`、`/effort:<level>`、`/status`、`/compact` 和 `/skill:<name>` 均由手机客户端处理并转换成明确 RPC 或本地消息；app-server 本身没有通用 slash-command RPC。

### 16.2 审批

新版字符串审批决策 `accept`、`acceptForSession`、`decline`、`cancel` 已可往返；权限审批响应使用 `{ permissions, scope }`。

当前手机 wire 同时表示字符串决策与 `acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment` 结构化决策，并在回传时恢复 app-server 所需结构。Legacy `execCommandApproval` 的 `conversationId`、`callId`、`command: string[]` 也会正规化。

### 16.3 计时、token、工具和思考事件

当前映射使用：

- Turn：`startedAt`、`completedAt`、`durationMs`；
- Item 在线生命周期：`item/started.startedAtMs`、`item/completed.completedAtMs`；
- 命令、MCP、动态工具 item 自带的 `durationMs`；
- Token：`thread/tokenUsage/updated.tokenUsage.total`；
- 思考：`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta` 和完成后的 reasoning item；
- 工具：`item/started`、`item/completed`、命令 output delta、MCP progress、文件 patch/diff；
- Subagent 活动：`collabAgentToolCall`、`subAgentActivity` item。

已知限制：历史 `ThreadItem` 通常没有创建时间，不能用加载时的 `Date.now()` 伪装成真实历史时间；`turn/plan/updated` 是完整计划快照，应覆盖旧快照，而不是像 `item/plan/delta` 一样追加；`collabAgentToolCall.agentsStates` 是对象映射，需要显式渲染各 Agent 状态。

### 16.4 Android 本地通知

完成通知以 `turn/completed` 为触发源，审批通知以 bridge 转发的待审批 server request 为触发源。客户端使用 Android 本地通知渠道，不包含 FCM、后台推送服务或离线事件补偿。

可靠性边界：

- v0.3.3 起，WebView 与 Android 前台 Service 内的只读原生 WebSocket 都能接收完成/审批/等待输入事件；两条路径使用相同通知 ID 去重；
- 原生连接只发送 `threads.list` 应用消息；保活使用 OkHttp WebSocket ping frame，不发送 `ping` 应用消息或任何控制消息，也不改变 Desktop owner 或审批归属；
- Android 强行停止、设备断网、bridge 离线或厂商阻止前台服务重建期间仍不能保证通知；
- 没有服务端离线完成事件补发队列；断线期间已经完成且重连后只剩 idle 的事件可能无法恢复；
- 文件审批收到后续 Diff 时会再次广播同一个 approval；移动端按 request ID 去重通知，同时继续更新审批卡片内容；
- 这些行为尚未经过 Android 真机验证。

---

## 17. 证据文件

主证据目录由 `/tmp/codex-appserver-ts-path` 指向：

```text
/tmp/codex-appserver-ts.hO7mYS
```

核心证据：

```text
/tmp/codex-appserver-ts.hO7mYS/ClientRequest.ts
/tmp/codex-appserver-ts.hO7mYS/ClientNotification.ts
/tmp/codex-appserver-ts.hO7mYS/ServerRequest.ts
/tmp/codex-appserver-ts.hO7mYS/ServerNotification.ts
/tmp/codex-appserver-ts.hO7mYS/InitializeParams.ts
/tmp/codex-appserver-ts.hO7mYS/InitializeCapabilities.ts
/tmp/codex-appserver-ts.hO7mYS/InitializeResponse.ts
/tmp/codex-appserver-ts.hO7mYS/RequestId.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadListParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadListResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadStartParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadStartResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadResumeParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadResumeResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadReadParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadReadResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/TurnStartParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/TurnStartResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/TurnInterruptParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/TurnInterruptResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/Thread.ts
/tmp/codex-appserver-ts.hO7mYS/v2/Turn.ts
/tmp/codex-appserver-ts.hO7mYS/v2/ThreadItem.ts
/tmp/codex-appserver-ts.hO7mYS/v2/UserInput.ts
/tmp/codex-appserver-ts.hO7mYS/v2/CommandExecutionRequestApprovalParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/CommandExecutionRequestApprovalResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/CommandExecutionApprovalDecision.ts
/tmp/codex-appserver-ts.hO7mYS/v2/FileChangeRequestApprovalParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/FileChangeRequestApprovalResponse.ts
/tmp/codex-appserver-ts.hO7mYS/v2/FileChangeApprovalDecision.ts
/tmp/codex-appserver-ts.hO7mYS/v2/PermissionsRequestApprovalParams.ts
/tmp/codex-appserver-ts.hO7mYS/v2/PermissionsRequestApprovalResponse.ts
```

为核验通用 envelope，额外在 `/tmp` 生成了 JSON Schema（未修改项目其他文件）：

```text
/tmp/codex-appserver-schema.58244.json/JSONRPCMessage.json
/tmp/codex-appserver-schema.58244.json/JSONRPCRequest.json
/tmp/codex-appserver-schema.58244.json/JSONRPCResponse.json
/tmp/codex-appserver-schema.58244.json/JSONRPCError.json
/tmp/codex-appserver-schema.58244.json/ClientRequest.json
/tmp/codex-appserver-schema.58244.json/ServerRequest.json
/tmp/codex-appserver-schema.58244.json/ServerNotification.json
```

---

## 9. 2026-07-25 增量核验：steering、TODO 与上下文压缩

### 9.1 活动 turn 中的新用户消息

Desktop canonical history 对“正在执行时追加的用户输入”使用：

```json
{
  "type": "steeringUserMessage",
  "id": "...",
  "status": "accepted",
  "clientUserMessageId": "...",
  "serverUserMessageId": "...",
  "input": [{ "type": "text", "text": "完整原始输入" }],
  "restoreMessage": {
    "text": "用户可见正文",
    "createdAt": 1784956073082
  }
}
```

手机展示应优先读取 `restoreMessage.text`，避免把 Desktop 自动附加的 ambient UI context 当作用户正文；时间应读取 `restoreMessage.createdAt`，不能使用整个长 turn 的 `startedAt`。原始样本见：

原始 wire 记录含私人任务正文，不进入公开仓库；字段结构由脱敏测试固化。

发送链路应由手机生成并贯穿同一个 `clientUserMessageId`：

```text
optimistic message
  → mobile turn.start
  → gateway
  → thread-follower-start-turn / thread-follower-steer-turn
  → canonical userMessage.clientId 或 steeringUserMessage.clientUserMessageId
```

该键用于精确替换 optimistic 内容；不能把“文本相同 + turn 开始时间接近”作为主键，因为长 turn 中 steering 的真实创建时间可能比 turn 开始晚数小时。

### 9.2 Desktop `todo-list`

真实 Desktop 投影不是普通 `plan.text`，而是：

```json
{
  "id": "...",
  "type": "todo-list",
  "explanation": "当前计划说明",
  "plan": [
    { "step": "已完成事项", "status": "completed" },
    { "step": "正在处理事项", "status": "inProgress" },
    { "step": "待处理事项", "status": "pending" }
  ]
}
```

原始样本见：

原始 wire 记录含私人任务正文，不进入公开仓库；字段结构由脱敏测试固化。

`todo-list` 是上下文状态，不应作为普通气泡显示。部分 Desktop snapshot 暂时未包含 TODO 时，不得清空上一次已确认的 TODO；只有明确清除事件或完整历史确认不存在时才可清空。

### 9.3 上下文压缩状态机

`thread/compact/start` 的成功响应类型是空对象：

```ts
type ThreadCompactStartResponse = Record<string, never>;
```

因此该响应只表示“请求已受理”，不能表示压缩完成。真实状态证据为：

| 阶段 | 原始事件/证据 |
|---|---|
| 请求受理 | `thread/compact/start` 返回 `{}`；Desktop follower 返回 `{ok:true}` |
| 开始 | `item/started` 且 `item.type === "contextCompaction"` |
| 重试 | `error` 且 `willRetry === true` |
| 成功 | 同一 item 的 `item/completed` |
| 旧版成功兼容 | `thread/compacted`（deprecated） |
| 失败 | `error` 且 `willRetry === false`，最终以 `turn/completed.status === "failed" | "interrupted"` 确认 |

生成类型原始文件：

```text
v2/ThreadCompactStartParams.ts
v2/ThreadCompactStartResponse.ts
v2/ItemStartedNotification.ts
v2/ItemCompletedNotification.ts
v2/ContextCompactedNotification.ts
v2/ErrorNotification.ts
v2/TurnCompletedNotification.ts
```

Desktop snapshot 还会投影额外字段：

```json
{
  "type": "contextCompaction",
  "id": "...",
  "completed": true,
  "source": "automatic"
}
```

其中 `completed` 与 `source: "manual" | "automatic"` 是 Desktop 私有投影字段，不是 app-server 0.144.4 生成的基础 `ThreadItem` 字段。手机端快照判定必须遵循：

```text
completed === false → running
completed === true  → succeeded
字段缺失             → 不凭“首次出现 ID”武断判定成功
```

## 10. Host 提示词队列与任务级 Git Diff

### 10.1 队列语义

官方 app-server 只有 `turn/start`、`turn/steer`、`turn/interrupt`，没有队列 RPC。Host 对手机客户端暴露：

```text
prompt.queue.list
prompt.queue.cancel
prompt.queue.promote
prompt.queue.resume
turn.start { deliveryMode: "queue" }
```

- `steer`：立即进入当前活动 turn。
- `queue`：Host 持久化 FIFO，等待 `turn/completed` 或 Desktop canonical idle，再启动新的 turn。
- `interrupted`：队列暂停。
- `sending` 时 Host 重启：恢复为 `uncertain`，不自动重发。
- 附件在排队期间 pin，投递完成或取消后 release。

### 10.2 任务级 Git Diff

手机客户端请求：

```json
{"type":"thread.diff.get","threadId":"..."}
```

Host 的仓库判定只使用任务自身 cwd：

```bash
git -C "$TASK_CWD" rev-parse --show-toplevel
```

`git` 可以自然解析 cwd 的祖先 worktree；Host 不扫描 cwd 的子目录，也不使用 turn/tool item 中出现过的其他 cwd。命令使用 `execFile` 参数数组、`GIT_OPTIONAL_LOCKS=0`、15 秒超时和 2 MiB 输出上限。非 Git cwd 返回空 `repositoryRoot`，客户端完全隐藏 Git 面板。


## 11. Android item 时间来源与 Subagent 行内目标（2026-07-26 实测）

### 11.1 时间来源必须显式区分

Desktop canonical snapshot 中的 `collabAgentToolCall`、命令等历史 item 经常没有 `createdAt`。`turn.startedAt` 只能用于保持 canonical 数组的 turn 级顺序，不能作为每个 item 的展示时间。

Android 内部为消息记录 `timestampSource`：

| 来源 | 含义 | 展示 |
|---|---|---|
| `item` | canonical item/`restoreMessage` 自带创建时间 | `HH:mm` |
| `live` | `item/started.startedAtMs`、`item/completed.completedAtMs` 或本地实时创建 | `HH:mm` |
| `observed` | 客户端已完成初始快照后，首次在活动 turn snapshot 中看到的新 item | `≈HH:mm` |
| `turn` | 只有 `turn.startedAt`，仅作顺序回退 | 不展示 |

合并规则：

1. 初次加载整段历史时，不得把加载时刻批量写成历史消息时间。
2. 在线状态下新出现但无 item 时间的活动 turn item，可记录“首次观察时间”，必须带 `≈`，不能宣称是服务端精确创建时间。
3. 已经从 `item`、`live` 或 `observed` 得到的时间，不能被后续仅有 `turn` 回退时间的 snapshot 覆盖。
4. canonical 数组顺序仍是正文顺序的 ground truth；不能按这些时间重新排序同一 turn 的 item。

2026-07-26 Redmi Note 14 Pro+ 现场证据：旧 `collabAgentToolCall` 原先错误显示 turn 开始时间 `12:53`；修复后旧项不显示伪时间，安装后在线新增工具显示 `≈15:38`、`≈15:39`。

### 11.2 Subagent 目标与渲染

目标名称优先读取结构化字段：

```text
receiverThreads[].thread.id
receiverThreads[].thread.agentNickname
receiverThreads[].thread.agentRole
agentsStates
```

只有结构化目标缺失时才使用受限兼容回退；不得扫描任意正文 UUID 并把 UUID 作为 Agent 名称。

移动端渲染约束：

- 连续工具调用仍由外层工具组统一折叠；工具组关闭时不挂载内部 Agent 控件。
- 展开后，Agent 标签只出现在产生该目标的具体工具调用行中。
- 标签与 `Subagent · sendInput` 等摘要并排，时间仍是独立列。
- 标签高度 16 CSS px，点击时 `preventDefault + stopPropagation`，只打开对应 Subagent，不切换工具详情。
- 多目标在同一摘要行横向容纳，不另起一整行撑高长列表。
## 13. 原生 Computer Use 与 MCP elicitation（2026-07-26 实测）

### 13.1 工具加载

当前 macOS Desktop Bundle 的运行时位于：

```text
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules
/Applications/ChatGPT.app/Contents/Resources/codex
```

旧配置可能仍指向已经不存在的 `/Applications/Codex.app/Contents/Resources/node_repl`。Host 启动 app-server 时会探测当前 ChatGPT/Codex Bundle，并用本次进程的 `-c mcp_servers.node_repl...` 覆盖项修正 command、Node、module directories、Codex CLI 和 Codex home；不修改用户全局 `~/.codex/config.toml`。Windows/Linux 未命中 macOS Bundle 时保持原配置。

### 13.2 审批请求与响应

真实请求：

```json
{
  "method": "mcpServer/elicitation/request",
  "params": {
    "threadId": "<thread-id>",
    "turnId": "<turn-id>",
    "serverName": "node_repl",
    "message": "Allow Computer Use to use \"System Information\"?",
    "_meta": {
      "connector_name": "Computer Use",
      "persist": ["session", "always"],
      "tool_params": { "app": "com.apple.SystemProfiler" }
    }
  }
}
```

一次允许：

```json
{ "action": "accept", "content": {}, "_meta": null }
```

本次会话允许：

```json
{ "action": "accept", "content": {}, "_meta": { "persist": "session" } }
```

拒绝：

```json
{ "action": "decline", "content": null, "_meta": null }
```

`content` 不能塞入 Host 自定义标记；Codex GUI 的原生响应构造器对 accept 使用空对象 `{}`，持久范围只放 `_meta.persist`。

### 13.3 端到端证据

线程 `019f9dc5-ed9f-72d1-8af6-3108eeaf381f` 在 Redmi Note 14 Pro+ 显示 Computer Use 审批；手机批准后，`node_repl.js` 读取 `com.apple.SystemProfiler` 成功，MCP item 为 `completed`，turn 为 `completed`，持续 `59358 ms`，最终回复“读取成功。”。
