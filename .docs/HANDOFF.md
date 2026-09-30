# Solaris 重构交接文档

日期：2026-09-29
适用版本：`CONTRACTS.md` v3（已冻结）
读者：接手本仓库的人或 agent。

本文件回答三个问题：**现在到底完成了什么**、**什么还没被证明**、**下一步卡在哪**。
它不是设计文档（那是 `CONTRACTS.md`），也不是决策记录（那是 `DECISIONS.md`）。

---

## 1. 一句话状态

**代码实现完成（B00–B08），fixture / 单测 / e2e 三级全绿；真实环境验收一项都没做。**

具体地说：一次真实 OIDC 登录、一次真实模型生成、一次真实 macOS 桌面运行**都没有发生过**。
因此 B08 **未宣布验收**，B09（内部 SSO/NewAPI）与 B10（交付）**保持待开始**。

不要把这句读成"快好了"。它意味着：**没有任何证据表明这套东西能与真实 IdP、真实模型服务或真实 macOS 桌面互通。** 已证明的是 Solaris 自身的行为在隔离条件下正确。

---

## 2. 验证边界（最重要的一节）

### 已实测（可复现，2026-09-29）

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit` | 0 错误 |
| Lint | `npx eslint .` | 干净 |
| 单测 | `npx vitest run` | **408 通过 / 40 文件**（起始基线 56） |
| 端到端 | `npx playwright test` | **10 通过**（真实服务器进程 + 真实 HTTP） |
| 客户端构建 | `npm run build` | 通过 |
| Rust | `cd src-tauri && cargo check --all-targets` | Finished，零警告 |
| 原生测试 | `cd src-tauri && cargo test` | 24 通过 / 1 ignored |
| **真实 Keychain** | `cargo test -- --ignored` | **通过**（真实 macOS Keychain 往返） |
| Smoke | `npm run smoke`（对运行中服务器） | 通过：`200 /api/health`、`421 HOST_REJECTED`、`403 ORIGIN_REJECTED`、`401 AUTH_REQUIRED` |
| Rust 构建 | `cargo build` | 产出 `target/debug/solaris-desktop`（Mach-O arm64，约 26 MB） |

### 未实测（**不得**当作已验收）

1. **真实公开 OIDC IdP 登录。** 全部 OIDC 验证用的是**进程内假 IdP**（自签 RS256 + 假 discovery/JWKS/token），它确实喂进了真实的 `jose` 验签路径，因此证明了 **Server 侧行为正确**；但**不证明**与任何真实 IdP 的互通、real client 注册或真实网络。
   e2e 用的 `SOLARIS_OIDC_ISSUER=http://127.0.0.1:9` 是**不可路由端口**：只证明登录入口可达且 fail closed，**不证明能登录**。
2. **真实模型单次生成。** 请求确实走到了真实 gemini 传输层（URL 形状、`?key=`、完整 deadline、有界读取、重定向策略都跑过），但**没有字节到达真实模型服务**，也**没有验证真实响应被正确解码为图片**。未获计费调用授权。
3. **macOS 桌面行为。** Tauri App **从未启动**；未弹过文件对话框；未真实回环登录；未真实保存文件；`open -R` 未执行。
4. **Windows / Linux。** 从未编译或运行。Linux 目前**按设计编译失败**（未声明 keyring 原生 store）。
5. **客户端与本地层的集成。** 仓库无 jsdom / testing-library；`vite build` 只证明能打包。真实浏览器渲染、登录序列、origin 切换、会话恢复（`LocalStore` 调用）**均未验证**。
6. **多进程。** 契约规定单进程独占数据目录，未测。两进程共用一个数据目录会 `SQLITE_BUSY` 而非干净的 `claimed:false`。

---

## 3. 如何启动

### 必需配置

服务器**拒绝在配置不全时启动**（fail-closed，无回退）。至少需要：

