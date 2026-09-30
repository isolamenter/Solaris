# B01 — 共享契约与扩展边界

版本：v3（实施候选，尚未冻结） 日期：2026-09-29
依据：[DECISIONS.md](DECISIONS.md)、[PROTOCOL_MATRIX.md](PROTOCOL_MATRIX.md)、[REFACTOR_OUTLINE.md](REFACTOR_OUTLINE.md)。实现者与文件所有权见 [INTEGRATION_MANIFEST.md](INTEGRATION_MANIFEST.md)。

本次只修订文档，没有修改代码或证明基线已通过测试。D1–D8、D15 沿用既有决策记录；新增工程规则用于修正契约冲突。未确认的产品选择见 §12，不以本文件冒充维护者已确认。

## 1. 范围与边界

- 唯一业务操作为同步单次图片生成（含参考图编辑）。删除视频、Batch、上游任务轮询、取消、JSONL 和 Server 素材库，不保留占位或双实现。
- 同步上游仍有在途请求、重复提交和未知结果，需要运行记录与认领；“同步”不等于没有状态或恢复检查。
- Server 保存用户、连接、模型、运行元数据与幂等凭据，不持久化图片。短期进程内结果缓存只提供尽力重放，不能承诺离线恢复或跨设备取图。
- 开源与内部部署共用认证入口、Solaris 会话、生成 API 和 Client。认证协议、凭证来源及模型协议分别适配。

```ts
export type Operation = "imageGenerate";
export type AdapterId = "gemini";
export type AuthAdapterId = "oidc"; // 服务端注册清单；内部接入时显式扩展
export type CredentialSourceId = "user-key"; // 首期只实现用户录入
export type RunStatus = "running" | "success" | "error" | "uncertain";
export type ParameterValues = Record<string, string | number | boolean>;
```

封闭标识在注册表、Zod 校验与类型中同步更新。内部新增认证/凭证标识不改变 Client 的登录传输方式，不建设动态插件系统。

## 2. 身份、会话与认证适配

### 2.1 公开 DTO

```ts
export type UserDto = { id: string; displayName: string | null; createdAt: string };
export type SessionDto = { token: string; expiresAt: string; user: UserDto };
export type DeploymentDto = {
  name: string;
  auth: {
    flow: "desktop-code"; // Solaris 的统一传输流程，而非外部认证协议
    authorizationEndpoint: string;
    tokenEndpoint: string;
  };
};
```

外部身份映射唯一键为 `(issuer, subject)`；非 OIDC 适配器也必须提供稳定、隔离的身份源与主体标识。邮箱和显示名不作为身份匹配依据。所有 Solaris 用户和连接 ID 为 UUID。

会话 token 为随机不透明串；Server 只持久化哈希，Client 存系统安全存储。过期或撤销返回 `401 AUTH_REQUIRED`。首期不引入未决定的刷新 token：过期重新登录；登出撤销当前会话。上游 IdP token 仅用于登录验证，不持久化。

### 2.2 服务端认证接口（B03 实现）

以下类型放在独立服务端接口文件，不进入 Client DTO。选定协议的具体 token、nonce 与 verifier 只由适配器持有。

```ts
export type ExternalIdentity = { issuer: string; subject: string; displayName?: string };
export type AuthTransaction = { id: string; state: string; expiresAt: string };
export interface AuthAdapter {
  id: AuthAdapterId;
  begin(input: { transaction: AuthTransaction; callbackUrl: string }): Promise<{ authorizationUrl: string }>;
  complete(input: { transaction: AuthTransaction; callbackUrl: string; parameters: Record<string, string> }): Promise<ExternalIdentity>;
  discard(transactionId: string): void;
}
export interface SessionService {
  authenticate(token: string): Promise<{ sessionId: string; user: UserDto }>;
  issue(userId: string): Promise<SessionDto>;
  revoke(sessionId: string, userId: string): Promise<void>;
}
```

`complete` 必须执行所选协议的验证，不可只解析外部响应。OIDC 校验 issuer、audience、过期、nonce、签名和授权码交换；内部适配器按经确认的身份协议提供等价身份保证。

### 2.3 两段授权码与回环回调

