# 发行状态

[English](release-readiness.md) · [文档目录](README.zh-CN.md) · [版本说明](release-notes.zh-CN.md) · [升级指南](upgrading.zh-CN.md)

## 当前状态

**Runmesh 0.2.0 已是当前正式版。** 签名 Runner 安装包已发布并通过独立验证。新机器请使用已登录的 Runner 注册页面提供的安装命令；更新已有实例请按[升级指南](upgrading.zh-CN.md)操作。使用托管安装器前，请确认 Worker 的 `/runner/releases/stable` 返回 `distributable: true`。详见 [v0.2.0 正式版](https://github.com/aloneio/runmesh/releases/tag/v0.2.0)。

正式版激活绑定到 `release/release-state.json` 中经审核的源提交和清单摘要，不会仅凭版本号启用分发。

0.2.0 带来 Skill 重命名显示、删除后不可复用、MCP 状态提示和 Runner 管理改进。具体变化见[版本说明](release-notes.zh-CN.md)。

| 你要做什么 | 下一步 |
| --- | --- |
| 搭建新实例 | 按[管理员指南](admin-guide.zh-CN.md)部署控制端。 |
| 添加计算机 | 打开「Runner → 添加 Runner」，在目标机器上运行页面生成的安装命令。 |
| 连接 MCP 或安装 Skill | 阅读[MCP 和 Skill 指南](central-administration.zh-CN.md)。 |
| 更新已有实例 | 按[升级指南](upgrading.zh-CN.md)更新控制端和 Runner，再刷新 AI 客户端连接。 |
| 安装下载的 Runner 包 | 按[便携式安装指南（英文）](portable-runner-installation.md)操作。 |
| 体验后续改动 | 使用独立的[开发渠道](dev-runner-prereleases.zh-CN.md)。 |

兼容升级会保留现有连接、Runner、工作区和凭据。升级前请先阅读版本说明和升级指南。

维护者发布流程见[发布与激活流程（英文）](maintainers/release-process.md)。