```
SOLARIS_PUBLIC_ORIGIN   # 本 Server 对外可达的 origin；定义唯一被服务的 Host，也默认为唯一允许的 Origin
CREDENTIALS_MASTER_KEY  # base64 编码的 32 字节；openssl rand -base64 32
SOLARIS_AUTH_ADAPTER    # 封闭注册表，公开值只有 oidc
SOLARIS_CREDENTIAL_SOURCE # 封闭注册表，公开值只有 user-key
SOLARIS_OIDC_ISSUER / SOLARIS_OIDC_CLIENT_ID / SOLARIS_OIDC_CLIENT_SECRET
```

全部键、默认值与语义见 **`.env.example`**（已完整，含注释解释每个值为什么必需）。

### 本地跑起来

```bash
npm run build      # 必须先有 dist/client
npm run dev        # 构建客户端后以 production 模式启动服务器
```

`SOLARIS_PUBLIC_ORIGIN` 允许字面回环 `http://127.0.0.1:3210`（仅回环例外，其余必须 https）。

**实用提示：** 没有真实 IdP 时，把 `SOLARIS_OIDC_ISSUER` 指向一个不可路由地址即可让服务器启动（e2e 就是这么做的），但**登录必然失败**。想在本地真正登录，需要自己起一个 IdP 或使用真实 IdP。

### 关键命令

```bash
npm run typecheck && npm run lint && npm test    # 提交前
npm run test:e2e                                  # Playwright（会自行拉起服务器）
npm run smoke                                     # 对已运行实例做健康与边界检查
cd src-tauri && cargo check --all-targets         # 原生层
```

---

## 4. 架构与模块地图

```
src/shared/        contracts.ts  DTO 与封闭联合（Operation / RunStatus / AdapterId / 错误码）
                   digest.ts     canonical JSON + contentDigest（Client/Server 共用；用 Web Crypto，不 import node:crypto）
                   local.ts      LocalStore / DesktopLogin / LocalScope（B06 实现，B07 消费）
src/server/        interfaces.ts 服务端接口：私有 Row、AuthAdapter、AuthTransactionStore、
                                 SessionService、CredentialSource、CredentialVault、Repository
                   db/index.ts   原生 DDL 是 schema 的唯一可执行来源；拒绝打开旧 schema 且不改动任何旧文件
                   repository.ts 原生 SQLite + 显式 Row→DTO 映射
                   services.ts   校验、摘要重算、幂等认领、重放、交付
                   resultCache.ts 有界进程内交付缓存（使重放能交回字节）
                   auth/         OIDC 适配器、登录事务、会话、路由注册模块
                   credentials/  user-key 凭证来源、AES-256-GCM vault
                   providers/    ProviderPlugin 边界 + Gemini 适配器
                   http/         部署边界、路由、错误信封
                   main.ts       组合根与生命周期
src/client/        React UI；api.ts 是 typed HTTP；local/ 是桌面层
src-tauri/         Rust 外壳：回环登录监听、系统安全存储、原生对话框、原子文件写
e2e/               Playwright（真实进程 + 真实 HTTP）
```

总代码量约 **16,300 行**（含测试），40 个单测文件。

**唯一的业务操作是同步单次图片生成**（可带参考图）。**不存在任何异步机制** —— 无视频、无 Batch、无上游任务轮询、无取消、无 JSONL、无 Server 素材库。

---

## 5. 相对原设计的偏离（必读）

原大纲 `REFACTOR_OUTLINE.md` 与当前实现有**根本性差异**，因为它已被维护者决策覆盖：

| 决策 | 内容 | 与原大纲的冲突 |
| --- | --- | --- |
| **D5** | 删除视频 | 大纲 §11 列为待确认 |
| **D15** | **删除 Batch 功能** | **直接冲突**：大纲 §7 称「图片 Batch 属于核心场景」，§10 要求「首期必须选择并验证至少一个支持目标 Batch 链路的服务」 |

D15 的触发证据（`PROTOCOL_MATRIX.md §4`，真实调用测得）：所配置网关对 `:batchGenerateContent` 返回 500，对 `/v1beta/batches`、`/v1/batches`、`/v1beta/files`、`/v1beta/interactions` **全部 404** —— 无任何 Batch 面。