1. Client 先监听 `http://127.0.0.1:<随机非零端口>/callback`，生成 Client state 与 S256 PKCE challenge，系统浏览器打开 Solaris authorize。
2. Server 严格解析回环 URL：只允许登记的 loopback IP、HTTP、指定 `/callback` 路径、有效端口，无 credentials/query/fragment。不接受 localhost 别名、后缀匹配或任意 URL 跳转。
3. Server 创建短期登录事务，绑定 Client state、challenge 和完整 redirect URI；另生成独立的上游 state。OIDC 适配器生成自己的 PKCE verifier 与 nonce，不能复用桌面 verifier。
4. IdP 回调固定的 Server callback。Server 原子消费上游事务，适配器交换并验证身份，映射 Solaris 用户。
5. Server 签发短期一次性 Solaris 授权码，绑定该用户、Client challenge 和 redirect URI；向回环返回 code + Client state，不能把会话 token 放进 URL。
6. Client 校验 state，向 token endpoint 提交 code + verifier。Server 原子校验并消费 code，成功时才签发 SessionDto。

登录事务和一次性码由 B03 的有界内存存储管理，短 TTL、原子消费；重启时失效，需要重新登录，不引入额外数据库。两个 state 命名空间与两个 PKCE secret 独立，错误、超时和退出时清理。禁止记录 code/verifier/token，回调响应不缓存。具体 TTL 与数量限额由 B03 提供并经 B08 校验。

## 3. 用户连接、模型与凭证来源

```ts
export type ConnectionDto = {
  id: string; name: string; adapterId: AdapterId; baseUrl: string;
  config: Record<string, unknown>; enabled: boolean; hasKey: boolean;
  lastTest: { ok: boolean; at: string; detail?: string } | null;
  createdAt: string; updatedAt: string;
};
export type ModelDto = {
  id: string; connectionId: string; providerModelId: string; label: string;
  capabilities: Operation[];
  operationConfigs: Partial<Record<Operation, ModelOperationConfigDto>>;
  adapted: boolean; availabilityMessage?: string; manual: boolean;
  enabled: boolean; createdAt: string;
};
```

`ModelOperationConfigDto`、参数选项、参数限制与 `AttachmentPolicyDto` 沿用当前字段，由 B01 明确保留到代码契约。参数值 schema strict。派生能力、operationConfigs、adapted、availabilityMessage 不入库；上游能力元数据不足时使用已实现的精确适配表，正则只过滤候选，不授权运行。发现刷新保留手动模型；保留已有模型行 ID，不让同一 ID 指向新的 providerModelId。

连接归用户所有，adapterId 创建后不可变。Key 只写，DTO 仅有 hasKey；用户录入仅用于提交，Client 不保存调用 Key。保留 vault 格式，AAD 为 `${userId}:${connectionId}`，两个 ID 必须验证为 UUID。config 按适配器明确的 strict schema 校验，不接收秘密字段或把任意配置作为安全 DTO。HTTPS base URL 无 credentials/query/fragment；请求与重定向目标还需远程部署的出站策略检查。

### 3.1 独立凭证接口

```ts
export type ResolvedCredential = { apiKey: string; expiresAt: string | null };
export interface CredentialSource {
  id: CredentialSourceId;
  resolve(input: { userId: string; connectionId: string }): Promise<ResolvedCredential>;
  hasCredential(input: { userId: string; connectionId: string }): Promise<boolean>;
}
```

B03 实现 user-key 来源，通过 repository 先校验所有权再解密。B05 依赖此接口，不直接读密文或知道外部 SSO 的 Key 接口。内部来源由 B09 接入，不默认回退到用户 Key。过期凭证不能用于新调用；获取失败和会话失效分别表达。当前没有后台上游任务，因此不设计后台授权/刷新轮询。

### 3.2 outputCount（待确认）

已知现有实现仅截断上游返回图片，不保证请求的张数。**不得将其展示成“生成 N 张”保证，也不得为了凑数隐式多次调用上游。** 保留、改为“最多保留 N 张”或移除控件尚待确认；本契约不冻结 requestedCount 字段。RunDto 记录实际返回/保留数量，B04/B07 仅此控件和截断行为暂不冻结，其余接口可以继续。

## 4. 单次请求、响应与结果可取性

### 4.1 multipart 请求

`POST /api/generations`：一个名为 `request` 的 JSON **文本字段**，零至模型允许数量的 `reference` 文件。request 形状：

```ts
export type GenerationRequestDto = {
  connectionId: string; modelId: string; prompt: string;
  parameters?: ParameterValues; submissionId: string; contentDigest: string;
};
```

移除遗留 size 字段：尺寸使用模型 operationConfigs 中的参数，不维护两套入口。是否有输出保留数参数按 §3.2 决策。Server 先校验请求和模型，再按原始字节处理参考图；只在内存中传递，不用上传插件的落盘辅助函数。

