# 文件传输核心与权限模式证据

> 状态：已集成到 Host HTTP、Gateway turn input、移动端文件选择器和 Android 下载插件。本文同时保留底层安全合约与权限协议证据。

## 1. 文件传输核心

### 1.1 服务端 API

入口：`FileTransferManager.create(options)`。

```ts
const files = await FileTransferManager.create({
  allowedRoots: [projectRoot, codexDataRoot],
  uploadDirectory: path.join(codexDataRoot, "mobile-uploads"),
  maxUploadBytes: 64 * 1024 * 1024,
  maxDownloadBytes: 256 * 1024 * 1024,
  downloadTtlMs: 10 * 60 * 1000,
  maxDownloadTtlMs: 60 * 60 * 1000,
  uploadTtlMs: 60 * 60 * 1000,
});
```

Gateway 当前使用的方法：

- `receiveUpload({ stream, fileName, mimeType, contentLength })`
  - 接受 Node `Readable`，使用 `pipeline()` 流式落盘，不把完整文件读入内存。
  - 返回 `StoredUpload`，其中 `path` 可转换为 app-server `UserInput.localImage.path` 或文本附件路径。
- `createDownloadTicket(path, options)`
  - 只为允许根目录下的真实普通文件创建随机下载票据。
  - 默认一次性、10 分钟 TTL；调用方不能超过 `maxDownloadTtlMs`。
- `claimDownload(ticketId)`
  - 先原子占用票据，再打开文件；一次性票据在打开前即撤销，防止并发重复领取。
  - 复核 canonical path、设备号、inode 和大小，降低票据创建后替换文件的 TOCTOU 风险。
- `removeUpload(uploadId)`、`cleanupExpired()`
  - 删除本进程记录的上传和过期票据。
- `cleanupOrphanedUploads()`
  - 按目录 mtime 清理上次进程崩溃后遗留、且超过上传 TTL 的随机上传目录。

### 1.2 已实现的安全边界

| 控制 | 原始实现位置 | 作用 |
|---|---|---|
| canonical allowlist | `FileTransferManager.create()`、`resolveAllowedFile()` | 对允许根和目标调用 `realpath()`；下载符号链接最终落到根外会被拒绝。 |
| prospective path 校验 | `canonicalizeProspectivePath()` | 上传目录尚不存在时，从最近的已存在祖先开始解析；阻止“根内路径 → 根外 symlink”。 |
| 随机不透明 ID | `randomBytes(24).toString("base64url")` | 192 bit 随机 ID；格式限制为 22–128 个 URL-safe 字符。 |
| 文件名清洗 | `sanitizeFileName()` | 移除 `/`、`\\`、NUL/控制字符、前后点/空格，NFKC 规范化，UTF-8 最长 180 bytes。 |
| 独占落盘 | `createWriteStream(..., { flags: "wx", mode: 0o600 })` | 不覆盖已有文件；随机父目录权限为 `0700`。 |
| 流式大小上限 | `Transform` limiter | 即使客户端伪造/不提供 `Content-Length`，超过上限也会中断并删除部分文件。 |
| MIME 清洗 | `normalizeMimeType()` / `inferMimeType()` | 去参数、拒绝 CRLF/非法 token；有限扩展名映射，未知类型回退 `application/octet-stream`。 |
| 短 TTL / 一次性 | `createDownloadTicket()` / `claimDownload()` | 默认一次性领取；过期返回 410 语义错误；不把配对令牌放入 URL。 |
| 文件替换检测 | `dev + ino + size` | 票据生成后文件被替换或变化时拒绝下载。 |

### 1.3 建议的 Gateway HTTP 合约

所有端点都必须复用现有配对令牌鉴权，并检查 Origin/Host；不要允许匿名 LAN 请求。

#### 上传

```http
POST /api/files/upload
Authorization: Bearer <pairing-token>
X-CMR-Filename: <encodeURIComponent(filename)>
Content-Type: image/png
Content-Length: 12345

<raw bytes>
```

Gateway 应把 `IncomingMessage` 直接作为 `receiveUpload().stream`，不要先 `Buffer.concat()`。
成功返回 `StoredUpload` JSON；`FileTransferError.httpStatus` 可直接映射 HTTP 状态码。

#### 下载

```http
GET /api/files/download/<opaque-ticket-id>
Authorization: Bearer <pairing-token>
Cache-Control: no-store
```

成功响应至少应包含：

```http
Content-Type: <ticket.mimeType>
Content-Length: <ticket.size>
Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(ticket.fileName)>
Cache-Control: no-store, private
X-Content-Type-Options: nosniff
```

