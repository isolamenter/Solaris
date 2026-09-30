# B00 — 范围与实施决策

日期：2026-09-29
状态：**范围决策已确认，实施契约仍为候选**。D1–D8 由维护者于 2026-09-29 确认；**D15（删除 Batch）于同日真实调用验证后追加确认**；D9–D13 为待确认建议；D14 随范围变化作废。本次文档同步不把建议标为维护者已确认。
上游协议事实见 [PROTOCOL_MATRIX.md](PROTOCOL_MATRIX.md)。基线：[REFACTOR_OUTLINE.md](REFACTOR_OUTLINE.md)。

> 仅 B00 已确认的决策可解除 B01 的阻塞。**本文件不构成代码、提交、部署或发布授权。**
>
> ⚠️ **D5 + D15 共同把本次重构的范围收缩为「纯同步单次图片生成」**：视频与 Batch 都删除后，Solaris 不再提供上游异步生成操作；同步请求仍需认领、在途状态和未知结果收敛。务必先读 §7 的范围影响。

---

## 1. 已确认决策

| # | 实际使用场景 | 候选 | 证据 | 建议 | **维护者结论** | 确认日期 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 桌面运行时与首期平台 | Tauri v2+React / Electron / 纯 Web 先行 | 现有栈为 React 19 + Vite 7 + strict TS；大纲 §4 列 Tauri 为候选但「尚未最终确定」 | Tauri v2 + React，macOS 先行 | **Tauri v2 + React，macOS 先行**（Windows 抽象留在接口层，首期不实测） | 2026-09-29 |
| D2 | 首期公开认证协议与回调方式 | OIDC+PKCE 回环监听 / OIDC+PKCE 深链 / 暂不实现 | 大纲 §5.1 建议先评估标准 OIDC；`BACKLOG_03:9` 禁止未确认时自行实现 | OIDC + PKCE，回环监听回调 | **OIDC + PKCE，回环监听回调**（系统浏览器授权，本地 `127.0.0.1:随机端口` 收码，无内置客户端密钥） | 2026-09-29 |
| D3 | 首期公开凭证来源 | 部署者配置＋授权用户 / 用户录入按用户保存 / 外部凭证服务 | 大纲 §5.2 三候选；`BACKLOG_03` 要求「登录成功不能自动使用任意模型连接」；现有 UI 已有 Key 录入路径 | 用户录入，按用户+连接加密保存 | **用户录入自己的 Key，按用户+连接加密保存**（API 只回 `hasKey`；与内部 SSO 配套发 Key 同形，后续只换来源） | 2026-09-29 |
| D4 | 首期公开模型适配器 | Gemini 迁移 Interactions / Gemini 沿用现有 / OpenAI 兼容形态 | **已实测**：仓库现有 `:generateContent` 路径经网关返回 200 + 841KB PNG（PROTOCOL_MATRIX §4）。网关对 `/v1beta/interactions` 返回 404，迁移路径在本部署下不可用 | 沿用现有 Gemini 适配器 | **Gemini，沿用现有 `:generateContent` 适配器**（V3 已实测确认；Batch 部分随 D15 删除） | 2026-09-29 |
| D5 | 视频生成是否在范围内 | 移除 / 保留移植 / 保留同步 | 大纲 §11 列为待确认；视频与 Batch 的异步状态机增加当前实现复杂度，且只有测试替身、无真实调用证据 | 本期移除 | **本期移除视频**（操作/能力类型去掉 `videoGenerate`，删 `VideoRunner`、`jobs` 表与异步任务机） | 2026-09-29 |
| D6 | 跨设备是否可见远程任务列表 | Server 按用户列表 / 只按 ID 取 | 大纲 §8 建议可见但「尚需产品确认」 | Server 提供按用户列表 | **Server 提供按用户的任务列表**（D15 后语义收窄为**单次生成的运行历史**，不再有 Batch 条目列表） | 2026-09-29 |
| D7 | 现有本机数据是否迁移 | 不迁移 / 迁移历史与图片 | `.solaris-data/` 有 4.5MB sqlite + 6 个 asset 文件；现有 schema **无任何 owner 列**，且只有 `CREATE TABLE IF NOT EXISTS` | 不迁移 | **不迁移，本地库视为可丢弃**（B02 在新空数据目录创建 schema，无需迁移工具；不自动删除旧数据） | 2026-09-29 |
| D8 | 推进方式 | 分波次汇报 / 一路到 B08 / 只冻结契约 | `BACKLOG_README` 依赖表；本 backlog 不构成发布授权 | 分波次汇报 | **分波次，每波结束汇报证据与剩余风险** | 2026-09-29 |
| D15 | 图片 Batch 是否保留 | 直连 Gemini 专管 Batch / 保留契约仅 fixture 验证 / Solaris 侧队列 / 换上游 / **删除** | **实测**：配置的网关对 `:batchGenerateContent` 返回 500、对 `/v1beta/batches`、`/v1/batches`、`/v1beta/files`、`/v1beta/interactions` 全部 404——**所探测 Batch 端点未可用**（仅限该实例与此次请求，PROTOCOL_MATRIX §4）。DB 中唯一的 batch 记录是 `draft`/0 条目，从未真实提交过 | 所测部署未验证可用 Batch 链路；维护者主动选择删除，不从该实例外推所有开源部署 | **删除 Batch 功能** | 2026-09-29 |