multipart 的 files 上限为已适配模型最大 maxCount（当前 14）；request 是 field，**不额外占用 files 配额**。限定 fields=1，并明确 fieldSize、parts、单文件粗上限和请求总量。最终 MIME、模型单图/总量/数量由服务层校验。FST_FILES_LIMIT → REFERENCE_COUNT，FST_REQ_FILE_TOO_LARGE → REFERENCE_SIZE，field/parts 格式违规 → VALIDATION；这些错误不变成 INTERNAL。B08 测试文本字段和超限文件路径。

### 4.2 历史与交付 DTO

```ts
export type GeneratedImageDto = { mimeType: string; byteSize: number; dataBase64: string };
export type RunImageRefDto = { mimeType: string; byteSize: number };
export type RunDto = {
  id: string; connectionId: string; connectionName: string; modelId: string;
  providerModelId: string; operation: Operation; status: RunStatus;
  prompt: string; parameters: ParameterValues; referenceCount: number;
  returnedImageCount: number | null; retainedImageCount: number | null;
  images: RunImageRefDto[];
  error: { code: string; message: string } | null;
  createdAt: string; updatedAt: string;
};
export type GenerationResultDto =
  | { kind: "pending" }
  | { kind: "delivered"; images: GeneratedImageDto[] }
  | { kind: "unavailable"; reason: "not-generated" | "submission-unknown" | "cache-miss" | "result-too-large" | "history-deleted" };
export type GenerationResponseDto = {
  submissionId: string;
  status: RunStatus;
  run: RunDto | null; // 仅删除历史后的重放为 null
  result: GenerationResultDto;
};
```

所有成功处理的生成/重放响应使用 GenerationResponseDto；running 为 HTTP 202 + pending，其余为 HTTP 200。首次明确上游失败/未知结果也返回该结构，让 Client 收到对应运行记录并展示 error/uncertain。请求校验、认证、越权、内容冲突等未进入执行的失败使用标准 HTTP 错误 envelope。不得同一 200 按请求先后切换顶层形状。

RunDto.status 表达生成结果，result.kind 表达本次交付，本地落盘状态另存。success 至少返回过一张有效图；图片因缓存/响应预算不可交付不把生成成功改为 error。超过交付上限为 success + unavailable/result-too-large，并保留可获取的图片元数据；日志不留图片。解码或 MIME 不合法等完整收到但无有效图片为 error。部分响应中断、无法确定完整生成结果为 uncertain。

上游响应读取设有界原始 JSON 预算、解码图片预算与完整调用时限，达到预算立即停止读取。已确认响应超过预算但尚不能解析时，不声称已知图片数量，数量为 null；状态保守为 uncertain，result 为 unavailable/result-too-large，明确可能已计费。不得靠读完无限大响应后检查 24 MB 来保护内存。

候选交付图片总预算 24 MiB，原始响应预算需包含 base64 膨胀与结构开销，由 B04/B08 实测确定（§12）。预算不通过静默截断实现。输出过大应提示缩小尺寸，不能声称降低 Solaris 截断数量就能减少上游生成或读取量。

历史 GET 只返回元数据，永远没有 dataBase64、inspector 或上游响应。缓存命中返回的图片必须经过用户和提交归属验证。

### 4.3 有界结果缓存与限制

B05 提供单进程内缓存，键 `(userId, submissionId)`，候选 TTL 10 分钟、总图片字节 256 MiB（B08 校验）；缓存不落盘，重启丢失，LRU 提前淘汰允许发生，TTL 不是保证可取的时长。记录成功与缓存发布之间的进程内交接必须协调，避免 success 重放在结果尚未发布时误报 cache-miss。

同设备收到图片后保存失败，优先重用 Client 已接收字节；字节已丢失时可用原完整输入及同 submissionId 重放，在缓存尚可用时取回。离线/App 或 Server 重启后不保证成功。跨设备历史默认只提供元数据；缓存重放不是素材同步功能。

是否接受跨设备只看元数据仍待维护者确认。任何 UI 不得把历史 success 当成可下载；缓存未命中明确不可取，不自动重新生成。

## 5. 状态与在途请求清理

| 起点 | 事件 | 终点 |
| --- | --- | --- |
| 无记录 | 校验通过、事务认领 | running |
| running | 至少一张有效图 | success |
| running | 完整明确拒绝/无有效图片 | error |
| running | 请求可能已受理，但未得确定结果 | uncertain |
| 终态 | 后续写入 | 返回原行，拒绝覆盖 |

error 与 uncertain 分类依赖实际执行证据，不简单按 4xx/5xx/异常名称判断。请求明确未发出可记 error；已发送但 5xx/网络异常无法证明拒绝时 uncertain。generation POST 不自动重试上游，查询模型等只读调用可做有界重试。显式重跑必须新 submissionId，提示可能重复计费。

