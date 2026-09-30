# B08 — 共享配置与远程安全集成

状态：**实现完成（2026-09-29）**；真实公开联调未做，故**未宣布验收**。见文末验证记录。
依赖：第一段 B01 manifest；第二段 B02–B07。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

src/server/http/、main.ts、env.ts、errors.ts、.env.example、根依赖/构建配置、e2e/、smoke、集成 tests。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 第一段按 manifest 串行落地依赖/工具命令与配置 schema，发布共同基线；不提前解除旧网络保护。
- [x] 第二段组合认证、repository、provider、同步 services/结果缓存和 Client；严格 route schemas 与稳定响应。
- [x] 建立公网 HTTPS/Host/来源/可信代理/bearer 权限边界，所有连接/模型/运行路由按用户校验。
- [x] 精确校验 callback、限制上传 file/field/parts/总量/MIME，Fastify 限制错误映射冻结码而非 INTERNAL。
- [x] 设置完整上游 deadline/原始响应/图片/缓存预算并实测，回写 CONTRACTS；按部署建立出站地址与重定向策略。
- [x] 启动独占数据目录且接收请求前收敛遗留 running；周期检查排除 active；优雅关闭清调度器/缓存/DB，无旧 runner。
- [x] 删除旧路由/静态本机模式假设，在替代保护测试通过后调整监听；旧 schema 拒绝自动重建。
- [ ] **非内部公开环境完成真实 IdP、模型单次生成、响应重放和 macOS 保存联调；不把内部网关成功代替公开实测。**（未做：见"未验证"）

## 验收与交接

- [x] 无凭证/越权/伪造 Host-origin/代理/恶意上游目标/上传超限/秘密泄漏测试通过。
- [ ] 断网、慢 body、Server 重启、缓存淘汰、保存失败不重复生成；不承诺图片恢复。（重启收敛已实测；断网/慢 body/缓存淘汰/保存失败属 B04/B05/B07 的用例，未在 B08 重跑）
- [ ] 真实公开联调明确环境与证据，未具备真实 IdP/模型时保持未实测，不宣布 B08 验收。

验证：focused integration/security → typecheck/lint/build/full npm test/相关 e2e/运行中 smoke；原生行为单独记录。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 边界实现（精确说明）

**检查什么**

- `Host`（每个请求）：必须等于 `SOLARIS_PUBLIC_ORIGIN` 的 authority（小写化、默认端口归一化、字符集检查）。重复 `Host` 头（数组）直接拒绝，不挑一个。
- `Origin`（存在时）：必须在该**显式白名单**内（默认只含 public origin）。`SOLARIS_ALLOWED_ORIGINS` 可追加（如 `tauri://localhost`、浏览器端 origin）。为 `null` / 无法解析 / 重复 / 带路径或查询 → 拒绝。
- **完全不带 `Origin` 的请求**视为非浏览器客户端：**放行到 bearer 校验**，绝不当作 same-origin 信任（`app.boundary.test.ts` 有专门用例：无 Origin 的 `/api/me` 得到 `401 AUTH_REQUIRED`）。
- 先查 `Host` 再查 `Origin`，所以伪造 Host 的请求不会被报成"来源合法"。
- 边界注册为 `onRequest` hook，在任何路由与 404 handler 之前：**被拒请求到不了任何 handler**（含未知路径）。

**fail closed（拒绝启动，不是拒绝请求）**

- 缺 `SOLARIS_PUBLIC_ORIGIN`、或它不是裸 origin（带路径/查询/凭据）、或非 https（**例外**：字面回环 `http://127.0.0.1[:port]`、`http://[::1][:port]`）→ 启动即抛错。
- `SOLARIS_TRUST_PROXY` 不是非负整数（例如 `true`）→ 启动即抛错：它是**跳数**，不是开关；`true` 语义等于"相信任何人的 X-Forwarded-For"。
- `SOLARIS_ALLOWED_ORIGINS` 里出现非 origin 值 → 启动即抛错。
- 无"本地模式"：没有"回环免检"分支，也没有与远程模式并列的第二套逻辑。默认监听仍是 `SOLARIS_BIND_HOST=127.0.0.1`。

**选定的状态码（不在冻结 API 码表内，供契约负责人登记）**

| 情形 | HTTP | code | message |
| --- | --- | --- | --- |
| `Host` 不是本部署的 authority | **421 Misdirected Request** | `HOST_REJECTED` | `This Solaris Server does not serve the requested host` |
| `Origin` 不在白名单内 | **403 Forbidden** | `ORIGIN_REJECTED` | `This origin is not allowed to call the Solaris API` |