---

## 2. 建议决策（待确认）

以下项维护者未逐条确认。B01 可以形成实施候选，但不能把建议当成批准；影响执行的项需在冻结前明确。D14 已作废，不再需要确认。

| # | 场景 | 建议 | 依据 |
| --- | --- | --- | --- |
| D9 | Server 进程模型 | **单进程 + SQLite**。不实现多 worker 租约；`jobs` 表随 D5 删除，`batch_*` 表随 D15 删除 | 异步操作已全部删除，lease 列失去唯一消费者；大纲未提多 worker；实现尽量简洁 |
| D10 | 错误码是否作为公开契约 | **冻结一个精简公开错误码表**，其余内部错误统一 `INTERNAL`（不返回原始 message） | 现为 39 个 `AppError` 码及若干持久化码（历史调查计数，冻结时重新核对），客户端解析 `.code` 但**从不分支**；`INTERNAL` 直接回原始 message 在公开端点会泄漏内部信息。Batch/视频专属码随删除移除；单次生成仍需明确失败/未知分类 |
| D11 | 调试面（`/runs/:id/curl`、inspector、batch JSONL 预览） | **对普通远程用户全部移除**；如需保留仅限运维。JSONL 预览随 D15 一并删除 | `curlFor` 回显上游 baseUrl 与完整请求体；inspector 已实测落库 2.2MB 参考图 base64（见 §3.3） |
| D12 | `ConversationDto`/`MessageDto`/`ApiError` | **删除**。无 `/api/conversations` 路由，`ApiError` 从未被 import，却暗示存在不存在的 API | 代码验证：两 DTO 与一个类型不可达 |
| D13 | 批注 `retiredPreviewWarning` 等无来源上游事实 | **从契约与 UI 中移除**，或补上引用来源 | `geminiAdapter.ts:22` 硬编码「Google retired this preview ID on June 25, 2026」，仓库内无任何来源 |
| D14 | ~~取消语义：意图与上游确认分离~~ | **已作废** | 原为 B05 任务 7 明文要求；但 D5 + D15 删除全部异步操作后，**已无任何可取消的操作** |

---

## 3. 现有代码调查结论

### 3.1 可复用

