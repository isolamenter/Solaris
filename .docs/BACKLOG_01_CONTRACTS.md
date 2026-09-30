# B01 — 共享契约与最小扩展边界

状态：**代码冻结已完成（2026-09-29）**，共同基线 typecheck/lint/测试绿。等待 B08 落地依赖配置后开放并行。
依赖：B00 已确认范围；未决项按 CONTRACTS §12 限制。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

src/shared/contracts.ts、共享摘要工具、独立服务端接口类型、providers/types.ts、纯契约测试；CONTRACTS.md、INTEGRATION_MANIFEST.md。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 按 CONTRACTS v3 落地真实 DTO、私有 Row、认证/凭证/Session 接口及本地类型，删除视频/Batch/旧素材 DTO。→ `shared/contracts.ts`、`shared/local.ts`、`server/interfaces.ts`（含 §8.0 私有 Row 字段表）、`providers/types.ts`
- [x] 固定统一 GenerationResponseDto 的 200/202 与错误 envelope；result 采用 pending/delivered/unavailable 判别类型。→ `contracts.ts`；`http/app.ts` 按 result.kind 映射 202/200
- [x] 实现规范化输入与 digest 工具、固定 canonical string/hash 向量；参考图包括顺序、MIME 和真实字节摘要。→ `shared/digest.ts` + `digest.test.ts`（16 项；主向量由 `shasum` 独立算出，非从实现回抄）
- [x] 冻结 repository receipt 原子认领、终态条件更新、删除后保留去重、模型/连接删除规则。→ `repository.ts`（`claimRun` 单事务、`finishRun` 条件更新、`deleteRun` 保留 receipt、`assertNoActiveRun`）
- [x] 冻结认证两段事务和凭证来源接口；Client 的 flow 为 desktop-code，不硬编码内部协议。→ `AuthAdapter`/`SessionService`/`CredentialSource`/`CredentialVault` 已在 `interfaces.ts` 冻结，`DeploymentDto.auth.flow = "desktop-code"`
- [x] 为 B06/B07 冻结 LocalScope、DraftRecord、LocalRunRecord、文件操作与 DesktopLogin 方法。→ `shared/local.ts`
- [x] 收集依赖/schema/启动配置，由 B08 串行落地；协调最小消费者适配，使共同基线可编译再开放并行。→ §13 配置键已入 `env.ts`；消费者已适配；typecheck/lint/构建/测试全绿
- [x] 未决 outputCount、跨设备验收和预算保留明确状态；冻结前回写已确认结论，不用 any/类型断言掩盖缺口。→ `outputCount` 在 `geminiAdapter.ts` 保持 Solaris 侧截断语义、契约未冻结该控件；跨设备仅元数据由 `RunDto` 无字节字段保证

## 验收与交接

- [x] 所有类型/方法在代码真实存在，manifest 与消费者一致，不能只拿文档宣称接口已冻结。
- [x] 纯契约/schema/digest 检查通过；repository/HTTP/真实服务测试归对应实现任务。
- [x] 共同基线 typecheck/lint 通过后串行发布；后续改接口必须协调所有消费者。

## 实际验证（2026-09-29 实跑）

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **0 错误** |
| `npx eslint .` | 通过 |
| `npm run build` | 通过（39 modules，234 kB js / 16.5 kB css） |
| `npx vitest run` | **56 项全过**（9 文件） |
| 独立运行期校验（`app.inject()`，14 项） | **14/14 通过** |

独立校验覆盖：公开 `/api/deployment`；无 bearer → 401 `AUTH_REQUIRED`；已删除路由（`/api/batches`、`/api/jobs`、`/api/assets`、`/api/plugins`）→ 404；跨源写与非回环 Host 被拒；strict schema 拒绝请求体夹带身份字段；**端到端 multipart 生成 → 200 + 真实字节**；**重放后上游总调用次数仍为 1**；他人读该运行 → 404（非 403）。

## 交接给后续任务

- **B03 必须补齐两处**：① §2.3 的登录事务存储与一次性授权码在 `interfaces.ts` 中**没有接口**，`AuthAdapter`/`SessionService` 不足以承载；② 三条 `/api/auth/*` 路由目前**fail-closed（`AUTH_FLOW_INVALID`）**，其参数拼写（`state`/`code_challenge`/`redirect_uri`、`code`+`code_verifier`）是按 §2.3 推断的 OAuth 风格写法，**需 B03 冻结真实参数名**。
- **B08 必须处理**：① `.env.example` 未更新（仍只文档化 3 个键）；② `e2e/local-boundary.spec.ts` 已删除——它断言的是 `/api/profiles` 等已删路由与已变更的错误码，且服务在 B03 就位前**故意拒绝启动**，e2e 当前无法运行；③ 未映射的 `AppError` 码（含 `HOST_REJECTED`/`ORIGIN_REJECTED`）现归 `INTERNAL 500`，见下方风险。
- **B08 第一段（依赖落地）尚未开始**：B02/B04 **不需要新依赖**，可直接开工；B03 需要 OIDC 校验库、B06 需要 Tauri 工具链——两者都是 `INTEGRATION_MANIFEST` 所说「没有确认的第三方包不在此文档编造」，需维护者确认后才可落地。

验证：focused 契约检查 → npm run typecheck → npm run lint。（已执行，见上表）

## 遗留风险

1. **回环边界码变成 500**：`toPublicError` 只放行冻结码，故 `HOST_REJECTED` 由 421、`ORIGIN_REJECTED` 由 403 变为 `INTERNAL 500`。**防护未被削弱**（请求仍被拒），但拒绝在监控里与真实故障不可区分，且 `logger:false` 下运维看不到原因。是否把这两个过渡期码纳入冻结集，交 B08 决定。
2. **存储的 `baseUrl` 尚未校验**：路由只做 `z.string().min(1)`，`BASE_URL_INSECURE`/`BASE_URL_INVALID` 仍只在调用时由 `normalizeBaseUrl` 抛出，因此**不安全或畸形的地址今天可以被保存**。归属 B04 的 `connectionSchema`。
3. **`SOLARIS_SESSION_TTL_SECONDS` 无默认值**（§13 未给候选），必需性未定，归 B03/B08。
4. **预算键当前无人读取**：`SOLARIS_IMAGE_RESULT_MAX_BYTES` 等已入 `env.ts`，实际消费在 B04/B05。

