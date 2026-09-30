# B04 — Gemini 单次协议与模型能力

状态：**已完成（2026-09-29）**，见文末验证记录。
依赖：B01；与 B02/B03/B06 并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

src/server/providers/ 实现/注册/测试，排除 B01 的 types.ts。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 按 D4 沿用 generateContent 单次生成/参考图编辑；删除视频、Batch、文件上传与相关测试，不做 Interactions 双路径。
- [x] 按精确适配表暴露模型/参数，缺能力禁用；手动模型保留，模型正则仅候选过滤。
- [x] 实现完整 deadline，覆盖发送、body 读取、解析、解码；调用者 signal 不绕过 deadline。
- [x] 限制原始响应与图片解码总预算，明确返回尺寸/MIME 校验；不要读完无限响应后才检查大小。
- [x] 结构化区分明确拒绝和 unknown，generation POST 不自动重提；模型发现只读请求可有界重试。
- [x] HTTPS/URL/重定向出站校验与安全 diagnostics 白名单，禁止把 request/response/base64 或 Key 打入日志。
- [x] outputCount 行为仅按维护者结论落地；未确认前不宣称张数保证、不用重复生成凑数。候选预算与 B08 实测协商。

## 验收与交接

- [x] 能力缺失/未知参数在上游前失败；慢 body 超时、超大响应、网络未知结果有测试。
- [x] 图片不落 Server；diagnostics 只含安全字段，provider error 不含原始秘密。
- [x] 记录网关 fixture 与直连真实协议验收差距，不把一个实例成功当成公开部署已实测。

验证：focused provider tests → typecheck → lint；真实收费调用须实际授权。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

- `npx tsc --noEmit` → 0 错误；`npx eslint .` → 通过；`npx vitest run` → 111 passed

**发现并修复的缺陷（其中 3 条源自 B01 的基线适配）：**

1. **上游响应体会被拼进对外错误消息**（`response.text.slice(0, 200)`），而该消息会被 B05 持久化进 `RunDto.error.message` 并回给客户端——网关错误常回显请求行，其中带 `?key=<secret>`。这是 B01 引入的。修：消息改为 Solaris 自撰 + 仅状态码。
2. **返回图片只要 `data` 非空就接受**，`mimeType` 缺失时回落 `image/png`，导致非图片字节可作为图片交付与落盘。同源 B01。
3. **`configuredModel` 把适配器的 `message` 展开进 DTO，而字段名是 `availabilityMessage`**，被静默丢弃，使「模型为何不可用」的说明在服务端与客户端都退回默认文案。同源 B01。
4. 停滞的 body 未由 Solaris 自身限时（依赖运行时对中止流的处理）→ 每次 `read()` 与 signal 竞争。
5. 重定向被隐式跟随（默认 `redirect: "follow"`）→ 改为 `redirect: "manual"`，任何 3xx 视为 `unknown` 且不重投。
6. 裸 `JSON.parse` 失败以 SyntaxError 逃逸 → 变成通用 500，而非确定的运行错误。
7. 死代码 `redactPath` 移除。

**已验证 vs 仅 fixture**：只有 `redirect: "manual"` 的运行时形状与 abort 传播在本机真实 Node v26.7.0 + 真实 `fetch` 上验证过（一次性探针，未提交）。**其余全部为 fixture**：未发起任何真实/计费上游调用。网关行为取自 PROTOCOL_MATRIX §4 的既有记录，未重测。发现重试与 MIME 规则**未对真实网关验证**。

**遗留风险**：严格结果 MIME（`image/png|jpeg|webp`）——**缺失 MIME 现在会判为 `UPSTREAM_NO_IMAGE`**，而既有探针只记录了「841KB PNG」、未记录该字段是否存在；**若真实网关省略该字段，原本可用的生成会失败**，这必须由 B08/B09 的真实验收确认。另：未加独立的解码期预算（若把原始预算配到 > 4/3 × 24 MiB，可能先materialise 一个 >24 MiB 的解码结果）；发现重试固定 3 次/150ms 且无总重试截止；D13 的 `retiredPreviewWarning` 无来源断言仍在，未获决策故未改。

---

## 补充修复（2026-09-29，由 B08 的遗留风险 3 回报触发）

**缺陷**：`providers/http.ts` 的 `normalizeBaseUrl` 在 `fetch` **之前**抛出 `AppError("BASE_URL_INSECURE"/"BASE_URL_INVALID")`，但 `gemini.ts` 的 `fetchJson` 把 `providerCall` 的一切异常都交给 `transportFailure()`，后者把非 `ProviderCallError`/非 `UpstreamTransportError` 一律包成 `ProviderCallError("unknown","UPSTREAM_UNAVAILABLE")`。后果有两个且都错误：

1. **本地配置错误被报成「连不上模型服务」**——它根本没联系过任何服务；
2. 更严重：该 run 被记为 **`uncertain`**，即「可能已被受理、可能已计费」，而请求**从未发出**。违反 CONTRACTS §5「请求明确未发出可记 error；已发送但 5xx/网络异常无法证明拒绝时 uncertain」。

**修复**（两部分，均在 `providers/**`）：

1. `UpstreamTransportFailure` 新增 `not-sent` 种类（可证明「什么都没到达」的那一种）；`providerCall` 改为在自身 guard 内构造 URL，位于启动 deadline 与 `fetch` **之前**，因此 `endpoint()`/`normalizeBaseUrl` 的失败被判为 `not-sent`。`transportFailure()` 将 `not-sent` 映射为确定的 `rejected`。传输层现在**能自己说「请求从未发出」**，而不是让调用方去推断。
2. `connectionSchema.baseUrl` 改为经 `normalizeBaseUrl` transform：不安全或畸形的地址在连接创建/更新时即被拒绝（冻结码 `BASE_URL_INSECURE`/`BASE_URL_INVALID`，400），**无法入库**；可用地址以归一化形式存储。

**状态机现在正确**：无法构造的请求是 `rejected` → B05 映射为 `error` + `unavailable/not-generated`，不会再被记成 `uncertain`（那等于为从未离开 Solaris 的请求宣称可能存在费用），且对用户显示的是真实的本地原因。

**未回归**：真正的传输失败、5xx、停滞 body、超预算 body 仍全部为 `unknown`，测试断言恰好一次上游调用（永不自动重投），这些用例原样通过。`not-sent` 也不被发现流程重试（重试配置错误无意义）。

**测试**：每项都通过「把修复改回去、观察只有该测试失败」验证。新增 6 项（`gemini.test.ts` 4、`http.test.ts` 2）。`npx vitest run` → 408 passed / 40 files，无回归。

**证据边界**：run 路径的 guard 现在是对「绕过 schema 而入库的行」的纵深防御，因为 schema 已在创建/更新时拒绝该地址；目录路径（`discoverModels`/`testConnection`）获得同样的确定分类，所以坏 base URL 不再能经 API 到达。全部为 fixture 级（stub `fetch`），**未发起真实上游调用**。

**遗留**：`ProviderCallError` 的冻结码联合只含上游码，故 run 记录里的本地 URL 错误显示为 `UPSTREAM_FAILED` 而非 `BASE_URL_*`（**message 是准确的**，只有 code 不精确）。创建/更新返回的仍是准确的 `BASE_URL_*`，那也是用户真正能修复的路径。协调者评估：该路径在 schema 修复后已不可达，且消息准确，故**不为一个不可达路径改动冻结类型**。
