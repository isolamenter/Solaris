# Solaris 并行重构 Backlog

> **先读 [HANDOFF.md](HANDOFF.md)** —— 它说明当前实际完成了什么、**什么还没被证明**、以及下一步卡在哪。
> 本文件是任务计划与总规则；`HANDOFF.md` 是接手入口。

基线：[重构大纲](REFACTOR_OUTLINE.md)、[决策](DECISIONS.md)、[契约 v3 实施候选](CONTRACTS.md)及[集成清单](INTEGRATION_MANIFEST.md)。本目录用于给独立 coding agent 分配工作，不代表所有技术选型已获确认。B00–B08 已实现；真实环境验收未做。

## 如何分配

B00 主体调查已完成；按 D5/D15 删除视频与 Batch，只保留同步单次生成。B01 v3 文档已更新，但真实接口和共同基线尚未冻结；先落实契约，再开并行实现。outputCount、跨设备仅元数据及 D9–D13 建议项按未决状态处理。B01 的共享接口冻结并合入同一基线后，才能启动实现波次。每个 agent 阅读本文件、项目 `AGENTS.md`、重构大纲及自己的任务文档。

| ID | 文档 | 依赖 | 可以并行的工作 |
| --- | --- | --- | --- |
| B00 | [范围与决策](BACKLOG_00_DECISIONS.md) | 无 | 只读调查；不启动依赖选型的实现 |
| B01 | [共享契约与扩展边界](BACKLOG_01_CONTRACTS.md) | B00 决策确认 | **已完成**（代码冻结，基线绿）|
| B02 | [Server 数据与归属](BACKLOG_02_PERSISTENCE.md) | B01 | **已完成** |
| B03 | [身份与凭证](BACKLOG_03_AUTH_CREDENTIALS.md) | B01 | **已完成** |
| B04 | [模型服务适配](BACKLOG_04_PROVIDERS.md) | B01 | **已完成** |
| B05 | [单次生成编排](BACKLOG_05_TASKS.md) | B02、B03、B04 | **已完成** |
| B06 | [桌面与本地数据](BACKLOG_06_DESKTOP.md) | B01、桌面选型确认 | **已完成**（macOS 已构建；Windows 未验证）|
| B07 | [React 远程工作流](BACKLOG_07_CLIENT.md) | B03、B04、B06 | **已完成** |
| B08 | [远程 API 与安全集成](BACKLOG_08_INTEGRATION.md) | B02 至 B07（**均已满足**） | **当前临界路径**：loopback/same-origin 未替换前桌面链路完全不可用 |
| B09 | [内部 SSO 与 NewAPI](BACKLOG_09_INTERNAL.md) | B08 公开链路验收、内部协议确认 | B10 的公开文档和打包 |
| B10 | [macOS 与自托管交付](BACKLOG_10_RELEASE.md) | B08；内部验收部分依赖 B09 | B09 |

## 文件所有权与交接

- 每份任务拥有正文指定的文件；不修改其他 agent 的所有权范围。新目录是建议，最终位置由 B01 的接口清单确定。
- `src/shared/contracts.ts`、`src/server/providers/types.ts` 由 B01 独占；后续需要改契约，提交明确变更申请，由契约负责人串行更新并通知所有消费者。
- `src/server/db/` 和 `repository.ts` 由 B02 独占；B03 的身份存储、B05 的任务存储通过冻结的 repository 接口使用，不各自增加数据库或迁移。
- `src/server/http/app.ts`、`http/security.ts`、`main.ts`、`env.ts`、`errors.ts`、`.env.example`、`package.json`、`package-lock.json`、根级构建配置由 B08 独占。B01 收集各任务所需的依赖和启动命令，B08 在第一波开始前串行落地必要配置；最后再接线并替换旧路径。B08 不得在替代安全控制完成前开放远程监听。
- B03 提供认证路由注册模块，B05 提供单次业务服务/有界内存缓存，B06 提供桌面接口；B08 负责组合。不要让多个 agent 各自重写 `createApp()`。
- B06 拥有桌面层和 `src/client/local/`；B07 拥有其他 Client 文件，不改桌面实现。
- 使用独立 Git worktree/分支；开工前查看工作区状态，保留已有修改。共享配置补丁合入基线后再启动消费者。不要在同一目录并发安装依赖、修改 lockfile 或暂存提交。
- 分配者串行更新任务状态和依赖表。agent 只在自己文档中记录完成项及交接，不宣称其他任务已完成。

## 所有任务的完成约定

- 使用勾选框记录完成项；交接附文件列表、接口变化、实际验证命令及结果、未解决问题。
- 代码改动运行最窄相关测试，再运行 `npm run typecheck` 与 `npm run lint`；桌面层执行对应工具检查。集成和交付阶段再执行完整构建与端到端检查。
- 测试替身只能验证隔离行为，不作为真实 SSO、模型服务、计费、安装或跨平台验收证据。未运行的环境明确标注未验证。
- 不默认添加旧模式兼容、凭证回退、跨服务重试或双实现。参数 schema 保持 strict，Key 只写不可回读。
- 无上游幂等证据时，提交结果不明不得自动重提。生成成功、结果交付和本设备落盘分别表达；缓存不能保证重启后恢复图片。删除历史不能解除去重。
- 维护者只授权生成这些 backlog；执行代码、提交、部署等按后续实际任务授权进行，不把 backlog 当作发布授权。

## 可复制的 agent 指令

> 阅读 `.docs/BACKLOG_README.md`、`.docs/REFACTOR_OUTLINE.md`、`AGENTS.md` 和分配给你的 backlog。先核对 CONTRACTS v3、INTEGRATION_MANIFEST、依赖产物与冻结接口，只实现本任务拥有的文件。缺少必要决策时继续不依赖该决策的调查，明确提出阻塞点，不自定选型。按清单实现并验证，交接说明实际证据与剩余风险。不要修改其他任务文件、推送或部署。

## 已知限制

`.docs` 当前被 `.gitignore` 忽略，本批文档保留在本地。分配到其他机器或 worktree 时，需显式传递本目录；不能假设 Git checkout 会包含这些文件。

## 本轮范围和验收调整

- B05 改为单次生成/状态/幂等重放；删除旧 runner，不修复将被移除的 Batch 生命周期。
- B06/B07 按 LocalScope 隔离账号与 Server；不再要求 Batch 下载恢复或跨设备图片取回。
- B08 验收完整调用超时、active run 保护、内存缓存失效、旧库无自动删除。
- B10 不提供旧数据迁移工具，只说明新目录运行、macOS 交付与证据边界。
- B01 仅负责纯契约测试；repository、认证、provider、HTTP 和真实服务测试由实现任务负责。