B04 的完整调用 deadline 包括发送、响应体读取、解析和解码。不能在收到 headers 后清除唯一超时；调用方提供 signal 时也不能绕过 deadline。B05 维护 active run 集合，随调用结束清理；B08 负责生命周期接线。

单进程、单个 Server 独占数据目录：启动接收请求前将上次进程遗留 running 置 uncertain，不重提；周期检查只处理不在 active 集合中的陈旧 running。不能只根据 updatedAt 判定活跃请求失败，也不能以“真实成功结果丢弃并打日志”作为正常防竞态策略。B02 状态写入使用条件更新，B05 每个调用确定结束后提交终态；B08 优雅停机给在途调用明确的结束策略，并保证下次启动收敛。

## 6. 摘要、幂等与删除历史

### 6.1 规范化摘要

作用域 `(userId, submissionId)`，Client 为一次明确运行生成稳定 UUID；传输重试复用，用户新运行用新 ID。“同草稿”不等于永远同 ID。

Server 从收到的真实输入重算 contentDigest。摘要对象固定为：`{connectionId, modelId, prompt, parameters, references}`；parameters 缺席为 null，references 为按 multipart 顺序排列的 `{mimeType, sha256}`。MIME 使用经 allowlist 验证的小写规范值，摘要为原始图片字节 SHA-256 小写 hex，不包含文件名或路径。其他字段不允许加入请求。

对象键按 Unicode 码点顺序排序后 JSON 序列化（数组保持顺序）；JSON 字符串按 JSON.stringify 语义，无额外空格，UTF-8，再 SHA-256。参数只含有限 number/string/boolean，拒绝非有限数值；不对 prompt 做隐式 trim/Unicode 归一化。B01 固定完整 canonical string 与 digest 测试向量，包括缺席/null、空对象、键顺序、图片顺序/MIME及内容差异。Service 参数默认化在摘要计算之后，快照实际生效参数。

providerModelId 与连接 config 不由 Client 声明；认领时保存执行快照。重放先查幂等凭据，再校验当前资源是否已删除/禁用，不能因历史连接变化再调用上游。无法从旧模型映射复原执行的情况只影响新运行，不改变旧运行的重放。

### 6.2 重放

| 已有记录 | GenerationResponseDto |
| --- | --- |
| 摘要不同 | HTTP 409 SUBMISSION_CONFLICT |
| running | 202，pending，不再次调用 |
| success + 缓存命中 | 200，delivered |
| success + 缓存未命中 | 200，unavailable/cache-miss |
| error | 200，unavailable/not-generated |
| uncertain | 200，unavailable/submission-unknown |
| 历史已删除 | 200，run=null，unavailable/history-deleted，保留原 status |

### 6.3 删除不会解除去重

B02 保存最小 SubmissionReceipt，唯一 `(user_id, submission_id)`，包含 contentDigest、runId、status 和 historyDeleted。删除运行历史只移除提示词/参数/图元数据与 Client 可见记录，保留凭据，并清除对应结果缓存。再次提交相同 ID 不调用上游；内容变化仍冲突。

首期不自动过期去重凭据；只保留最小标识与摘要，不含图片/完整输入。清除全部用户数据/凭据或库重置会结束对应去重保证，须在运维文档说明。running 的历史删除返回 409 RUN_ACTIVE，不实现取消。

## 7. ProviderPlugin 与诊断

```ts
export type Attachment = { mimeType: string; base64: string; byteSize: number };
export type ImageInput = { model: string; prompt: string; attachments?: Attachment[]; parameters?: ParameterValues };
export type ProviderConnection = {
  id: string; adapterId: AdapterId; baseUrl: string; config: Record<string, unknown>;
  credential: ResolvedCredential;
};
export type ImageResult = {
  images: { bytes: Buffer; mimeType: string }[];
  returnedImageCount: number;
  diagnostics: { durationMs: number; returnedImageCount: number };
};
export type ProviderPlugin = {
  id: AdapterId; label: string;
  connectionSchema: z.ZodType<{ baseUrl: string; config?: Record<string, unknown> }>;
  fields: { name: string; label: string; type: "url" | "text" | "number"; placeholder?: string; required?: boolean }[];
  discoverModels?: (connection: ProviderConnection) => Promise<DiscoveredModel[]>;
  modelAvailability?: (providerModelId: string) => { adapted: boolean; message?: string };
  modelOperationConfig?: (providerModelId: string, operation: Operation) => ProviderModelOperationConfig | undefined;
  testConnection: (connection: ProviderConnection) => Promise<{ detail: string }>;
  operations: { imageGenerate?: (connection: ProviderConnection, input: ImageInput) => Promise<ImageResult> };
};
```