两者都**不是** API 错误码：不加入 `errorCodes`、不混进 API 表、不接受 `INTERNAL` 折叠。做法是由 `onRequest` hook **直接 `reply.status(...).send(...)`** 应答，不抛异常，因此永远不经过 `toPublicError`；`toPublicError` 里另有一张 `TRANSPORT_BOUNDARY_CODES` 映射作为防御性兜底，保证任何路径下都不会变成 `500 INTERNAL`。拒绝会以一行 JSON 写到 stderr（`logger:false` 下的运维可见性），字段先 JSON 序列化再截断，换行无法伪造日志行。

**可信代理**：`SOLARIS_TRUST_PROXY=<跳数>` 原样交给 Fastify 的 `trustProxy`（0 → `false`）。`request.ip` / `request.protocol` 因此恰好按配置的跳数取值（测试覆盖 0 跳忽略 XFF、1 跳采信、取最右而非最左、无 XFF 时回落 socket）。`request.ip` 只出现在 `/api/health` 诊断字段里，不参与鉴权或限流。

**上传边界**：传输层限额**严格宽于**任何适配器声明的策略（`providers/geminiAdapter.ts` 的 `attachmentPolicy`：14 个 / 单个 10 MiB / 合计 14 MiB）——多 1 个文件、多 1 MiB、总量多一个满尺寸文件，因此**超限用户先撞到的是按模型的冻结码与模型自己的提示**，传输层只是兜底。`app.upload.test.ts` 从插件里读出策略并断言这个大小关系，将来策略变大而传输限额没跟上会直接测试失败。所有传输层限额都映射到冻结码（`REFERENCE_COUNT` / `REFERENCE_SIZE` / `REFERENCE_TOTAL_SIZE` / `VALIDATION`），无一落到 `INTERNAL`。

## 改动文件

**改**：`src/server/http/security.ts`（重写：删除 `assertLoopbackHost`/`assertSameOrigin`）、`src/server/http/app.ts`（边界 hook、auth 路由接线、传输限额、`referenceTransportBounds` 导出）、`src/server/http/security.test.ts`（重写）、`src/server/main.ts`（重写：配置前置校验、`recoverAbandonedRuns`、reaper、信号关闭）、`src/server/env.ts`（新增 `allowedOrigins`/`trustProxy`/`bindHost`，`publicOrigin` 保持原样）、`.env.example`（§13 全部键 + 两个新键，全占位符）、`playwright.config.ts`（e2e 服务器所需的完整必需配置）、`scripts/smoke.ts`（重写）、`e2e/deployment.spec.ts`（新增）

**删**：`e2e/local-boundary.spec.ts`（断言已删除的路由与回环 Host 假设）

**新增 tests**：`src/server/http/testSupport.ts`（在临时库上搭建**真实组合**：repository + service + auth + boundary + Fastify）、`app.boundary.test.ts`(13)、`app.security.test.ts`(21)、`app.upload.test.ts`(16)、`app.auth.test.ts`(13)、`app.lifecycle.test.ts`(8)

**接线**：`main.ts` 不再有 `authBoundaries()` 抛错，也不再有 `AUTH_FLOW_INVALID` 占位；改为 `createAuthBoundaries(...)` + `registerAuthRoutes(app, {adapter, transactions, sessions, users, redirectAllowlist, callbackUrl})`，`callbackUrl` 由 `boundary.publicOrigin + CALLBACK_PATH` 派生（不可能与所服务的 host 不一致）。

## 实际验证（2026-09-29 实跑）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 错误 |
| `npx eslint .` | 通过 |
| `npx vitest run` | **40 文件 / 402 项通过**（B07 基线 320 项，本次 +82，无回归） |
| `npm run build` | vite 成功，54 modules，`dist/client/index.html` + 248.30 kB js + 16.70 kB css |
| `npx playwright test` | **10 passed**（真实服务器进程 + 真实 HTTP） |
| `npm run smoke`（对运行中的服务器，`PORT=3321`） | 通过：`200 /api/health`、`421 HOST_REJECTED`、`403 ORIGIN_REJECTED`、`401 AUTH_REQUIRED` |