**D5 + D15 的连锁后果：**

1. **Solaris 不再有任何异步操作。** 因此这些概念**整体删除且不留占位**：`runner.ts`、`jobs` 表、轮询调度、重启恢复、租约列、`queued`/`cancelled` 状态、`BatchJob*` DTO、JSONL 传输、结果保留期、逐条下载。
2. **跨设备历史只能看到元数据。** 单次生成不产生可再查询的上游任务，Server 也不存图，所以图片**只能存在于生成它的那台设备上**。换设备能看到"曾经生成过什么"，但**永远拿不回图**。这与大纲 §8「图片按需下载到当前设备」直接冲突。
3. **B05 的标题已从「生成与 Batch 编排」改为「单次生成编排」。**

若 Batch 后续要恢复：需重新选择上游（直连 Gemini 或 OpenAI），并按 `DECISIONS.md §7` 的对象清单**从零重建**，**不保留任何占位或兼容分支**。

---

## 6. 剩余任务与前置条件

| 任务 | 前置 | 状态 |
| --- | --- | --- |
| **B09** 内部 SSO、凭证接口与 NewAPI | ① B08 公开链路验收；② 内部协议确认 | **待开始**。已知输入：该网关**无 Batch/Files/Interactions**，单次生成可用 |
| **B10** macOS 与自托管交付、迁移、最终验收 | B08 验收（内部部分依赖 B09） | **待开始** |

### 推进需要外部输入

1. **授权一次真实模型调用。** 目的不是"跑通"，而是确认 B04 的严格结果 MIME 规则不会让原本可用的生成失败 —— 见 §7 风险 1。这是全仓唯一可能造成**行为回退**的改动。
2. **真实 OIDC IdP**（issuer + 已登记的 client + 已登记的回调地址）。
3. **内部 SSO 与 NewAPI 的协议资料**（B09 用）。

---

## 7. 已知缺陷与风险（累积，未解决）

按严重度排序。**这些都没有修复方案，只有描述。**

1. **【可能的行为回退】严格结果 MIME。** `providers/geminiAdapter.ts` 要求 `inlineData.mimeType` 属于 `image/png|jpeg|webp`；**缺失 MIME 现在判为 `UPSTREAM_NO_IMAGE`**，即确定的失败。而既有的真实探针只记录了「841KB PNG」、**未记录该字段是否存在**。**若真实网关省略 `mimeType`，原本能用的生成会失败。** 必须由真实调用确认。
2. **`SOLARIS_TRUST_PROXY` 配错即安全边界配错。** 它是**跳数**不是开关；配得大于实际跳数会让客户端伪造的 `X-Forwarded-For` 被采信。只影响 `request.ip`/`protocol`（Solaris 不用它做鉴权或限流），但会误导日志与诊断。**入口代理必须覆写而非追加 XFF。**
3. **`tsx` 包装层吞退出码。** `npm start` 是 `npm → tsx → node`；对 tsx 进程发 `SIGTERM` 时服务器正常关闭、端口释放（已实测），但**包装进程自报 128+15**。按退出码判断"干净退出"的编排需直接以 `node` 或编译产物启动。
4. **桌面壳从未启动。** 首次启动行为（窗口创建、`app_data_dir` 权限、主线程原生对话框）未测。Windows/Linux 未构建；Linux 按设计编译失败。
5. **`readSavedImage` 与 `revealInFileManager` 客户端未使用。** 没有打开或定位已保存文件的 UI 路径；预览始终来自交付字节而非设备文件。
6. **切换 Server 刻意保留旧 token**（`CONTRACTS §10`：只有登出清除）。持解锁设备的人切回去即可免登录。
7. **非 `ProviderCallError` 逃逸时 run 停在 `running`。** 对外表现为 500，只能靠 60 秒回收器收敛（阈值 15 分钟陈旧）。存在一个该 run 可被查询为 `202 pending` 的窗口。
8. **上传内存峰值**约等于传输总量上限 + 一个满尺寸文件（按模型的总量检查在读完所有 part 之后；码与提示仍是策略的，只是时机晚于传输）。
9. **`SOLARIS_PUBLIC_ORIGIN` 是单值**：多域名部署要在 `SOLARIS_ALLOWED_ORIGINS` 补 Origin，但 `Host` 只认一个 authority，反代必须把外部 Host 归一化到该值。
10. **可信代理下 `request.ip` 可能不合法**（proxy-addr 原样返回无法解析的 XFF 条目）。
11. **`ProviderCallError` 的冻结码联合只含上游码**，故 run 记录里本地 URL 错误显示为 `UPSTREAM_FAILED` 而非 `BASE_URL_*`（**message 准确**，只有 code 不精确）。创建/更新返回的仍是准确的 `BASE_URL_*`。协调者评估为一个不可达路径（schema 已在写入时拒绝），故未改动冻结类型。
12. **保存目录与参考图允许列表**存在 `<app_data_dir>/local/local-config.json`（明文、用户可写）：本地攻击者可改写保存目录指向（文件名形状与包含性检查仍生效）。
13. **`findSessionByTokenHash` 不校验过期**（由 B03 的 `SessionService` 负责返回 401）。
14. **`submission_id` 无 UUID CHECK**：契约说客户端生成 UUID，服务端边界已按 strict schema 校验，但数据库层无约束。
15. **登录事务与一次性码是单进程内存态**：重启或多实例会使在途登录失效（符合设计），未来横向扩展需粘性会话。
16. **`redact()` 基于内容模式**：若某个短于 200 字符的秘密存在未被识别的键名下，仍可能透过。