DiscoveredModel 与 ProviderModelOperationConfig 沿用现有明确类型、去掉视频成员，B01 在代码中补齐。失败通过结构化 ProviderCallError 表达：`outcome: "rejected" | "unknown"`、冻结公共 errorCode、可公开 message，不回传 raw body、URL query Key 或原异常。B04 在完整调用边界分类，B05 按 outcome 更新状态。

诊断采用安全字段白名单（耗时、数量等），不返回完整 request/response。B03 的 redact 保留通用秘密脱敏，但不能依赖仅按键名脱敏来清理任意字符串/base64。B08 日志和错误 details 也必须经过安全输出约束。

## 8. Repository（B02 实现）

私有 Row 类型由 B01 在服务端接口文件定义：UserRow 对应 UserDto；SessionRow 包含 id/userId/tokenHash/expiresAt/revokedAt；ConnectionRow 在 ConnectionDto 元数据基础上包含 userId/keyEncrypted（无明文）；ModelRow 包含持久化模型元数据，不含派生配置；RunRow 为 RunDto + userId/submissionId/contentDigest；ReceiptRow 为 §6.3 最小凭据。DTO 映射须显式挑选字段，不直接展开 Row。

```ts
export interface Repository {
  findUserByExternalIdentity(issuer: string, subject: string): UserRow | undefined;
  createUserWithIdentity(input: { issuer: string; subject: string; displayName?: string }): UserRow;
  getUser(userId: string): UserRow;
  createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: string }): void;
  findSessionByTokenHash(tokenHash: string): SessionRow | undefined;
  revokeSession(sessionId: string, userId: string): void;
  listConnections(userId: string): ConnectionRow[];
  getConnection(userId: string, connectionId: string): ConnectionRow;
  createConnection(input: { userId: string; id: string; name: string; adapterId: AdapterId; baseUrl: string; config: Record<string, unknown>; keyEncrypted: string }): ConnectionRow;
  updateConnection(userId: string, connectionId: string, input: { name: string; baseUrl: string; config: Record<string, unknown>; enabled: boolean; keyEncrypted?: string }): ConnectionRow;
  deleteConnection(userId: string, connectionId: string): void;
  recordConnectionTest(userId: string, connectionId: string, test: { ok: boolean; at: string; detail?: string }): void;
  listModels(userId: string, connectionId: string): ModelRow[];
  getModelForConnection(userId: string, connectionId: string, modelId: string): ModelRow;
  getModelById(userId: string, modelId: string): ModelRow;
  upsertModel(input: { userId: string; connectionId: string; providerModelId: string; label?: string; capabilities: Operation[]; manual: boolean; enabled?: boolean }): ModelRow;
  replaceDiscoveredModels(userId: string, connectionId: string, discovered: DiscoveredModel[]): void;
  deleteModel(userId: string, connectionId: string, modelId: string): void;
  getReceipt(userId: string, submissionId: string): ReceiptRow | undefined;
  claimRun(input: { userId: string; id: string; submissionId: string; contentDigest: string; connectionId: string; connectionName: string; modelId: string; providerModelId: string; prompt: string; parameters: ParameterValues; referenceCount: number }): { receipt: ReceiptRow; run: RunRow | null; claimed: boolean };
  getRun(userId: string, runId: string): RunRow;
  listRuns(userId: string, page: { limit: number; cursor?: string }): { items: RunRow[]; nextCursor: string | null };
  finishRun(userId: string, runId: string, input: { status: "success" | "error" | "uncertain"; images: RunImageRefDto[]; returnedImageCount: number | null; retainedImageCount: number | null; error?: { code: string; message: string } }): RunRow;
  deleteRun(userId: string, runId: string): { submissionId: string };
  recoverAbandonedRuns(): string[];
  reapStaleRuns(input: { before: string; excludeRunIds: string[] }): string[];
}
```

业务资源方法始终带 userId，越权/不存在统一 NOT_FOUND。身份查找、token 哈希认证和进程启动恢复是明确的内部例外，不能暴露为无用户过滤的业务路由。createUserWithIdentity 并发时同一 issuer/subject 返回同一用户。

### 8.0 私有 Row 字段（冻结，落地于 `src/server/interfaces.ts`）

Row 只在服务端存在，**不得被 Client 导入**。DTO 映射必须显式挑字段、不得展开 Row，因此 `keyEncrypted` 与 `tokenHash` 在构造上无法进入 DTO。

