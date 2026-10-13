# 发行状态

[English](release-readiness.md) · [文档目录](README.zh-CN.md) · [版本说明](release-notes.zh-CN.md) · [升级指南](upgrading.zh-CN.md)

## 当前正式版：0.1.10

[Runmesh 0.1.10](https://github.com/aloneio/runmesh/releases/tag/v0.1.10) 已发布，提供签名便携 Runner 安装包。本版让 Runner 维护和发行物下载在响应即将结束时继续保持取消状态，中断更新会保留中断结果，可在同一安装上安全重试。具体变化见[版本说明](release-notes.zh-CN.md)。

0.1.9 安装包仍可从 [GitHub Releases](https://github.com/aloneio/runmesh/releases) 获取，适用于需要继续运行该版本的实例。

| 你要做什么 | 下一步 |
| --- | --- |
| 搭建新实例 | 按[管理员指南](admin-guide.zh-CN.md)部署控制端、连接 MCP 和安装 Skill。 |
| 添加计算机 | 打开「Runner → 添加 Runner」，在目标机器上运行页面生成的命令。 |
| 更新已有实例 | 按[升级指南](upgrading.zh-CN.md)更新控制端和 Runner，再刷新 AI 客户端的工具目录。 |
| 使用下载的安装包 | 按[便携式安装指南（英文）](portable-runner-installation.md)校验并安装签名包。 |
| 体验后续改动 | 使用独立的[开发渠道](dev-runner-prereleases.zh-CN.md)。 |

升级时保留现有 Cloudflare 资源、部署密钥和 Runner 配置，以继续使用已有账号连接、已注册机器和工作区设置。已有安装请先按[升级指南](upgrading.zh-CN.md#更新已安装的版本管理器)刷新管理器，再选择 Runner 版本。

## 查看已安装的版本

控制端的 `/health` 返回运行中的版本，`/runner/releases/stable` 列出当前实例选用的正式 Runner 包。按[构建来源](build-provenance.zh-CN.md)核对部署源码，并按[升级指南](upgrading.zh-CN.md)确认 Runner 服务版本。

[Runmesh 0.1.9](https://github.com/aloneio/runmesh/releases/tag/v0.1.9) 及更早的签名版本仍可从 [GitHub Releases](https://github.com/aloneio/runmesh/releases) 下载。已有实例的恢复步骤见升级指南。

维护者可按[发布与激活流程（英文）](maintainers/release-process.md)操作。
