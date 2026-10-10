# 维护者文档

[English](README.md) · [用户文档](../README.zh-CN.md)

开发 Runmesh、集成管理接口或准备发版时，使用以下参考资料。

## 架构与接口约定

- [架构（英文）](../architecture.md)与[依赖检查（英文）](../architecture-gates.md)
- [架构决策（英文）](../adr-0001-architecture.md)、[基础边界（英文）](../foundation-boundaries.md)与[协议（英文）](../protocol.md)
- [Runner 边界](../runner-boundaries.zh-CN.md)、[Runner 传输（英文）](../runner-transport.md)与[Registry 领域](../registry-domains.zh-CN.md)
- [中央 MCP 与 Skill 架构](../central-capabilities-architecture.zh-CN.md)
- [控制端接口](central-administration.zh-CN.md)、[MCP 传输](central-remote-mcp.zh-CN.md)、[OAuth](central-oauth.zh-CN.md)与[Skill 存储](central-skills.zh-CN.md)
- [目录快照](../central-catalog.zh-CN.md)、[能力契约](../capability-contracts.zh-CN.md)与[工作区 Context 存储](../context-storage.zh-CN.md)
- [MCP 输出契约](../mcp-output-contracts.zh-CN.md)、[字节分页](../byte-pagination.zh-CN.md)与[绑定游标](../bound-cursors.zh-CN.md)
- [管理视图边界](../admin-view-boundaries.zh-CN.md)与[界面本地化](../ui-localization.zh-CN.md)

## 开发与发版

- [验证流程](../verification.zh-CN.md)
- [Runner 开发渠道](../dev-runner-prereleases.zh-CN.md)
- [main 分支晋级](../main-promotion-policy.zh-CN.md)
- [分支保护（英文）](../BRANCH_PROTECTION.md)与[发版预检（英文）](../runbooks/release-preflight.md)
- [发布与激活流程（英文）](release-process.md)
- [中央功能验收（英文）](../central-rollout.md)
- [MCP 重新授权（英文）](../mcp-reauthorization.md)与[成本测量（英文）](../cost-baseline.md)

## 历史记录

- [历史版本说明（英文）](release-history.md)
- [历次审查记录（英文）](release-evidence.md)
- [早期版本迁移（英文）](../migration.md)
- [main 生产切换（英文）](../production-main-cutover.md)与[旧 Durable Object 退役（英文）](../retire-legacy-production-do.md)
- [正确性审查（2026-09-15，英文）](../review-correctness-20260915.md)与[开发版产品审查（2026-09-25，英文）](../dev-product-readiness-20260925.md)
- [优化记录（英文）](../optimization-ledger.md)

历史记录对应各文档注明的版本与日期。更新现有实例时，按当前[升级指南](../upgrading.zh-CN.md)和[发行状态](../release-readiness.zh-CN.md)操作。
