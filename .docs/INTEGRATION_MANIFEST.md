# 并行集成清单

版本：配套 CONTRACTS v3 实施候选。真实类型/配置/依赖尚未落地，本文件不等于代码冻结。

## 模块责任

| 产物 | 实现者 | 消费者 | 接线/共享变更 |
| --- | --- | --- | --- |
| DTO、Zod 契约、摘要工具与固定向量 | B01 | B02–B08 | B01 串行发布 |
| 服务端 Row、AuthAdapter、SessionService、CredentialSource 类型 | B01 | B02/B03/B05/B09 | B01 独占接口，B03 提供实现 |
| LocalScope/DraftRecord/LocalRunRecord/LocalStore/DesktopLogin 类型 | B01 | B06/B07 | 类型独立于 B06 实现目录 |
| repository 与新 schema | B02 | B03/B05/B08 | B02 独占数据库 |
| OIDC、一次性事务、会话、user-key 来源/vault | B03 | B05/B08 | B08 注册 HTTP 模块 |
| Gemini 单次 ProviderPlugin 实现 | B04 | B05/B08 | B04 注册模型适配器，封闭类型变更交 B01 |
| 同步编排、内存缓存与 active runs | B05 | B08/B07 | B08 负责 lifecycle/HTTP 接线 |
| 原生 DesktopLogin 和 LocalStore | B06 | B07 | B08 落地根构建配置 |
| React/typed API | B07 | 桌面用户 | 按共享类型消费，不改 native 实现 |
| env/路由/安全/依赖/根构建/e2e/smoke | B08 | 所有工作树 | 串行落地配置后再并行 |
| 内部认证与外部凭证来源 | B09 | 同一 B05/B08 核心 | B01/B08 串行注册类型/配置 |
| macOS 产物/公开教程/验收报告 | B10 | 部署者 | 根配置补丁交 B08 |

新接口文件建议：共享 DTO/digest 留 src/shared；服务端 auth/credential/repository Row 接口放独立 server 类型文件；Client 内部 LocalStore 类型放独立共享类型文件，由 B01 持有。不把 server secret/Buffer 类型导入 Client。最终路径在 B01 代码冻结时回写，不要求为“接口统一”创建通用框架。

## 配置与依赖交接

- B03 提交 OIDC 库、scope/state/PKCE/nonce 所需 schema、会话与登录事务预算；不自行改 package/lockfile/env。
- B04 提交完整超时、原始响应读取与图片解码预算、出站策略要求。
- B05 提交缓存 TTL/字节预算、active 与恢复模块的启动/关闭方法。
- B06 提交 Tauri v2/macOS、安全存储/SQLite/文件/回环能力所需原生和 Node 依赖、权限与构建命令。
- B08 在已确认方案下选择具体依赖版本并锁定；没有确认的第三方包不在此文档编造。配置键见 CONTRACTS §13。

## 共同基线发布条件

- [x] B01 真实类型/schema/摘要代码、方法签名与 CONTRACTS 一致，尚缺的 Row/旧消费者调整已完成。（2026-09-29：`shared/contracts.ts`、`shared/digest.ts`、`shared/local.ts`、`server/interfaces.ts`、`providers/types.ts`、`db/`、`repository.ts`、`resultCache.ts`、`services.ts`、`http/app.ts`、`main.ts`、`env.ts`、`src/client/**` 已落地）
- [ ] B08 依赖配置串行落地，所有 worktree 从同一提交起步。**未开始**；B02/B04 不需新依赖可直接开工，B03（OIDC 校验库）与 B06（Tauri 工具链）的依赖选择需维护者确认，不自行编造。
- [x] typecheck/lint 通过；focused 契约测试通过，既有失效测试有明确归属修订，不用跳过测试隐藏冲突。（typecheck 0 错误；eslint 通过；`vitest run` 56/56；`npm run build` 通过；另有 14 项运行期校验全过。归属修订：`services.image.test.ts` 删除→B05 重写服务测试；`e2e/local-boundary.spec.ts` 删除→B08 重写，且服务在 B03 就位前拒绝启动故 e2e 暂不可运行）
- [x] outputCount/跨设备产品未决有明确执行边界，相关实现不得声称完成验收。（`outputCount` 保持 Solaris 侧截断、控件未冻结；`RunDto` 无字节字段，跨设备仅元数据）
- [ ] 并行启动 B02/B03/B04/B06；需要改共享接口时集中串行处理，不各自打补丁。**待 B03/B06 依赖确认后启动；B02/B04 无阻塞**


## 集成前交接要求

每任务提供模块导出/调用示例、实际文件清单、fixture 范围、focused test 结果和未实测环境。实现被测行为的任务拥有对应测试，不由 B01 包办领域/HTTP 测试。共享配置统一经 B08，各工作树不并发改 lockfile。

候选预算由 B04/B08 实测后更新契约和公开配置；选定运行环境的真实 IdP/模型收费请求依实际授权进行。纯 fixture 通过不意味着 B08 公开链路验收或 B09 内部验收完成。