| Row | 字段 |
| --- | --- |
| `UserRow` | `id`, `displayName`, `createdAt` |
| `SessionRow` | `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt` |
| `ConnectionRow` | `id`, `userId`, `name`, `adapterId`, `baseUrl`, `config`, `keyEncrypted`, `enabled`, `lastTest`, `createdAt`, `updatedAt` |
| `ModelRow` | `id`, `userId`, `connectionId`, `providerModelId`, `label`, `capabilities`, `manual`, `enabled`, `createdAt`, `updatedAt`（不含派生配置） |
| `RunRow` | `RunDto` 全部字段 + `userId`, `submissionId`, `contentDigest` |
| `ReceiptRow` | `userId`, `submissionId`, `contentDigest`, `runId`, `status`, `historyDeleted`, `createdAt` |

`RunDto` 的字段集见 §4.2。`RunRow` 的 `images` 是 `RunImageRefDto[]`（只有尺寸），**任何 Row 都不含图片字节**。

claimRun 在单事务中认领 receipt 与创建 run，摘要冲突原子拒绝，重复 claimed=false。finishRun 条件更新 running，并在同事务更新 receipt；终态不可覆盖。删除模型/连接保留历史快照，running 依赖尚未结束时拒绝删除（RESOURCE_IN_USE）；发现刷新也不删除在途依赖。结果缓存属于 B05，不放入 repository。

### 8.1 旧库

D7 不迁移数据不等于启动自动删除。检测旧 schema 拒绝以新服务打开，并提示使用新的空数据目录；不自动修改、删除旧库、WAL 或图片。新目录按新 schema 创建，无双读/AAD 回退。清理旧数据是另行明确操作，不由此文档授权。未来新 schema 的版本检测与升级说明归 B02/B10，不承诺永久忽略升级问题。

## 9. HTTP 与错误

| 方法 | 路径 | 响应/规则 |
| --- | --- | --- |
| GET | /api/deployment | 无认证，DeploymentDto |
| GET | /api/auth/desktop/authorize | 无认证，校验回环和 challenge 后 302 |
| GET | /api/auth/callback | 无认证，校验一次性上游事务后 302 |
| POST | /api/auth/desktop/token | 无认证，code+code_verifier → SessionDto |
| POST | /api/auth/logout | bearer，撤销当前会话，204 |
| GET | /api/me | bearer，UserDto |
| GET | /api/adapters | bearer，静态适配器表单配置 |
| GET/POST | /api/connections | bearer，列表/创建 ConnectionDto（创建 201） |
| PUT/DELETE | /api/connections/:id | bearer，更新 ConnectionDto/删除 204 |
| POST | /api/connections/:id/test | bearer，{ok, at, detail?} |
| GET | /api/connections/:id/models | bearer，ModelDto[] |
| POST | /api/connections/:id/models/refresh | bearer，ModelDto[]，保留手动模型 |
| POST | /api/connections/:id/models | bearer，手动添加 ModelDto，201 |
| DELETE | /api/models/:id | bearer，204 |
| POST | /api/generations | bearer，multipart，统一 GenerationResponseDto（200/202） |
| GET | /api/runs | bearer，{items: RunDto[], nextCursor: string \| null} |
| GET/DELETE | /api/runs/:id | bearer，RunDto/删除 204 |

连接创建严格字段 `{name, adapterId, baseUrl, config?, apiKey}`；更新 `{name, baseUrl, config?, enabled, apiKey?}`，不允许更改 adapterId。手动模型添加 `{providerModelId, label?, capabilities}`，capabilities 仅 imageGenerate；身份字段从会话取，不能通过请求覆盖。分页 limit=1–100 默认30，cursor 不透明，稳定按 createdAt+id 倒序，禁止跨用户使用游标。

统一错误 envelope `{error:{code,message,details?}}`，细节只含安全校验信息。公开候选码：

| code | HTTP | 语义 |
| --- | --- | --- |
| AUTH_REQUIRED | 401 | 无有效会话 |
| AUTH_FLOW_INVALID | 400 | 登录事务/state/code/PKCE/回调不合法 |
| FORBIDDEN | 403 | 已认证但操作策略不允许 |
| NOT_FOUND | 404 | 资源不存在或不属当前用户 |
| VALIDATION / DIGEST_MISMATCH | 400 | 格式或摘要错误 |
| SUBMISSION_CONFLICT | 409 | 同 ID 不同内容 |
| RUN_ACTIVE / RESOURCE_IN_USE | 409 | 在途运行或资源不可删除 |
| CONNECTION_DISABLED / CREDENTIAL_MISSING | 409 | 连接不可用于新调用 |
| MODEL_NOT_ADAPTED / OPERATION_UNAVAILABLE / PARAMETERS_UNAVAILABLE | 400 | 能力不足 |
| REFERENCE_COUNT | 400 | 参考图数量 |
| REFERENCE_TYPE | 415 | MIME |
| REFERENCE_SIZE / REFERENCE_TOTAL_SIZE | 413 | 单图/总量 |
| BASE_URL_INVALID / BASE_URL_INSECURE | 400 | 地址违规 |
| UPSTREAM_FAILED / UPSTREAM_NO_IMAGE / UPSTREAM_UNAVAILABLE / RESULT_TOO_LARGE | 运行错误字段 | 已执行的生成用 §4.2 envelope 和 status；未创建 run 的连接测试/发现失败使用 502 |
| INTERNAL | 500 | 通用安全错误，不返回原始异常 |

