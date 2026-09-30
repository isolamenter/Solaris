# B05 — 单次生成编排与幂等重放

状态：**已完成（2026-09-29）**，见文末验证记录。
依赖：B02/B03/B04；与 B07 并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

services.ts、旧 runner.ts 的删除、assets.ts Server 持久化路径删除、相关服务测试及独立运行/缓存模块。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 按统一接口校验身份、连接、参数与参考图，重算摘要；receipt 认领只有一个请求调用上游。
- [x] 重放先查既有 receipt，不因原连接删除/禁用又发上游；统一 GenerationResponseDto，running 返回 202/pending。
- [x] 消费 Provider outcome，明确 success/error/uncertain；错误交付不等于生成失败，预算截断不静默丢图。
- [x] 实现按用户/提交隔离的有界内存结果缓存，成功发布与状态记录协调；LRU/TTL/重启失效明确不可取。
- [x] 删除历史调用 repository 并清缓存，保留去重凭据；显式新运行必须新 ID，不自动重提未知结果。
- [x] 维护 active run 集合和调用结束清理，提供启动恢复/周期陈旧检查接口；扫描不误判活跃运行，不发上游轮询。
- [x] 删除所有视频/Batch 编排、旧 VideoRunner 和服务测试；无 Server 图片文件、asset ID/素材库依赖。
- [x] 日志/错误使用安全输出；交付与 Client 本地保存分开，不承诺离线恢复图片。

## 验收与交接

- [x] 并发、终态重放、历史删除和摘要冲突测试断言上游调用次数；未知结果不再调用。
- [x] 缓存命中交付字节，失效/清除/重启返回 unavailable；活跃慢请求不被回收误判。
- [x] 生成/预算/零图/网络异常分类一致，Server 数据目录和 DB 不含图片字节。

验证：focused service tests → typecheck → lint；生命周期和真实公开联调归 B08。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

- 聚焦：`npx vitest run src/server/services.replay.test.ts src/server/services.lifecycle.test.ts src/server/resultCache.test.ts` → 42 项通过
- `npx tsc --noEmit` → 0 错误；`npx eslint .` → 通过；`npx vitest run` → **320 项通过**

**新增**：`services.replay.test.ts`(20)、`services.lifecycle.test.ts`(12)、`resultCache.test.ts`(10)。改动 `services.ts`、`resultCache.ts`（移除无调用者的 `clearAll`）。未编辑任何既有测试。

### 发现并修复的缺陷（均在 B01 草稿中）

1. **重放信任了客户端声明的摘要。** 冲突检查拿 receipt 里存的摘要去比 `input.contentDigest`（客户端声明的值），而不是与**从实际收到的字节重算**的摘要比。因此客户端复用同一 submissionId 提交**改动过的内容**、同时重发旧摘要时，会得到静默重放（返回旧字节）而非 `409 SUBMISSION_CONFLICT`——直接违反 §6.1「Server 从收到的真实输入重算 contentDigest」与 §6.3「内容变化仍冲突」。修复：receipt 路径改为重算并比对；新请求仍校验声明值（`DIGEST_MISMATCH`）。证明测试：`detects changed content even when the client re-sends the digest of the old content`（把草稿那行改回去，**只有**该测试失败）。
2. **`operations.imageGenerate` 在 `claimRun` 之后才解析**，导致适配器没有该操作时会留下**幽灵 `running` run + `running` receipt**（客户端会一直收到 202 pending），而那次调用根本没发生。修复：先解析操作，`OPERATION_UNAVAILABLE` 变成不建 run 的执行前 400。

### 证明的核心不变量

上游调用次数为断言核心（并发重复用门控 stub 真实交错、终态重放、删历史后重放、摘要冲突 0 次调用、崩溃窗口收敛后重放 0 次调用）；重放先于当前资源解析（连接被禁用/删除后仍可重放）；§6.2 表逐行（含 over-budget 保持 `success` + `result-too-large` 绝不降级为 error）；缓存「先发布后标 success」用 `HandoffRepository` 在 `finishRun(success)` 那一刻**检视缓存**来证明（反向顺序会使该测试失败）；LRU/TTL/重启 → `cache-miss`；**在途慢请求不被回收**（先断言该行按时间确实已够旧，再断言 `reapStaleRuns` 返回空）；两个扫描器 0 次上游调用；`uncertain` 终态；**全周期后数据目录、DTO、console 均无图片标记/base64/API Key**。

### 未能验证

HTTP 状态映射（202 vs 200）在 `http/app.ts`（B08 所有物），B05 只在 DTO 层断言 `result.kind === "pending"`；真实上游/IdP 行为与 B08 的生命周期接线（回收间隔、停机策略、信号处理）；多进程（契约规定单进程独占数据目录）。

### 遗留风险

1. **非 `ProviderCallError` 从适配器逃逸时，run 会停在 `running` 并对外表现为 INTERNAL 500**，只能靠周期回收器收敛（B08：60s 间隔、15min 陈旧阈值）。此时该 run 可被查询为 202/pending。属有意为之（分类需要证据，边界归 B04），但确实存在一个悬而未决的窗口。
2. 重放路径会先对收到的参考图字节做哈希——这正是缺陷 1 的修复所依赖、也是 §6.1 要求的，代价是重试时的 CPU（受传输上限约束：14 文件 / 10 MiB / 总计 14 MiB）。
3. 若适配器返回空图片列表，服务会记 success 且零图。冻结的 gemini 适配器改为抛 `UPSTREAM_NO_IMAGE`，故今天不可达；未加守卫（会是重复 B04 分类的死代码）。
4. `active` 集合是每服务实例的；两个进程共用一个数据目录时各自只排除自己的 run。
