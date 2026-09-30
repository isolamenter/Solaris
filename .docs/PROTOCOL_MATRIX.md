# B00 — 上游协议矩阵

日期：2026-09-29
范围：B00 任务「记录上游真实协议矩阵」。本文件只记录可引用的协议事实与证据来源。

## 证据等级

本文件所有结论按以下等级标注，缺证据的列一律写「待验证」：

| 标记 | 含义 |
| --- | --- |
| 文档 | 有权威协议文档明文支持，已附 URL |
| 代码 | 由本仓库代码/测试固定，可复现 |
| 待验证 | 无第一手证据；或仅由「文档中没有」反推 |
| 冲突 | 同一事实在不同文档页之间互相矛盾 |
| 实测记录 | 前次授权调用记录；仅限所测实例、时间、账号/模型和请求格式，本轮未重测 |

本矩阵包含文档调查、代码证据及 §4 的前次真实调用记录。本轮仅核对文档，不发起新的收费请求。§2/§3 是历史协议调查；未附具体来源或未复核的项不视为冻结依据，需使用时重新核实。

---

## 1. 当前设计输入与历史资料

- D5/D15 已删除视频与 Batch；不再消费 Batch 提交、取消、JSONL、结果保留期等历史调查。
- D4 沿用 Gemini generateContent 协议。§4 只验证了所测 NewAPI 实例的单次路径；不代表直连公开环境已完成真实调用验收。
- 所测网关模型列表缺少能力元数据，运行能力依赖精确适配表。名称过滤不能单独证明可运行。
- outputCount 的截断来自仓库代码；保留控件还是移除待确认，不保证输出张数。
- 网络异常不构成生成自动重试的理由；未知受理状态保留 uncertain。

§2/§3 的 Batch 行是删除范围前的历史资料，不视为当前已验证结论。尤其“没有文档”不等于“不支持”，不同输出模式、模型和版本可能有差异。恢复相关需求时，重新取得逐项权威来源并验证，不直接据这些旧表实施。

---

## 2. Gemini（Generative Language API）