| 模块 | 为什么保留 |
| --- | --- |
| `ProviderPlugin` 接口与 Gemini 适配器 | B01 明确「沿用当前 ProviderPlugin，不创建动态插件系统」；插件只消费已解析凭证的 `ProviderProfile`，凭证归属在更上层变化 |
| `vault.ts` AES-256-GCM 格式（`v1.iv.tag.ciphertext`） | `AGENTS.md:48` 把格式定为不变量；但 AAD 绑定需从 profile id 扩到「用户+连接」（D3） |
| `errors.ts` → canonical `{ error: { code, message, details? } }` | 唯一的错误归一化点，与传输方式无关 |
| repository 的 DTO 映射与「派生字段不持久化」规则 | `AGENTS.md:38` 的正确性不变量，跨 Client/Server 拆分依然成立 |
| `api<T>()` envelope 解码与 `ApiClientError` | 传输形状测试，注入 base URL 与认证头后仍成立 |
| `assets.ts` 的内容寻址（sha256 去重）**作为客户端**落盘方案 | 内容寻址与用户/设备无关，正是 B01 要的「规范化内容摘要」；Server 侧持久化则删除 |
| 参数 `zod` strict schema（`geminiAdapter.ts:36-44`） | B04 保留；不支持参数在调用前失败 |

### 3.2 必须替换的本机假设

| 假设 | 证据 | 处理 |
| --- | --- | --- |
| Client 与 API 同源，所有请求用相对 URL | `client/api.ts:12-26` 全部为相对字面量 | 显式 Server base URL；Server 素材库删除；统一生成响应交付字节，本地路径归 Client |
| 无认证，请求不带身份 | `client/api.ts:7` 只设 content-type；`db/schema.ts` 无任何 user/session 表或 owner 列 | D2/D3；每个 repository 查询都要带身份 |
| Host 必须是 loopback | `http/security.ts:4-8`，`app.ts:59` 全请求挂钩，`main.ts:15` 硬编码绑定 | B08 在远程 Host/来源、代理信任与认证保护验收后替换，不能只靠认证删除保护 |
| 写请求 Origin 必须精确等于 `http://127.0.0.1:<port>` | `http/security.ts:9-13`，`app.ts:60` | 替换为显式远程拓扑边界（B08） |
| Server 持久化图片 | `assets.ts` 写 `dataDir/assets/`；`services.ts:56,202` 保存生成图 | 删除；Server 只做临时有界转发 |

### 3.3 已实测确认的缺陷

以下三项**已在本次调查中复现**，不是推断。**缺陷 2、3 的处置见 §7**（随 D5/D15 删除代码而消失），缺陷 1 仍需修复：

1. **参考图 base64 落库（隐私泄漏）**
   `redact()`（`vault.ts:38`）只替换匹配 `/key|authorization|token|secret/i` 的**键名**，而 `geminiParts` 的 `inlineData.data` 键名为 `data`，不匹配。`services.ts:56` 与 `:134` 把 `redact(result.inspector)` 持久化到 `runs.inspector_json` / `batch_jobs.inspector_json`。
   实测输出：`reference-image base64 survives redact(): true`。
   违反大纲 §2.2「日志、请求检查记录及错误信息也不得保存图片内容或凭证」与 B05「不能泄露 Key、base64 图片」。

2. **Batch 结果在临时下载失败时永久丢失**
   `services.ts:165` 先把状态写成 `succeeded`，`:171` 才 `download()`。若下载抛错，`runner.ts:33` 吞掉异常，而 `dueBatchJobs()`（`repository.ts:148`）只选 `submitting`/`running`——任务永远停在 `succeeded` 且零结果。
   更糟的是 `submitting` 且 `remoteId` 为空时：`processBatchJob`（`services.ts:162`）抛 `BATCH_NOT_SUBMITTED` → 被吞 → 每 2 秒空转，永不终止。
   违反原讨论稿（D15 前）§7.2「远程执行完成与结果可下载分别处理」。

3. **`uncertain` 未按约定生效**
   `runner.ts:26` 仅当 `safe.code === "PROVIDER_UNAVAILABLE"` 时才记 `uncertain`。上游返回 500（`PROVIDER_HTTP`）会被记成**确定失败** `error`。
   违反 `AGENTS.md:57`「an unknown video-submission outcome must not be automatically resubmitted」的语义——现有实现把「未知」误报为「失败」。

### 3.4 其他已确认事实

