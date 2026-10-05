# Runmesh 文档

[English](README.md)

按需要完成的任务选择指南。连接 MCP 客户端从用户指南开始，搭建实例从管理员指南开始。

## 开始使用

| 你要做什么 | 对应指南 |
| --- | --- |
| 连接 MCP 客户端并执行第一个任务 | [用户指南](user-guide.zh-CN.md) |
| 部署控制平面、添加机器和授予权限 | [管理员指南](admin-guide.zh-CN.md) |
| 连接 MCP、安装 Skill 并共享给 AI 客户端 | [MCP 和 Skill 指南](central-administration.zh-CN.md) |
| 完成 OAuth 登录或重新授权 MCP 账号 | [账号授权](central-oauth.zh-CN.md) |
| 准备 Skill 文件夹与更新内容 | [Skill 安装](central-skills.zh-CN.md) |
| 更新已有实例，同时保留数据和配置 | [升级指南](upgrading.zh-CN.md) |
| 排查连接、权限、安装和任务问题 | [故障排查](troubleshooting.zh-CN.md) |
| 查看版本变化与升级指引 | [版本说明](release-notes.zh-CN.md) |

## 安装与管理实例

添加计算机时，打开「Runner → 添加 Runner」，在目标机器上运行页面生成的安装命令。更新已有实例时，按[升级指南](upgrading.zh-CN.md)操作。

安装参考：[便携式安装（英文）](portable-runner-installation.md)、[系统要求](installer-prerequisites.zh-CN.md)、[运行时配置](runtime-config.zh-CN.md)、[部署参考（英文）](deployment.md)和[卸载（英文）](runner-uninstall.md)。

按[权限指南（英文）](permission-model.md)设置客户端和工作区的访问范围。[安全指南（英文）](security.md)介绍凭据保管、服务账号和主机隔离。

## 版本与功能

Runmesh 将已启用的 MCP 工具和 Skill 共享给已连接客户端。添加或更新后，刷新 AI 客户端的工具目录。需要读写文件或执行命令时，启用计算机访问，并在目标机器上安装 Runner。

安装包的可用状态见[发行状态](release-readiness.zh-CN.md)，已部署 Worker 的核对方法见[构建来源](build-provenance.zh-CN.md)。[开发预发布](dev-runner-prereleases.zh-CN.md)提供单独的测试渠道。

## 集成与维护

开发自定义集成时，可从[工具示例](tool-examples.md)、[MCP 调用约定（英文）](mcp-agent-call-contract.md)和[工具目录刷新（英文）](mcp-connector-refresh.md)开始。

[维护者文档](maintainers/README.zh-CN.md)汇总架构、开发、发版流程和历史审查记录。

安全问题按 [SECURITY.zh-CN.md](../.github/SECURITY.zh-CN.md) 私密报告。普通问题提供版本、操作、时间和脱敏错误代码；分享前检查附件中的凭据和私有输出。
