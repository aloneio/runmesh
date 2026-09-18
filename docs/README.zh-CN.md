# Runmesh 文档

[English](README.md)

按需要完成的任务选择指南。连接客户端或管理 Runner，不需要先阅读架构设计或审计报告。

## 开始使用

| 你要做什么 | 对应指南 |
| --- | --- |
| 连接 MCP 客户端并执行第一个任务 | [用户指南](user-guide.zh-CN.md) |
| 部署控制平面、添加机器和授予权限 | [管理员指南](admin-guide.zh-CN.md) |
| 更新已有实例，同时保留数据和配置 | [升级指南](upgrading.zh-CN.md) |
| 排查连接、权限、安装和任务问题 | [故障排查](troubleshooting.zh-CN.md) |
| 区分已发布功能与下一版改进 | [版本说明](release-notes.zh-CN.md) |

## 安装与安全运维

新 Runner 从管理员的注册页面开始安装。存在可用的已验证发行物时，页面会提供固定版本的安装命令。已有实例请先阅读升级指南，不要把重新注册或清空状态当作普通升级步骤。

高级安装参考：[便携包校验与安装](portable-runner-installation.md)、[安装依赖](installer-prerequisites.zh-CN.md)、[运行时配置](runtime-config.zh-CN.md)、[部署参考](deployment.md)和[彻底卸载](runner-uninstall.md)。部分高级参考目前使用英文。

开放命令执行前，请了解[安全模型](security.md)和[权限模型](permission-model.md)。工作区不是操作系统沙箱。MCP 地址、注册命令和 Runner 配置文件均应保密。

## 版本与功能

当前分支的文档可能描述尚未进入正式安装包的变化；版本说明会明确标注“尚未发布”。发布安装包、部署 Worker、升级 Runner 和刷新客户端缓存的工具定义，是四个独立步骤。使用新功能前，应核对整条链路。

[发行状态](release-readiness.md)说明经过审核的正式分发记录，不代表你的实例当前健康。[开发预发布](dev-runner-prereleases.zh-CN.md)属于单独的测试渠道，不会自动升级生产环境。

## 高级参考与维护者资料

集成开发可查看 [MCP 调用约定](mcp-agent-call-contract.md)、[工具示例](tool-examples.md)、[工具目录刷新](mcp-connector-refresh.md)和[能力契约](capability-contracts.zh-CN.md)及[工作区 Context 存储](context-storage.zh-CN.md)。维护者可查看[架构](architecture.md)、[验证流程](verification.zh-CN.md)和 [main 晋级策略](main-promotion-policy.zh-CN.md)。

[历史版本说明](maintainers/release-history.md)和[历史审计证据](maintainers/release-evidence.md)仅用于追溯，可能记录已退役的预览版、旧部署状态或未完成验证，不是当前操作指南。[旧版本迁移](migration.md)只适用于其中明确指出的数据边界，不能套用到普通 v2 升级。

安全问题按 [SECURITY.zh-CN.md](../.github/SECURITY.zh-CN.md) 私密报告。普通问题提供版本、操作、时间和脱敏错误代码，不附带凭据或私有输出。
