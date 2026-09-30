# B02 — 用户数据、运行历史与去重凭据

状态：**已完成（2026-09-29）**，见文末验证记录。
依赖：B01；与 B03/B04/B06 并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

src/server/db/、repository.ts 及存储测试；不改认证或服务编排。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [x] 实现用户、issuer/subject 身份唯一性、会话哈希、用户连接与模型；UUID 写入校验、约束和 DDL 保持一致。
- [x] 运行保存提示词/参数/原目标快照/图片元数据，不接收图片字节或原始响应。
- [x] 以事务及唯一 (userId,submissionId) 认领 receipt+run；重复只读原记录，摘要冲突原子失败。
- [x] 实现终态条件更新，同事务同步 receipt；资源业务接口始终带 userId，越权为 NOT_FOUND。
- [x] 删除历史移除完整输入/元数据但保留最小 receipt；running 拒绝删除。连接/模型删除保留历史快照，在途依赖拒绝删除。
- [x] 启动遗留 running 收敛、周期扫描排除 active IDs；不建 jobs/batch 表，不发上游请求。
- [x] 删除旧视频/Batch 表及 repository 方法；旧 schema 拒绝打开并提示空新目录，不自动删除旧库/图片，不做双读或迁移工具。

## 验收与交接

- [x] 并发重复只认领一次；不同用户同 ID 不串用；删除历史后同提交不会重新认领。
- [x] 用户 A 无法访问 B 连接/模型/历史；发现刷新保留手动模型和稳定 ID。
- [x] 临时 DB 关闭/重开可见 receipt；旧库检测不破坏原文件；所有测试关闭 SQLite 并清理临时目录。

验证：focused repository tests → typecheck → lint。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。

---

## 实际验证（2026-09-29 实跑，交接自实现 agent）

- `npx vitest run src/server/repository.test.ts src/server/db/storage.test.ts` → 28 passed
- `npx tsc --noEmit` → 0 错误；`npx eslint .` → 通过；`npx vitest run` → 111 passed

**发现并修复的缺陷（每条都由新测试证明；其中 3 条源自 B01 的基线适配）：**

1. **旧库拒绝本身会改写它拒绝的那个文件** —— `journal_mode = WAL` 在检查之前执行，实测 `sha256(solaris.sqlite)` 在拒绝时发生变化。这是 B01 基线适配引入的。修：先探测、后设 pragma。
2. **两个回收器会跨用户破坏 receipt** —— `recoverAbandonedRuns`/`reapStaleRuns` 用 `WHERE submission_id = ?` 更新 `receipts`，而主键是 `(user_id, submission_id)`，会把**用户 B 已完成的** receipt 翻成 `uncertain`。同为 B01 引入。
3. **发现刷新会重新生成每个 model 行 ID**（先删后插 → 每次刷新新 UUID），违反 §3「保留已有模型行 ID」，并会把手动模型 `manual` 翻成 false。
4. `schema.ts` 的 drizzle 镜像删除：无任何查询使用 drizzle，`orm` 无消费者，也没有 drizzle-kit 与配置，属于纯漂移风险。**跟进：`drizzle-orm` 已由协调者从 `package.json` 移除。**

**未能验证**：带未回收 `-wal` 的旧库（非干净关闭）；真正的多进程并发（单进程独占数据目录，超出契约范围）。

**遗留风险**：`receipts`/`runs` 的 `submission_id` 无 UUID CHECK（须由 B08 在 HTTP 边界校验）；跨用户游标不会被识别为非法（只是读不到别人行）；`findSessionByTokenHash` 不校验过期（归 B03）；发现刷新在有在途运行时返回 `RESOURCE_IN_USE`，慢生成期间 UI 刷新会 409。