### 2.1 单次图片生成与编辑

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 模型发现 | 部分 | `GET /v1beta/models`，`pageSize` 默认 50、上限 1000。**没有机器可读的「是否支持 Batch」标志**（文档） |
| 单次生成 | 文档 | 当前官方示例使用 `POST /v1beta/interactions`，body 为扁平结构 `{model, input:[{type:"text",...}]}`，结果读 `interaction.output_image.data`（[Google 图片生成文档](https://ai.google.dev/gemini-api/docs/image-generation)；本轮已核对示例，不能据此认定 generateContent 已失效） |
| 图片编辑 | 文档 | 同一 endpoint，在 `input` 中追加 `{"type":"image","mime_type":...,"data":"<base64>"}`（文档） |
| 现有代码路径 | 代码 | 仓库用 `POST /v1beta/models/{model}:generateContent` + `contents/parts` + `generationConfig.imageConfig`（`gemini.ts:16`、`geminiAdapter.ts:107`）。**与文档主路径不同**，见 §5 待验证项 |
| 输出张数 | 代码/待确认 | 不从另一协议的参数表外推所有模型。仓库用 `outputCount` 截断返回的多张图（`geminiAdapter.ts:34`、`gemini.ts:16`）——这是 Solaris 自己的截断语义，不是上游参数 |
| 结果载体 | 部分 | 默认内联 base64（`output_image.data`）。Schema 另有 `ImageResponseFormat.delivery: "inline" \| "uri"`，但 `uri` 的宿主、URL 形状与有效期**均无文档**（待验证） |
| 附件上传 | 是 | 内联 base64 或 Files API；Files API 单文件上限 2GB、项目 20GB，**上传文件 48 小时自动删除**，且用户上传的文件不可回读（文档） |

### 2.2 Batch

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 提交 | 是 | `POST /v1beta/models/{model}:batchGenerateContent`。内联模式 `input_config.requests.requests[]`，总请求体 < 20MB；文件模式走 Files API 上传 JSONL（上限 2GB）+ `input_config.file_name`（文档） |
| 图片 Batch 请求形状 | 是 | **仍用 `generateContent` 形状**：`request.contents[].parts[]` + `generation_config.responseModalities`，不是 Interactions schema（文档） |
| 状态轮询 | 是 | `GET /v1beta/batches/{id}`。状态枚举两处拼写不一致：REST 参考的 `BatchState` 与指南示例写法不同（**冲突**，需实测确认） |
| 取消 | 部分 | `POST /v1beta/batches/{id}:cancel`，只保证「停止处理新请求」；**不返回同步确认**，需重新轮询看 `JOB_STATE_CANCELLED`（文档） |
| 幂等 | **否** | 「Submit jobs once: The creation of a batch job is not idempotent.」无幂等键、无请求 ID、无去重窗口。JSONL 的 `key` 仅用于输出配对（文档） |
| 逐条结果 | **否** | 无逐条读取 endpoint。文档给出的「提前拿到部分结果」办法是**把大 Batch 拆成小 Batch**（文档） |
| 部分成功 | 是 | 结果 JSONL 中可同时存在成功行与 `{"error": ...}` 行，`JOB_STATE_SUCCEEDED` 的任务仍可能含逐条失败（文档） |
| 结果传输 | 是 | 整份文件：`GET /download/v1beta/{responsesFile}:download?alt=media`；或内联模式的 `output.inlinedResponses[]`（文档） |
| 结果保留 | 是 | 结果**6 周**后永久删除（文档） |
| 任务过期 | 是 | 任务 pending/running 超过 **48 小时** → `JOB_STATE_EXPIRED`，**无结果可取**（文档） |
| 输入文件保留 | 是 | Files API 上传文件 **48 小时**自动删除（文档） |
| 删除语义 | 冲突 | Files 页称上传文件 48 小时删除且未为 batch 输出开口；Batch 页称结果保留 6 周。**batch 输出 JSONL 适用哪条规则未验证**（冲突，见 §5） |

---

## 3. OpenAI（Images API + Batch API）

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 模型发现 | 部分 | `GET /v1/models` 返回的 model 对象**只有** `id/object/created/owned_by/shutdown_date`，**不带图片能力元数据**（文档） |
| 单次生成 | 是 | `POST /v1/images/generations`，JSON body，`prompt` 必填（文档） |
| 图片编辑 | 是 | `POST /v1/images/edits`，multipart/form-data，`image`（单文件或数组）+ `prompt` 必填（文档） |
| 结果载体 | 部分 | `response_format` 只接受 `"url" \| "b64_json"`，且**只对 dall-e-2/dall-e-3 文档化**；GPT image 模型总是返回 `b64_json`（文档） |
| 附件上传 | 是 | `POST /v1/files`，`purpose` 必填；Batch 输入用 `purpose=batch`（文档） |
| Batch 支持图片 | 是 | `POST /v1/batches` 的 `endpoint` 允许值**明确包含** `/v1/images/generations` 与 `/v1/images/edits`（文档） |
| Batch 提交 | 是 | `input_file_id` + `completion_window`（**只支持 `"24h"`**）+ 可选 `output_expires_after`（文档） |
| 状态轮询 | 是 | `GET /v1/batches/{id}`：`validating` / `in_progress` / `finalizing` / `completed` / `failed` / `expired` / `cancelling` / `cancelled`（文档） |
| 取消 | 是 | `POST /v1/batches/{id}/cancel`：进入 `cancelling`，**保持到在途请求完成（最多 10 分钟）**再变 `cancelled`（文档） |
| 幂等 | 待验证 | Batch 参考**未记录**幂等键或去重；重复 create 即新 Batch。通用 `Idempotency-Key` 是否适用于 batch create **无第一方确认**（待验证） |
| 逐条结果 | **否** | 无任何渐进式/逐条读取文档；只有终态 `completed` 后取 `output_file_id`（文档） |
| 结果传输 | 是 | `GET /v1/files/{file_id}/content` 返回原始 JSONL。**行序不保证与输入一致**，按 `custom_id` 配对（文档） |
| 结果保留 | 是 | 输出文件在 Batch 完成后 **30 天**自动删除；`output_expires_after` 可调（锚点是输出文件创建时间，范围 3600–2592000 秒）（文档） |
| 超时过期 | 是 | 24 小时内未完成 → `expired`，未完成请求以 `batch_expired` 写入 error file；**已完成部分仍计费**（文档） |
| DALL-E URL 过期 | 是 | `response_format=url` 的结果 URL 约 **60 分钟**过期 → 延迟取结果会丢图，故 Batch 行应带 `b64_json`（文档） |

---

## 4. NewAPI 网关（实测，2026-09-29 对 `newapi.rosecrab.com` 真实调用）

> 本节为**真实调用证据**，不再是文档推断。调用经维护者授权，未提交计费型 Batch（网关不支持）。

| 端点 | 结果 | 说明 |
| --- | --- | --- |
| `GET /v1beta/models` | **200 ✅** | 返回 26 个模型；`supportedGenerationMethods` **对全部 26 个模型均为 `null`** |
| `POST /v1beta/models/{m}:generateContent` | **200 ✅** | 单次图片生成可用：841KB PNG，9.1 秒 |
| `POST /v1beta/models/{m}:batchGenerateContent` | **500 ❌** | `new_api_error` / `invalid_request`：`"contents is required"`。网关把未知的 `:batchGenerateContent` 落到自己的通用处理分支 |
| `GET /v1beta/batches` | **404 ❌** | `Invalid URL` |
| `POST /v1/batches`（OpenAI 形态） | **404 ❌** | `Invalid URL` |
| `GET /v1/batches`（OpenAI 形态） | **404 ❌** | `Invalid URL` |
| `POST /v1beta/files`（Gemini File API） | **404 ❌** | `Invalid URL` |
| `POST /v1beta/interactions` | **404 ❌** | `Invalid URL` |
| 视频模型（`veo`） | **不存在** | 26 个模型中无任何视频模型 |

### 实测结论

1. **本实例此次探测确认模型列表与单次生成可用；表中所试的 Batch、File API 与 Interactions 请求未可用。** 404/500 不是对所有版本、模型、请求形状或账号权限的完整能力证明。
2. **当前没有可供本项目使用的已验证 Batch 链路**。B09 若使用同一实例，应参考此记录；其他 NewAPI 实例或升级后需独立验证。
3. **能力元数据缺失**：`supportedGenerationMethods` 全为 `null`，所以 `adaptGeminiModels`（`geminiAdapter.ts:73-87`）的 method 分支从不生效，能力推断**完全退化为模型名正则**（`isImageModel`/`isVideoModel`）。这与大纲 §6「不从模型名称或协议标签推断能力」直接冲突——实际是**精选白名单**（`geminiImageModelAliases`）决定可用性，模型名正则只做候选过滤。契约必须如实描述这一点。
4. **模型会漂移**：DB（2026-07-17）发现 4 个图片模型，网关现只剩 3 个（`gemini-2.5-flash-image` 已消失），且均为 `-preview` 后缀。
5. 网关连接**不稳定**：多轮探测中出现 `ECONNRESET` 与 `ConnectTimeoutError`，同一提交有时首次失败。只读模型查询可有界重试；生成提交应按接受结果分类，未知结果不得自动重提。

### 网关与上游文档的差异（不得混同）

网关**不提供**保留期承诺、不保证代理上游全部端点、也不转发能力元数据。**网关行为不等于上游厂商契约**；任何「经网关可用」的能力都必须对该部署实例实测。


---

## 5. 待验证项状态

| # | 待验证项 | 状态 | 结论 |
| --- | --- | --- | --- |
| V1 | 结果是否只能整份取，没有逐条 endpoint | 文档 | 历史调查未记录逐条 endpoint，未逐项重新核实；**但 Batch 已被 D15 删除，本项不再阻塞** |
| V2 | batch 输出适用 48 小时还是 6 周规则 | **已作废** | D15 删除 Batch 后无消费者 |
| V3 | 仓库现有 `:generateContent` 单次图片路径是否仍受支持 | ✅ **已实测确认** | 所测实例 200 + 841KB PNG。支持 D4 沿用；不能外推所有上游路径 |
| V4 | Gemini 状态枚举真实拼写 | **已作废** | D15 删除 Batch 后无消费者 |
| V5 | 两端 Batch 幂等结论 | **已作废** | 历史调查作废；不再作为当前实现要求 |
| V6 | 实际网关是否暴露 batch | ✅ **所试请求未验证可用** | 见 §4；D15 是维护者的范围选择，不是所有 NewAPI 的能力结论 |
| V7 | 单次图片的 `outputCount` 是 Solaris 侧截断 | **仍待确认** | 上游无 count 参数；Solaris 截断返回的多张图，需确认截断控件语义，不保证生成张数 |
| V8 | 能力推断实际依赖精选白名单而非元数据（新增） | ✅ **已实测确认** | `supportedGenerationMethods` 全 `null`；见 §4 结论 3 |

**V3、V6 已用真实调用厘清，V2/V4/V5 随 D15 删除 Batch 而作废。** 剩余 V7 是语义确认（不是协议未知），V8 是必须如实写入契约的事实。


---

## 6. 与仓库现状的差异

| 项 | 仓库现状 | 上游文档 | 处理 |
| --- | --- | --- | --- |
| 单次图片路径 | `:generateContent` + `imageConfig`（代码） | `/v1beta/interactions` 为主路径（文档） | D4 沿用；V3 在所测实例已实测，直连公开部署仍需独立验收 |
| Batch 请求形状 | `geminiBatchRequest` 用 `contents/parts`（代码） | 图片 Batch 仍用 `generateContent` 形状（文档） | 历史记录；随 D15 删除，不作为当前改造任务 |
| `outputCount` | 截断上游返回的多张图（代码） | 上游无 count 参数（文档） | 语义是 Solaris 侧的截断，截断已由代码证实；控件/字段如何表达待确认 |
| `retiredPreviewWarning` | 硬编码「Google retired this preview ID on June 25, 2026」（`geminiAdapter.ts:22`） | **无引用来源** | 待验证；无来源的上游事实不应写入契约 |
| 预览版模型 ID | 别名表含 `-preview` 后缀（代码） | 厂商模型与网关别名不保证一致 | §4 所测实例有 preview 别名，不能直接视为官方模型 ID |