原有 /batches、/jobs、/assets、/runs/:id/cancel、/runs/:id/curl、全局 clear-history 和 /plugins 路由删除。新远程安全边界完成前不解除 loopback/same-origin 保护。桌面 API 只用 bearer；浏览器 callback 按事务校验，不能把允许 loopback callback 当成放开 API CORS 的理由。

### 9.1 传输边界拒绝（不属于 API 错误码表）

部署边界（Host / Origin）在**任何 handler 之前**拒绝请求，因此**不经过 `toPublicError`**，也**不加入** `errorCodes`：

| 情形 | HTTP | code |
| --- | --- | --- |
| `Host` 不是本部署的 authority | **421** | `HOST_REJECTED` |
| `Origin` 不在白名单 | **403** | `ORIGIN_REJECTED` |

理由：把例行拒绝折叠成 `INTERNAL 500` 会让它在监控里与真实故障不可区分，而 `logger:false` 下运维看不到原因。这两条是**传输层**拒绝（请求从未进入 API），不是 API 语义；实现上由 hook 直接应答，不抛异常。`toPublicError` 内仍保留一份防御性映射，确保任何路径下都不会退化成 500。

**不变量**：被拒请求**到不了任何 handler**，包含未知路径；缺少 `SOLARIS_PUBLIC_ORIGIN` 时**拒绝启动**而不是以弱化模式运行；边界只有一套（无「本地模式」与「远程模式」并列）。


## 10. Client 本地接口（B06 实现，B07 消费）

```ts
export type LocalScope = { serverOrigin: string; userId: string };
export type ReferenceRecord = { id: string; filePath: string; mimeType: string; sha256: string; byteSize: number };
export type DraftRecord = {
  id: string; connectionId: string | null; modelId: string | null;
  prompt: string; parameters: ParameterValues; references: ReferenceRecord[];
  updatedAt: string;
};
export type LocalImageRecord = { index: number; filePath: string | null; state: "unsaved" | "saved" | "missing"; byteSize: number; mimeType: string };
export type LocalRunRecord = { runId: string; submissionId: string; images: LocalImageRecord[]; updatedAt: string };
export interface LocalStore {
  readSession(serverOrigin: string): Promise<SessionDto | null>;
  writeSession(serverOrigin: string, session: SessionDto): Promise<void>;
  clearSession(serverOrigin: string): Promise<void>;
  listDrafts(scope: LocalScope): Promise<DraftRecord[]>;
  saveDraft(scope: LocalScope, draft: DraftRecord): Promise<void>;
  deleteDraft(scope: LocalScope, draftId: string): Promise<void>;
  listLocalRuns(scope: LocalScope): Promise<LocalRunRecord[]>;
  upsertLocalRun(scope: LocalScope, record: LocalRunRecord): Promise<void>;
  saveImage(scope: LocalScope, input: { runId: string; index: number; mimeType: string; dataBase64: string }): Promise<{ filePath: string; byteSize: number }>;
  imageExists(scope: LocalScope, filePath: string): Promise<boolean>;
  readSavedImage(scope: LocalScope, filePath: string): Promise<{ mimeType: string; bytes: Uint8Array }>;
  revealInFileManager(scope: LocalScope, filePath: string): Promise<void>;
  chooseSaveDirectory(scope: LocalScope): Promise<string | null>;
  chooseReferenceFiles(scope: LocalScope): Promise<string[]>;
  readReferenceFile(scope: LocalScope, filePath: string): Promise<{ mimeType: string; bytes: Uint8Array }>;
}
export interface DesktopLogin {
  authorize(input: { authorizationEndpoint: string; signal?: AbortSignal }): Promise<{ code: string; codeVerifier: string }>;
}
```

本地查询/文件关联均按规范化 Server origin + Solaris userId 隔离；唯一键同时含 scope 与记录 ID。一个 Server 仅保留当前登录用户的活动 Session，writeSession 切换账号替换旧 token；会话全部保存在安全存储。切换 Server 不删除其他 Server 的用户文件，但不携带旧 token；退出清当前 token，后续重新登录同身份才能访问对应本地记录。