**安全测试证明的是什么**（`app.security.test.ts`）：无 / 空 / `Bearer` / `Bearer ` / `Basic` / 未知 token 在 7 条账号路由上全部 `401 AUTH_REQUIRED`；过期与已撤销会话 `401`；身份只取自会话（请求体里塞 `userId`/`id` 被 `strictObject` 拒绝且不改动目标用户数据）；退出只注销当前会话；**每一个**连接/模型/运行/结果路由的跨用户访问都是 `404 NOT_FOUND`（含 `PUT/DELETE/test/models/refresh/models/DELETE model`、`GET/DELETE run`），且跨用户生成**不产生上游调用、不产生 run**；`CREDENTIAL_MISSING` 409 且无幽灵 run；连接响应只给 `hasKey`、字段集固定，错误体与日志都不含提交的 key；`BASE_URL_INSECURE` 之类的深层错误也不回显 key。另有两个用例让**真实 gemini 传输**跑起来（只 stub 全局 `fetch`），令上游 4xx/5xx 响应体里回显 `?key=<secret>` 与图片 base64：客户端信封、run 详情、进程日志**都没有**出现 key 或 base64，历史里**没有** `dataBase64`。

**边界测试证明的是什么**（`app.boundary.test.ts`/`app.lifecycle.test.ts`）：被拒请求到不了 handler（含未知路径）；有**合法会话**的请求在伪造 Host/Origin 上仍被拒；边界拒绝只写一行日志且不能被换行注入；传输码永远不是 `INTERNAL`；无 Origin 不等于 same-origin；4 个可信代理用例；`app.lifecycle.test.ts` 用**独立进程 + 真实 socket** 复验了 Host/Origin 拒绝与优雅退出（`SIGTERM` → 退出码 0、端口关闭），并证明**重启会把上一次进程遗留的 `running` 行收敛为 `uncertain` 且不再重投**。

**登录流程证明的是什么**（`app.auth.test.ts`）：用**假 IdP**（自签 RS256 + 假 discovery/JWKS/token 端点）跑完整 desktop 流程——authorize 302 到 IdP（Server 自己的 state/nonce/challenge，与桌面端的 state/challenge 不同）、callback 302 回**授权时存下的**回环地址并带一次性 code、token 换取真实 `SessionDto`、再拿它调 `/api/me`；Server 确实以 `client_secret_basic` 认证自己并携带**上游** `code_verifier`；上游 access token 不出现在任何 URL 或会话里。负面：非回环或未登记的 `redirect_uri`（8 种形态）、非 S256、缺失/超范围参数、未签发的 callback state、callback state 重放、code 重放、verifier 不匹配、nonce/issuer/audience/expiry 错误、JWKS 里没有的签名密钥、IdP 不可达、token 端点拒绝——全部 `AUTH_FLOW_INVALID`，一个会话都不发出。

### 未验证（明确列出，不宣布验收）

1. **真实公开 IdP 登录：未运行。** 假 IdP 只证明 Server 这一侧的行为正确（签名/discovery/JWKS/claim 校验都真的执行了），**不能**证明与任何真实 IdP 的互通、真实 client 注册或真实网络。
2. **真实模型单次生成：未运行**（维护者未授权计费调用）。provider 层在 HTTP 测试里被替换或只 stub 全局 `fetch`，因此**请求确实发到了真实的 gemini 传输**（URL 形状、`?key=`、超时、有界读、重定向策略都跑了），但没有字节到达任何真实模型服务，也没有验证真实响应被正确解码为图片。
3. **macOS 桌面行为：未运行**（未启动 Tauri App、未跑真实回环登录、未做真实保存）。B06 的原生编译/Keychain 结论见 B06 文档。
4. 静态客户端由服务器从工作目录 `dist/client` 提供，e2e 与生命周期测试都覆盖到了，但**没有**在真实 Tauri webview 里加载过。

### 遗留风险

