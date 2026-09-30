# B03 — 公开认证、会话与独立凭证来源

状态：**已完成（2026-09-29）**，见文末验证记录。
依赖：B01；与 B02/B04/B06 并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

新增 src/server/auth/、credentials/，vault.ts 与测试；不改 env.ts/app.ts/数据库。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 实现 AuthAdapter/SessionService 与公开 OIDC 适配器，提供路由注册与身份验证模块给 B08。
- [x] 实现独立 Client/上游 state、两段 PKCE 与 nonce、一次性码原子消费、有界短期事务存储；重启失效重新登录。
- [x] 严格解析回环 IP/协议/端口/路径，无 credentials/query/fragment；Server OIDC 密钥不进入桌面。
- [x] 身份映射用 issuer/subject，签发 bearer 会话、仅持久化 token hash；过期重新登录，登出撤销当前会话。
- [x] 实现 user-key CredentialSource，按 userId/connectionId 校验所有权后解析 Key；失败不切换其他来源。
- [x] 沿用 vault 格式，AAD UUID 用户+连接；修复秘密脱敏边界，不把任意 diagnostics 原文交给日志。
- [x] 配置 schema 与依赖交 B08：oidc 配置只对所选 oidc 适配器必需，不让未来内部部署必须配置 OIDC。

## 验收与交接

- [x] 回调重放、state/verifier/nonce、issuer/audience/签名/过期校验失败有 focused tests。
- [x] 用户 A 不可解密 B 的 Key；DTO 仅 hasKey；token/code/verifier/base64 不出现于日志。
- [x] AuthAdapter 与 CredentialSource 方法被领域层真实消费，而非只重命名对象字段。

验证：focused auth/vault tests → typecheck → lint；真实 IdP 登录由 B08 单独验收。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

- 聚焦：`npx vitest run src/server/credentials src/server/auth src/server/vault.test.ts` → 10 文件 / 86 项通过
- `npx tsc --noEmit` → 0 错误；`npx eslint .` → 通过；`npx vitest run` → **195 项通过**

**新增文件**：`auth/{index,oidc,redirect,routes,sessions,transactions}.ts`、`credentials/{index,userKey,vault}.ts` 及各自测试。改动 `vault.ts` + `vault.test.ts`。

### 冻结的认证路由参数名（B08 可直接依赖）

| 路由 | 参数 |
| --- | --- |
| `GET /api/auth/desktop/authorize` | `state`, `redirect_uri`, `code_challenge`, `code_challenge_method`（字面量 `S256`）；四者必填，strict schema，多一个查询参数即 `VALIDATION` |
| `GET /api/auth/callback` | `code`, `state`；strict；`error=access_denied` 按格式错误处理，不当作指令 |
| `POST /api/auth/desktop/token` | JSON body 仅 `code`, `code_verifier`；无 `redirect_uri`、无客户端密钥（D2） |
| Server → Client 回环重定向 | query 携带 `code`, `state`，**绝不携带 token** |

### 安全不变量 → 证明测试

`id_token` 真验签（issuer/audience/expiry/JWKS 非对称签名/`requiredClaims`/常量时间 nonce 比较）→ `auth/oidc.test.ts`；**桌面 PKCE verifier 从不进入适配器**（断言上游收到的 `code_verifier` 的 S256 等于 URL 中的 challenge，且不等于桌面 verifier）→ 同上；两段事务双 state 命名空间 + 一次性码（重放 upstream state / Solaris code / 失败 verifier 烧掉 code）→ `auth/transactions.test.ts` + `auth/routes.test.ts`；严格回环解析（拒 `localhost`、后缀匹配、开放重定向、credentials/query/fragment）→ `auth/redirect.test.ts`；会话仅存 SHA-256 哈希、过期/撤销 → 401 `AUTH_REQUIRED` → `auth/sessions.test.ts`；`user-key` 先校验归属且**无回退**（他人 connectionId → 404 且 decrypt 未被调用；他人密文 → `CREDENTIAL_CORRUPT`；无 Key → 409）→ `credentials/userKey.test.ts`；vault AAD 改为 `${userId}:${connectionId}`、UUID 校验、**无双读回退**（旧 AAD 密文、拷给他人的密文均失败）→ `vault.test.ts` + `credentials/vault.test.ts`；**脱敏按内容而非键名**（先前落库的 2.2MB `inlineData.data` base64 现被 `[REDACTED]`）→ `vault.test.ts`；注册表拒绝未确认适配器而非回退 → `auth/registry.test.ts`。

### 仅 fixture / 未验证

- **真实 IdP 登录未执行**（无 IdP、无浏览器、无回环监听）。OIDC 部分以进程内假 IdP 产出真实 `Response` 喂进真实 `jose` 验签路径，**不能替代端到端登录**。
- 凭证过期分支（`requireUsable`）只有合成数据覆盖：`user-key` 恒返回 `expiresAt: null`，因为冻结的 `ConnectionRow` 没有可存过期时间的列，**生产路径目前到不了该分支**。
- token endpoint 固定用 `client_secret_basic`，未支持 `client_secret_post`；部分 IdP 只接受后者。

### 遗留风险

1. **`assertSameOrigin` 会挡住桌面客户端**（协调者已从代码确认）：它对所有非 GET 请求要求 `Origin` 恰好等于 `http://127.0.0.1:<port>`。桌面 App（或任何非浏览器客户端）不带该头或带自己的 origin → 被拒，因此 **`POST /api/auth/desktop/token` 对真实桌面流程不可达**；叠加错误码映射后失败还是不可区分的 500。归 B08 的远程边界工作。
2. `AGENTS.md` 仍写着「profile ID as AAD」，已被 CONTRACTS §3 取代——文档漂移，未改（非本任务所有物）。
3. 登录事务与一次性码是**单进程内存态**：重启或多实例会使在途登录失效（符合设计），未来横向扩展需粘性会话。
4. `redact()` 基于内容模式；若某个短于 200 字符的秘密存在未被识别的键名下，仍可能透过。