DesktopLogin 由原生层创建回环监听、state/PKCE 并打开系统浏览器，校验回调后返回 code/verifier，超时/取消关闭监听。B07 将 verifier 仅发送给 Server token endpoint，不入 SQLite/日志。

saveImage 使用设备控制的目录与命名、临时文件后原子提交；不接受远程给定路径。成功之后才 upsert 已保存状态，失败保留 unsaved；图片丢失只标记本设备 missing，不改变远程 status。原生路径访问限制在用户选定参考图及授权的保存目录，不能把 arbitrary path 参数变成越权文件读取。

## 11. 冻结与测试归属

B01 负责真实 TypeScript 类型、schema、规范化工具和固定向量；文档中的私有 Row 类型在冻结前需补齐字段，并验证各消费者可编译。类型占位、未生成代码或缺 manifest 时不能宣布冻结。

| 验证 | 所有者 |
| --- | --- |
| DTO/schema、canonical JSON/digest 测试向量 | B01 |
| 事务认领、身份/资源归属、删除后去重、状态条件更新、旧库拒绝 | B02 |
| 认证两段事务、PKCE/state、会话、vault/脱敏 | B03 |
| 模型能力、完整超时、响应读取限制、Provider outcome | B04 |
| 上游调用计数、缓存重放/淘汰/删除、在途保护 | B05 |
| 原生登录、账号隔离、文件落盘 | B06 |
| UI/typed API、202/缓存失效/保存失败/跨账号 | B07 |
| HTTP 权限、安全边界、上传限制、真实公开联调 | B08 |
| 内部真实身份/凭证/模型接入 | B09 |
| 安装与文档交付、最终证据矩阵 | B10 |

测试替身不能证明真实上游/IdP/桌面安装行为。完整联调测试由 B08 编写，不要求 B01 编写尚无实现的 repository 或 HTTP 测试。实现各任务遵循 focused tests → typecheck → lint。

## 12. 未决与冻结条件

| 项 | 影响/执行边界 |
| --- | --- |
| outputCount 保留/改标签/移除 | B04 截断行为及 B07 控件暂停冻结；不保证张数，不加凑数调用 |
| 跨设备只看元数据是否接受 | B07/B10 不承诺图片同步；产品验收需要维护者确认 |
| 响应/缓存预算具体值 | 当前 24 MiB、10分钟、256 MiB 为候选；B04/B08 在资源实测后写回配置和文档 |
| D9–D13 建议决策 | 保留建议状态；涉及删除公开调试面的选择由协调者确认，不把沉默当确认 |
| 类型落地/manifest/基线适配 | B01 完成真实接口及最小消费者调整、检查通过后才进入并行实现 |

## 13. 配置与交付

B08 独占 env.ts/.env.example/根依赖配置；各任务提交配置 schema，由 B08 串行落地。

| 配置 | 语义提供者 |
| --- | --- |
| SOLARIS_PUBLIC_ORIGIN / SOLARIS_TRUST_PROXY / PORT / SOLARIS_DATA_DIR | B08：明确公网 HTTPS origin、可信代理、独占数据目录 |
| CREDENTIALS_MASTER_KEY | B03：base64 32 字节，保留 vault 格式 |
| SOLARIS_AUTH_ADAPTER / SOLARIS_CREDENTIAL_SOURCE | B03：首期 oidc/user-key，封闭注册验证，配置错误拒绝启动 |
| SOLARIS_OIDC_ISSUER / SOLARIS_OIDC_CLIENT_ID / SOLARIS_OIDC_CLIENT_SECRET / SOLARIS_OIDC_SCOPES | B03：Server 自身上游 OIDC 客户端；桌面无密钥，openid scope 必需 |
| SOLARIS_SESSION_TTL_SECONDS / SOLARIS_DESKTOP_REDIRECT_ALLOWLIST | B03：会话寿命与精确回环解析 |
| SOLARIS_UPSTREAM_TIMEOUT_MS / SOLARIS_UPSTREAM_RESPONSE_MAX_BYTES / SOLARIS_IMAGE_RESULT_MAX_BYTES | B04：完整 deadline 与原始响应/解码预算 |
| SOLARIS_RESULT_CACHE_TTL_SECONDS / SOLARIS_RESULT_CACHE_MAX_BYTES | B05：有界内存重放 |

OIDC 配置只在所选认证适配器为 oidc 时要求；内部适配器提供自己的 schema，不能强迫所有部署配置 OIDC。缺必需配置拒绝启动，无静默退回其他认证/Key/模型服务。公开示例只含占位符，不含内部实例域名或秘密。