---

## 8. 未决的产品/技术决策

| 项 | 影响 | 状态 |
| --- | --- | --- |
| **`outputCount` 语义** | 它是 **Solaris 侧的截断**，不是上游参数（Gemini 无输出张数参数）。请求 4 张但上游只回 2 张时**不报错**，只保留 2 张。UI 标为 "maximum retained"，但控件是保留、改标签还是移除**未定**，契约未冻结该字段 | 待维护者确认 |
| **跨设备仅元数据是否接受** | D15 的直接后果（§5）。若要求"换设备能重新下图"，需重新引入上游 Batch 或让 Server 存图 —— 两者都已被排除 | 待维护者确认 |
| **D9–D13 建议项** | 单进程模型、冻结错误码表、移除调试面、删除会话 DTO、无来源的上游断言（`retiredPreviewWarning`） | 仍为建议状态 |
| **响应/缓存预算具体值** | 24 MiB / 600s / 256 MiB 为候选值，已在 `.env.example` 中作为默认值落地，但**未经资源实测** | 待 B08/B10 实测后写回 |

---

## 9. 环境陷阱（会浪费时间）

1. **`better-sqlite3` 原生模块版本**：本地 `node_modules` 若编译于 Node 20（`NODE_MODULE_VERSION 115`）而当前 shell 是更新版本，**所有数据库测试都会报 "compiled against a different Node.js version"**。修复：`npm rebuild better-sqlite3`。
   `AGENTS.md` 只写「Node 20.19 or newer」、未固定上限，所以这个错配从仓库看不出来。
2. **`keyring` 必须按平台声明原生 feature**（`apple-native` / `windows-native`）。**v3 在未启用时会静默选用内存 mock store**：token 全丢而测试仍全绿。仓库故意不提供无 feature 的兜底，使没有原生 store 的平台**编译失败**而非静默丢密钥。
3. **`.docs/` 被 `.gitignore` 忽略**，因此**不在 Git 里**。换机器或 worktree 必须显式传递本目录，否则接手者拿不到契约与决策 —— 那正是本仓库最关键的上下文。
4. **`npm start` 需要先 `npm run build`**（需要 `dist/client/index.html`）。
5. **测试里设置环境变量必须在 import 服务器模块之前**，且需用动态 import —— 环境配置是模块级的。