1. **可信代理下 `request.ip` 可能不合法**：Fastify/proxy-addr 会把无法解析的 `X-Forwarded-For` 条目原样返回。Solaris 不用 `request.ip` 做鉴权或限流（只出现在健康诊断），但运维必须确保入口代理**覆写**而非追加 `X-Forwarded-For`。
2. **`SOLARIS_PUBLIC_ORIGIN` 是单值**：多域名/多入口部署要在 `SOLARIS_ALLOWED_ORIGINS` 里补 Origin，但 `Host` 只认一个 authority——反向代理必须把外部 Host 归一化到这一个值。
3. **BASE_URL_INSECURE 被报成 502 `UPSTREAM_UNAVAILABLE`**（经 `/api/connections/:id/test` 与模型刷新）：`providers/http.ts` 的 `normalizeBaseUrl` 抛的是 `AppError`，但 `gemini.ts` 的 `transportFailure()` 把它包成 `ProviderCallError("unknown", "UPSTREAM_UNAVAILABLE")`，于是配置错误被说成"连不上模型服务"，并且该次调用被当作结果未知。属 `providers/**`（B04），B08 未改。
4. **`SOLARIS_TRUST_PROXY` 一旦配错就是安全边界配错**：配成大于实际跳数会让客户端伪造 `X-Forwarded-For`。它只影响 `request.ip`/`protocol`，不参与鉴权，但仍会误导日志/诊断。
5. **`tsx` 包装层吞掉退出码**：`npm start`/`npm run dev` 是 `npm → tsx → node`。对 tsx 进程发 `SIGTERM` 时，服务器会正常关闭、端口释放（已实测），但**包装进程自己报 128+15**。用 systemd/Docker 之类按退出码判断"是否干净退出"的编排需要直接以 `node --import .../tsx/dist/loader.mjs src/server/main.ts` 或以编译产物启动。
6. **上传内存峰值**：`readGenerationParts` 边读边累计总量，峰值约等于传输总量上限（24 MiB）加一个满尺寸文件，因为服务层的按模型总量检查在全部 part 读完之后。策略检查因此晚于传输检查发生（**但码与提示仍是策略的**）。
7. **`e2e/deployment.spec.ts` 的 `SOLARIS_OIDC_ISSUER=http://127.0.0.1:9`** 是不可路由端口：e2e 只证明登录入口可达且 fail closed，不证明能登录。
8. **进程内结果缓存不落盘**：重启即丢，重启后同 submissionId 的重放会得到 `unavailable`（不重投上游）。这是 B05 的设计，未改。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

- `npx tsc --noEmit` → 0 错误；`npx eslint .` → 通过
- `npx vitest run` → **40 文件 / 402 项通过**（B07 基线 320，+82，无回归）
- `npm run build` → 成功
- `npx playwright test` → **10 passed**（真实服务器进程 + 真实 HTTP）
- `npm run smoke`（对运行中服务器）→ 通过：`200 /api/health`、`421 HOST_REJECTED`、`403 ORIGIN_REJECTED`、`401 AUTH_REQUIRED`

**新增**：`src/server/http/testSupport.ts`（真实组合：临时库 + repository + service + auth + boundary + Fastify）、`app.boundary.test.ts`(13)、`app.security.test.ts`(21)、`app.upload.test.ts`(16)、`app.auth.test.ts`(13)、`app.lifecycle.test.ts`(8)、`e2e/deployment.spec.ts`。

### 实现的边界（精确）

- `Host` 必须等于 `SOLARIS_PUBLIC_ORIGIN` 的 authority（小写化、默认端口归一化）；重复 `Host` 头直接拒绝，不挑一个。
- `Origin` 存在时必须落在显式白名单（默认只含 public origin）；`null`/无法解析/重复/带路径或查询 → 拒绝。
- **完全不带 `Origin` 的请求**放行到 bearer 校验，绝不当作 same-origin（有专门用例）。
- 边界是 `onRequest` hook，注册在任何路由**与 404 handler 之前**：被拒请求到不了任何 handler，含未知路径。
- **fail-closed = 拒绝启动**：缺 `SOLARIS_PUBLIC_ORIGIN`、非裸 origin、非 https（字面回环除外）、`SOLARIS_TRUST_PROXY` 不是非负整数（它是**跳数**不是开关）→ 抛错。无「本地模式」，只有一套配置驱动的边界；默认监听仍是 `127.0.0.1`。
- 状态码：`421 HOST_REJECTED` / `403 ORIGIN_REJECTED`，由 hook 直接应答、不抛异常，故**永不经过 `toPublicError`**，也不会退化成 `INTERNAL`；`toPublicError` 内保留防御性映射。拒绝以单行 JSON 写 stderr（字段先序列化再截断，换行无法伪造日志行）。**已登记进 CONTRACTS §9.1。**
- 格式：小写十六进制；字符串用 JSON 转义；顺序固定 `{connectionId,modelId,prompt,parameters,references}`；`parameters` 缺席为 `null`；`references` 为按表单顺序的 `{mimeType,sha256}`。
- 上传传输限额**严格宽于**适配器策略（多 1 个文件、多 1 MiB、总量多一个满尺寸文件），使超限用户先撞到**按模型的冻结码与模型自己的提示**；`app.upload.test.ts` 直接从插件读策略并断言该大小关系，因此策略将来变大而传输限额没跟上会直接测试失败。全部传输限额映射到冻结码，无一落到 `INTERNAL`。
- 可信代理：`SOLARIS_TRUST_PROXY=<跳数>` 原样交给 Fastify；测试覆盖 0 跳忽略 XFF、1 跳采信、取最右而非最左、无 XFF 回落 socket。