- **无任何迁移机制**：schema 只有 `CREATE TABLE IF NOT EXISTS`，无版本号和既有版本迁移流程；SQLite 支持 ALTER，不能从没有迁移代码推断不能变更表。D7 选择不迁移后此项不再阻塞。
- **Drizzle schema 与真实 DDL 已漂移**：三个 UNIQUE 约束只存在于原生 `CREATE TABLE` 文本中，`schema.ts` 未声明 → 直接依据未同步的 Drizzle schema 生成迁移存在遗漏约束风险，尚未实测实际迁移结果。
- **`foreign_keys=ON` 但零外键**：无任何表声明 `FOREIGN KEY`，引用完整性全靠手写且已不完整。
- **`repository.ts:81` 映射错误**：`batchEntryDto` 把 `row.id` 写进 `modelId` 字段。
- **错误码**：39 个 `AppError` 码 + 5 个仅持久化的码（`SUBMISSION_UNKNOWN`/`VIDEO_FAILED`/`BATCH_FAILED`/`BATCH_ENTRY_FAILED`/`NO_INLINE_IMAGE`）。客户端从不分支于 `.code`。
- **`e2e/` 与 `scripts/smoke.ts` 归 B08**（`BACKLOG_08:5` 明文），断言 loopback 边界，需随 D2 一并重写。

---

## 4. 基线状态（2026-09-29 实测）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm test` | **27/28**，1 个过期断言（见下） |

- **环境问题（已修）**：`better-sqlite3` 原生模块编译于 Node 20（`NODE_MODULE_VERSION 115`），本机为 Node v26.7.0（`147`）。执行 `npm rebuild better-sqlite3` 后 8 个环境失败降为 1 个真实失败。`AGENTS.md` 只写「Node 20.19 or newer」，未固定上限。
- **既有测试缺陷**：`services.image.test.ts:33` 断言 Gemini flash 参数列表为 `["aspectRatio","imageSize","thinkingLevel","googleSearch"]`，但 `geminiAdapter.ts:49` 已加入 `outputCount`（commit `d1b8ce4`）。**是测试过期，不是代码错误。**

---

## 5. 验证结果（2026-09-29 真实调用）

维护者授权后对 `newapi.rosecrab.com` 发起真实调用（未提交计费型 Batch——网关不支持）。完整结果见 PROTOCOL_MATRIX §4。

| # | 项 | 结果 |
| --- | --- | --- |
| V3 | 现有 `:generateContent` 单次图片路径 | ✅ **仍受支持**：200 + 841KB PNG，9.1 秒 |
| V6 | 网关是否暴露 Batch | ✅ **所测实例/请求未验证可用**：`:batchGenerateContent` → 500；`/v1beta/batches`、`/v1/batches`、`/v1beta/files`、`/v1beta/interactions` 全部 404 |
| V8 | 能力元数据是否可用 | ✅ **确认缺失**：26 个模型的 `supportedGenerationMethods` **全为 `null`** → 能力推断退化为模型名正则，与大纲 §6「不从模型名称推断能力」冲突；实际由精选白名单决定 |
| — | 模型漂移 | ⚠️ `gemini-2.5-flash-image` 已从网关消失；现仅 3 个 `-preview` 图片模型 |
| — | 视频模型 | ⚠️ 网关**无任何 `veo`**，进一步支持 D5 |
| — | 网关稳定性 | ⚠️ 多轮探测出现 `ECONNRESET` 与 `ConnectTimeoutError`；查询可有界重试；生成已发送但结果不明不得自动重提 |
| V1/V2/V4/V5 | 逐条结果 / 保留期 / 状态枚举 / 幂等 | **已作废**：随 D15 删除 Batch 而无消费者 |
| V7 | 单次图片 `outputCount` 为 Solaris 侧截断 | 仍待确认保留、改为“最多保留 N 张”或移除；不能保证生成张数 |

---

## 6. B00 验收对照

| 验收项 | 状态 |
| --- | --- |
| 每个实现阻塞点有明确结论，或标明哪些仍不能开工 | ✅ §1 已确认 9 项；V7 及跨设备只看元数据是未决产品语义，B01 可起草候选，但相关部分不能宣布冻结 |
| 最小公开部署不依赖内部域名、SSO 专有 Key 接口或 NewAPI | ✅ D2 OIDC + D3 用户录入 Key + D4 Gemini 协议，均为公开能力 |
| 首期至少有一个实际可验证的图片 Batch 服务选择 | ⚪ **由 D15 作废**：维护者决定删除 Batch 功能，该验收项不再适用（原为「未满足」，现改为「范围取消」） |
| 将确认结果交给 B01 和协调者；内部协议未确认时 B09 保持待开始 | ✅ 本文件即交接；B09 保持待开始，且 **所测 NewAPI 实例未验证 Batch 可用**已是 B09 的已知输入 |