---

## 10. 方法论提醒（请勿跳过）

这次交付中，**独立验证在"我自己写的闸门适配"里找出 9 个真实缺陷**，而当时的状态是：**编译通过、lint 干净、我自己写的 8 项契约测试全绿。**

最重的四个：

| 缺陷 | 后果 |
| --- | --- |
| 重放信任客户端声明的摘要（而不是从收到的字节重算） | 客户端复用同一 `submissionId` 提交**改动过的内容**并重发旧摘要 → 静默重放旧字节，**绕过 `SUBMISSION_CONFLICT` 保护** |
| 两个回收器用 `WHERE submission_id = ?` 更新 `receipts`，而主键是 `(user_id, submission_id)` | **跨用户把别人已完成的 receipt 翻成 `uncertain`** |
| `journal_mode = WAL` 在旧库检查**之前**执行 | **"拒绝打开旧库"这个动作本身改写了它拒绝的那个文件**，违反 `CONTRACTS §8.1` 明文禁令 |
| 上游响应体被拼进对外错误消息（`response.text.slice(0, 200)`） | 网关错误常回显请求行含 `?key=` → **密钥落库（`RunDto.error.message`）并回显给客户端** |

**结论：请独立验证，不要相信"绿"本身。** 具体做法：

- 每个声明要有**能因回归而失败**的测试；作者应实际把修复改回去、确认**只有该测试**失败。
- 安全边界、状态机、幂等路径必须有对抗性审查（这次用的是四路独立视角 + 每个发现三路反驳）。
- **注意自动反驳器会过度反驳**：本次 53 项原始发现里自动验证只让 2 项存活，而人工复审确认其中约 12 项是真缺口。**不要用自动过滤替代人工判断。**
- 区分"文档说的""代码写的""实测到的"。`PROTOCOL_MATRIX.md` 用证据等级标注，请沿用。

---

## 11. 文件所有权与变更状态

- **78 个变更路径，全部未提交、未推送。** 按 `BACKLOG_README`，提交、推送、部署、发布均需维护者单独授权。
- `BACKLOG_README.md` 的状态表已更新为 B01–B08 已完成、B08 为"当前临界路径（已实现，未验收）"。
- 每个任务文档末尾都有「实际验证」一节，记录**实际跑过的命令与结果、未验证项、遗留风险**。接手任何任务前先读那一节。
- **`AGENTS.md` 已重写**以匹配当前架构。注意它此前把已被取代的「profile ID as AAD」当作硬性安全约定，并通篇描述旧架构 —— 如果你是照旧版本写的代码，请重新对照。
- 契约层面：`CONTRACTS.md §9.1` 新增了**传输边界拒绝**（`421 HOST_REJECTED` / `403 ORIGIN_REJECTED`）—— 它们**不属于 API 错误码表**，由 `onRequest` hook 在任何 handler 之前直接应答，因此永不经过 `toPublicError`，也不会退化成 `500 INTERNAL`。

### 相关文档索引

| 文件 | 内容 |
| --- | --- |
| `CONTRACTS.md` | **冻结契约**。§8.0 私有 Row 字段、§9.1 传输边界拒绝 |
| `DECISIONS.md` | D1–D15 已确认决策、§3.3 已实测缺陷、§5 验证结果、**§7 范围影响** |
| `PROTOCOL_MATRIX.md` | 上游协议矩阵，带证据等级；**§4 是真实网关调用的实测记录** |
| `INTEGRATION_MANIFEST.md` | 模块责任、配置交接、共同基线发布条件 |
| `BACKLOG_README.md` | 任务表与总规则（`所有任务的完成约定` 一节必读） |
| `BACKLOG_00` … `BACKLOG_10` | 各任务清单与验证记录 |
| `REFACTOR_OUTLINE.md` | **原始讨论稿**。已被 D5/D15 覆盖，仅作历史参考 |