调用 `claimDownload()` 后直接把返回的 `stream` pipe 到响应。客户端实现位于
`apps/mobile/src/lib/fileTransfer.ts`：上传使用 XHR 以获得进度，下载使用 `fetch`，令牌只放在
`Authorization` header。

### 1.4 持久化与生命周期

- 下载票据故意只保存在内存：服务器重启即撤销全部票据，这是安全默认值，不应把 bearer ticket 写进日志或持久化数据库。
- 上传正文持久化在磁盘随机目录；本进程通过 `cleanupExpired()` 清理，重启后的孤儿目录通过
  `cleanupOrphanedUploads()` 清理。
- Gateway 启动后调用一次 `cleanupOrphanedUploads()`；随后每分钟同时调用 `cleanupExpired()` 和 `cleanupOrphanedUploads()`，关闭时清理 timer。
- 不记录配对令牌、下载票据、原始文件内容。日志只记录大小、MIME、结果码和截断后的随机 ID。
- 上传文件交给 Codex 后，如需长期保留，应显式移动到项目目录；不要通过无限延长临时上传 TTL 实现持久化。

## 2. 权限模式证据

以下结论来自本机 **Codex CLI 0.144.4** 生成 TypeScript 类型和 ChatGPT/Codex Desktop 资源，
不是根据 UI 名称猜测。

### 2.1 原始证据位置

运行时证据：

```text
$ codex --version
codex-cli 0.144.4

/tmp/codex-app-server-ts-current-path
=> /tmp/codex-app-server-ts-0.144.4.gG0PXG
```

关键生成文件：

- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/AskForApproval.ts:5`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/SandboxPolicy.ts:7`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/SandboxMode.ts:5`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/ApprovalsReviewer.ts:12`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/TurnStartParams.ts:53-100`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/ThreadStartParams.ts:27-36`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/ReviewStartParams.ts:7-12`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/ReviewTarget.ts:5`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/v2/ReviewDelivery.ts:5`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/CollaborationMode.ts:10`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/ModeKind.ts:8`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/Settings.ts:9`
- `/tmp/codex-app-server-ts-0.144.4.gG0PXG/ClientRequest.ts:124`

Desktop 原始包：

- `/Applications/ChatGPT.app/Contents/Resources/app.asar`
- 本次抽出的 renderer：`/tmp/cmr-asar-evidence/app-initial-BHB6SClA.js`
- 关键片段留档：`/tmp/cmr-asar-evidence/permissions-excerpts.txt`
- renderer SHA-256：`09909b1444003ea23a48d5fa973bedf48b638c6d6ef3059fb48a9f262e73513e`
- 片段 SHA-256：`13eb58cf7f59071077705976665cf627974f793e9aef3a3f636ccb23e8c5bd79`
- Desktop `CFBundleShortVersionString`：`26.721.41059`；`CFBundleVersion`：`5848`。

复现抽取命令：

```bash
mkdir -p /tmp/cmr-asar-evidence
cd /tmp/cmr-asar-evidence
npx --yes @electron/asar extract-file \
  /Applications/ChatGPT.app/Contents/Resources/app.asar \
  webview/assets/app-initial-BHB6SClA.js
```

### 2.2 准确原始类型

#### `approvalPolicy`

`AskForApproval` 的完整 union：

```ts
type AskForApproval =
  | "untrusted"
  | "on-request"
  | { granular: {
      sandbox_approval: boolean;
      rules: boolean;
      skill_approval: boolean;
      request_permissions: boolean;
      mcp_elicitations: boolean;
    }}
  | "never";
```

#### `sandboxPolicy` / `sandbox`

`turn/start` 使用结构化的 `sandboxPolicy`：

```ts
type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "externalSandbox"; networkAccess: NetworkAccess }
  | {
      type: "workspaceWrite";
      writableRoots: AbsolutePathBuf[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };
```

