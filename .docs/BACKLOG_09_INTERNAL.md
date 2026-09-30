# B09 — 内部 SSO、外部凭证与 NewAPI

状态：等待公开链路与内部协议。
依赖：B08 公开验收、内部协议确认；可与 B10 并行。
基线：[CONTRACTS v3](CONTRACTS.md)、[决策记录](DECISIONS.md)；总规则见 [BACKLOG_README](BACKLOG_README.md)。

## 范围与文件所有权

新增内部适配模块/测试、INTERNAL_INTEGRATION.md；注册/封闭类型交 B01，环境接线交 B08。只做同步单次生成范围；不改其他 agent 拥有的文件。

## 执行清单

- [ ] 核对内部身份稳定主体、登录验证、Key 获取及寿命，分别实现 AuthAdapter/CredentialSource。
- [ ] 不修改 desktop-code 流程或 Client，不强迫内部认证配置 OIDC 参数，不按邮箱猜测用户。
- [ ] NewAPI 协议与 Gemini 已适配时只配置复用；不同协议确有证据才加适配器，不做兼容回退。
- [ ] 所测实例 Batch 探测失败仅是记录，本期本就删除 Batch；不新增内部队列或视频。
- [ ] 内部域名/密钥专有参数配置注入，公开例子只占位；凭证解析失败不自动改用用户 Key。
- [ ] 真实身份/连接隔离、撤销/过期、单次生成与本地保存分层验证，核心不出现内部专用分支。

## 验收与交接

- [ ] 公开/内部共用同一 Client/API 与单次生命周期，变化局限适配器和配置。
- [ ] 明确内部 fixture 与真实服务验收差距，没有环境不声称可用。

验证：focused adapter tests → typecheck → lint；收费调用/部署另按实际授权。

交接记录实际修改文件、接口版本、检查命令/结果、未验证环境及剩余风险。本文复选框是修订后的当前任务，不把旧调查完成误认为实现完成；B00 的历史调查证据保留在 DECISIONS。
