# Runmesh 文档

[English](README.md)

按需要完成的任务选择指南。连接 MCP 客户端从用户指南开始，搭建实例从管理员指南开始。

## 开始使用

| 你要做什么 | 对应指南 |
| --- | --- |
| 连接 MCP 客户端并执行第一个任务 | [用户指南](user-guide.zh-CN.md) |
| 部署控制平面、添加机器和授予权限 | [管理员指南](admin-guide.zh-CN.md) |
| 更新已有实例，同时保留数据和配置 | [升级指南](upgrading.zh-CN.md) |
| 排查连接、权限、安装和任务问题 | [故障排查](troubleshooting.zh-CN.md) |
| 区分已发布功能与下一版改进 | [版本说明](release-notes.zh-CN.md) |

## 安装与安全运维

新 Runner 从管理员的注册页面开始安装。存在可用的已验证发行物时，页面会提供固定版本的安装命令。更新已有实例请按升级指南操作，保留现有凭据、配置和数据。

高级安装参考：[便携包校验与安装](portable-runner-installation.md)、[安装依赖](installer-prerequisites.zh-CN.md)、[运行时配置](runtime-config.zh-CN.md)、[部署参考](deployment.md)和[彻底卸载](runner-uninstall.md)。部分高级参考目前使用英文。

授予访问权限前，请了解[安全模型](security.md)和[权限模型](permission-model.md)。命令使用 Runner 服务账号的系统权限；运行不受信任的代码时，使用容器或虚拟机。MCP 地址、注册命令和 Runner 配置文件均应妥善保管。

## 版本与功能

最新已发布正式版为 **0.1.5**，本文档介绍该版本的功能。使用新功能时，需要部署兼容 Worker、安装对应 Runner 包，并刷新客户端工具目录。

安装包的可用状态见[发行状态](release-readiness.md)，已部署 Worker 的核对方法见[构建来源](build-provenance.zh-CN.md)。[开发预发布](dev-runner-prereleases.zh-CN.md)提供单独的测试渠道。

## 高级参考与维护者资料

仅用于开发：[中央 MCP 与 Skill 基础架构](central-capabilities-architecture.zh-CN.md)
说明新增身份、授权和模块边界，不代表已经启用上游集成，也不是 Skill 安装指南。

集成开发可查看 [MCP 调用约定](mcp-agent-call-contract.md)、[工具示例](tool-examples.md)、[工具目录刷新](mcp-connector-refresh.md)、[能力契约](capability-contracts.zh-CN.md)和[工作区 Context 存储](context-storage.zh-CN.md)。维护者可查看[架构](architecture.md)、[验证流程](verification.zh-CN.md)和 [main 晋级策略](main-promotion-policy.zh-CN.md)。

[历史版本说明](maintainers/release-history.md)和[历史审计证据](maintainers/release-evidence.md)用于追溯各文档注明的版本和审查时段。[旧版本迁移](migration.md)介绍早期开发版与进入 v2 时的转换；当前 v2 实例请使用升级指南。

安全问题按 [SECURITY.zh-CN.md](../.github/SECURITY.zh-CN.md) 私密报告。普通问题提供版本、操作、时间和脱敏错误代码；分享前检查附件中的凭据和私有输出。