`thread/start` / `thread/fork` 使用简化的 `sandbox`：

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
```

不要把两者的 camelCase 与 kebab-case 混用。

#### 审批由谁审阅：`approvalsReviewer`

```ts
type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
```

生成文件注释明确说明：该字段控制 sandbox escape、blocked network、MCP approval、ARC escalation
等**审批请求路由给谁审阅**；默认 `user`。`auto_review` 使用一个经过提示的 subagent 收集上下文并按风险框架决定。

`TurnStartParams` 支持并会粘滞到后续 turn：

```ts
approvalPolicy?: AskForApproval | null;
approvalsReviewer?: ApprovalsReviewer | null;
sandboxPolicy?: SandboxPolicy | null;
permissions?: string | null; // 与 sandboxPolicy 互斥
```

`ThreadStartParams` 对应字段是：

```ts
approvalPolicy?: AskForApproval | null;
approvalsReviewer?: ApprovalsReviewer | null;
sandbox?: SandboxMode | null;
permissions?: string | null; // 与 sandbox 互斥
```

### 2.3 Desktop 实际预设映射

`app-initial-BHB6SClA.js` offset `369357` 的原始 `eme={...}` 表明 Desktop 使用以下预设：

| Desktop 内部 mode | permission profile | sandbox | approvalPolicy | approvalsReviewer |
|---|---|---|---|---|
| `read-only` | `:read-only` | `read-only` | `on-request` | `user` |
| `auto` | `:workspace` | `workspace-write` | `on-request` | `user` |
| `granular` | `:workspace` | `workspace-write` | 下述 granular object | `user` |
| `guardian-approvals` | `:workspace` | `workspace-write` | `on-request` | `guardian_subagent` |
| `full-access` | `:danger-full-access` | `danger-full-access` | `never` | `user` |

Desktop 的 granular object 原文：

```ts
{
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  }
}
```

`app-initial-BHB6SClA.js` offset `364151` 的判定逻辑还证明：

- `dangerFullAccess + never` 被识别为 `full-access`；
- `workspaceWrite + on-request + user` 被识别为 `auto`；
- `workspaceWrite + on-request + (auto_review 或 guardian_subagent)` 被识别为 `guardian-approvals`；
- `readOnly + on-request + networkAccess:false` 被识别为 `read-only`。

因此，手机端要做“完全访问”时，应发送上述**字段组合**，而不是只保存一个中文显示字符串。
“替我审阅”若要复刻当前 Desktop 的可选预设，证据最强的映射是
`guardian-approvals → approvalsReviewer:"guardian_subagent"`。`auto_review` 是合法协议值，
但本次 Desktop 预设表没有单独用它创建另一行 UI mode；不要臆造一个额外预设。

### 2.4 “严格审阅”不能与审批模式混为一谈

本次生成类型和 Desktop 预设中**没有**名为 `strictReview` / `strict-review` 的 app-server 枚举。
已证明存在的是两套不同机制：

1. **权限/审批强度**：`approvalPolicy + approvalsReviewer + sandboxPolicy/permissions`。
2. **代码审阅任务**：独立请求 `review/start`。

`review/start` 的准确参数：

```ts
type ReviewStartParams = {
  threadId: string;
  target:
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title: string | null }
    | { type: "custom"; instructions: string };
  delivery?: "inline" | "detached" | null;
};
```

所以 UI 如果要展示“严格审阅”，必须先定义产品语义：

- 如果意思是“只审代码，不修改”，应走 `review/start`，并可同时使用 read-only 权限；
- 如果意思是“所有高风险动作都让我确认”，应选择严格的 `approvalPolicy` / sandbox 组合；
- 不应把“严格审阅”直接硬编码成一个不存在的协议值。

### 2.5 Collaboration mode 与权限不是一回事

`TurnStartParams.collaborationMode` 的结构是：

```ts
type CollaborationMode = {
  mode: "plan" | "default";
  settings: {
    model: string;
    reasoning_effort: ReasoningEffort | null;
    developer_instructions: string | null;
  };
};
```

它会覆盖 model、reasoning effort、developer instructions，但不替代
`approvalPolicy`、`approvalsReviewer`、`sandboxPolicy`。客户端应调用
`collaborationMode/list` 获取服务端可用 preset；权限 profile 则调用
`permissionProfile/list`，两组选择器需要分别展示和持久化。

## 3. 测试证据

执行：

```bash
npm run test -w @codex-mobile/server -- test/file-transfer.test.ts
npm run typecheck -w @codex-mobile/server
npm run typecheck -w @codex-mobile/mobile
```

结果：

```text
Test Files  1 passed (1)
Tests       7 passed (7)
server typecheck: exit 0
mobile typecheck: exit 0
```

覆盖项：文件名/MIME 清洗、流式上传、大小超限与部分文件清理、根目录与 symlink escape、
一次性票据、文件替换、TTL、上传清理、上传目录 symlink escape。

## Desktop canonical 附件临时信任

Desktop GUI 的图片通常位于 macOS 临时目录，不属于管理员配置的 `CMR_FILE_ROOTS`。为避免把整个 `/var/folders` 加入下载白名单，Host 只对 Desktop canonical user item 中实际出现的**精确文件 realpath**建立短期信任记录：

- 只扫描 user/steeringUserMessage 的 image/file/mention 输入和附件字段；
- 不信任工具输出、命令文本或任意 `path` 字段；
- 注册时验证 regular file、大小上限和 canonical realpath；
- 下载仍需 bearer 鉴权与一次性 opaque ticket；
- sibling 文件和目录不会因父目录相同而获得权限；
- 信任记录按 TTL 清理。