### 安全测试证明什么

7 条账号路由上无/空/`Bearer`/`Bearer `/`Basic`/未知 token 全部 401；过期与已撤销会话 401；身份只取自会话（请求体塞 `userId`/`id` 被 strict schema 拒绝且不改动目标用户数据）；**每一个**连接/模型/运行路由的跨用户访问都是 404；跨用户生成**不产生上游调用、不产生 run**；连接响应只给 `hasKey`。两个用例让**真实 gemini 传输**跑起来（只 stub 全局 `fetch`），令上游 4xx/5xx 响应体回显 `?key=<secret>` 与图片 base64：客户端信封、run 详情、进程日志均无 key 或 base64。

`app.lifecycle.test.ts` 用**独立进程 + 真实 socket** 复验边界拒绝与优雅退出（`SIGTERM` → 退出码 0、端口关闭），并证明重启把遗留 `running` 收敛为 `uncertain` 且不重投。

`app.auth.test.ts`（假 IdP：自签 RS256 + 假 discovery/JWKS/token）跑完整 desktop 流程，并覆盖 8 种非法 `redirect_uri`、非 S256、未签发 state、state/code 重放、verifier 不匹配、nonce/issuer/audience/expiry 错误、JWKS 缺失签名密钥、IdP 不可达 —— 全部 `AUTH_FLOW_INVALID`，一个会话都不发出。

### 未验证（故不宣布验收）

1. **真实公开 IdP 登录未运行。** 假 IdP 只证明 Server 侧行为正确，**不能**证明与任何真实 IdP 的互通或真实 client 注册。
2. **真实模型单次生成未运行**（未获计费授权）。请求确实走到了真实 gemini 传输（URL 形状、`?key=`、超时、有界读、重定向策略都跑了），但没有字节到达真实模型服务。
3. **macOS 桌面行为未运行**（未启动 Tauri App、未真实回环登录、未真实保存）。
4. e2e 的 `SOLARIS_OIDC_ISSUER=http://127.0.0.1:9` 是不可路由端口：只证明登录入口可达且 fail closed，**不证明能登录**。

**没有把内部网关成功当作公开实测。**

### 遗留风险

1. 可信代理下 `request.ip` 可能不合法（proxy-addr 原样返回无法解析的 XFF 条目）。Solaris 不用它做鉴权限流，但入口代理必须**覆写**而非追加 XFF。
2. `SOLARIS_PUBLIC_ORIGIN` 是单值：多域名部署要在 `SOLARIS_ALLOWED_ORIGINS` 补 Origin，但 `Host` 只认一个 authority，反代须把外部 Host 归一化到该值。
3. ~~`BASE_URL_INSECURE` 被报成 502 `UPSTREAM_UNAVAILABLE`~~ → **已回报给 B04 修复中**：配置错误被说成「连不上模型服务」，且该次调用被当作**结果未知**（`uncertain`），而请求其实**从未发出** —— 违反 §5「请求明确未发出可记 error」。
4. `SOLARIS_TRUST_PROXY` 配错即安全边界配错（配大于实际跳数可让客户端伪造 XFF）；只影响 `request.ip`/`protocol`，但会误导日志与诊断。
5. **`tsx` 包装层吞退出码**：`npm start` 是 `npm → tsx → node`，对 tsx 进程发 `SIGTERM` 时服务器正常关闭、端口释放（已实测），但包装进程自己报 128+15。按退出码判断「干净退出」的编排需直接以 node 或编译产物启动。
6. 上传内存峰值约等于传输总量上限加一个满尺寸文件，因为按模型的总量检查在全部 part 读完之后（码与提示仍是策略的，只是时机晚于传输）。
7. 进程内结果缓存重启即丢；重启后同 submissionId 的重放得到 `unavailable`（**不重投上游**）。属 B05 设计。