---

## 7. D5 + D15 的范围影响（必读）

删除视频与 Batch 后，**Solaris 不再有任何异步操作**。以下现有模块与 backlog 条目**整体作废或删除**：

| 对象 | 处理 |
| --- | --- |
| `src/server/runner.ts` + `runner.test.ts` | **删除**（唯一职责是视频与 Batch 轮询） |
| `jobs` 表、`lease_token`/`lease_expires_at`、`attempts`、`next_poll_at` | 删除 |
| `batch_jobs` / `batch_entries` 表与全部 repository 方法 | 删除 |
| `BatchJobDto`/`BatchEntryDto`/`BatchJobStatus`（contracts.ts） | 删除 |
| `ProviderPlugin.operations.batchGenerate`、`BatchSubmitInput`/`BatchPollResult`/`BatchEntryResult`/`BatchInlineRequest`（types.ts） | 删除 |
| `services.ts` 的 batch 方法与 `processBatchJob`/`materializeBatchResults` | 删除 |
| `gemini.ts` 的 `batchGenerate` 实现、`geminiBatchRequest` | 删除 |
| `app.ts` 的 batch 路由 + JSONL 预览 | 删除 |
| Client `Batches` 页面与相关 api 函数 | 删除 |
| `services.batch.test.ts`、`geminiBatch.test.ts` | 删除 |
| 大纲 §7 | 已替换为单次生成幂等与结果取回限制 |
| backlog B05 | 已同步为「单次生成编排」，依赖 B01 冻结及 B02/B03/B04 |
| backlog B01 的 Batch/取消条目 | 删除；单次生成的结果传输与幂等仍保留 |
| backlog B00 验收第 3 条 | 作废（见 §6） |

**已实测缺陷的处置变化**：§3.3 的缺陷 2（Batch 结果丢失）与缺陷 3（`uncertain` 误报）**在旧异步路径中的缺陷随删除消失，不修复旧路径；新的同步生成仍必须实现明确失败/未知分类**；缺陷 1（参考图 base64 落库）**仍然存在且必须修复**——单次生成路径同样落库。

**范围同步**：大纲与 backlog 已按 D5/D15 更新。删除 Batch 是维护者主动收缩产品范围，不代表所有模型服务或 NewAPI 部署都不支持 Batch。以后恢复此需求需重新确认使用方式、选择并验证上游，不保留占位或旧分支。

## 8. 本轮契约修订与待确认事项

- CONTRACTS v3 为实施候选，不代表代码接口已落地或基线已经冻结；各任务依赖见 INTEGRATION_MANIFEST。
- 统一 GenerationResponseDto，显式区分远程状态、本次交付与本机保存。短期内存缓存是尽力重放，不保证 App/Server 重启后取图。
- 认证与凭证来源接口独立，公开 OIDC/用户 Key 与内部集成可替换；不把 OIDC 字段硬编码进 Client 的业务流程。
- 本地草稿与文件记录按 Server origin + Solaris 用户隔离，补齐 LocalStore 方法与记录类型。
- 完整调用超时包括响应体读取和解码；回收跳过本进程活跃运行，不自动重提未知生成。
- 删除历史保留最小去重凭据；旧 schema 拒绝自动打开并提示新数据目录，不自动删除旧库或图片。D7 不迁移的结论不变。
- 待确认：outputCount 仅截断的产品语义、跨设备只看元数据是否接受、D9–D13 建议项；响应和缓存预算由 B04/B08 测量。
- 本文件中的真实调用、基线测试和缺陷复现来自前次调查记录。本轮只读代码核对与文档修订，没有重新调用网关或重跑应用测试。
