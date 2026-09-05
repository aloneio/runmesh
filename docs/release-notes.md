# Runmesh 0.1.0-dev.2 版本说明

这是一个开发预览版，适合在受控环境试用。升级前请先备份 Worker 配置和 Runner 本地目录，并在一台测试机器上验证。

## 对用户可见的改进

- 统一的 Dashboard、Runner、MCP 客户端和设置页面；
- MCP 客户端可以明确查看、选择和确认目标 Runner；
- 工作区权限支持读取、修改、命令执行和任务控制的分别授权；
- 长任务在浏览器关闭或短暂断线后继续运行，并可分页查看日志；
- Runner 支持 Linux、macOS 和 Windows 的服务安装与健康检查；
- 安装命令使用固定版本和签名校验，避免从不明来源下载程序；
- MCP 地址、注册码和 Runner 凭据支持一次性显示、轮换与撤销；
- 路径检查拒绝越界访问、设备路径和符号链接逃逸。

## 使用前请了解

- `shell` 使用 Runner 服务账号的操作系统权限，不是容器或虚拟机沙箱；
- 自动升级、自动回滚、多租户组织、计费、托管 IDE、浏览器自动化和模型 API 不属于当前版本；
- hosted bootstrap 只有在固定签名版本、外部 HTTPS 地址和部署门控同时满足时才会显示；
- Cloudflare 配额、Durable Object 迁移、Windows/macOS 原生服务和外部 MCP 客户端仍需在目标环境验收。

## 安装和升级

管理员请先阅读[管理员指南](admin-guide.zh-CN.md)。无法使用托管安装器时，请使用[便携式安装流程](portable-runner-installation.md)并独立校验发布包。

## English

This is a development preview for controlled evaluation. It adds a unified dashboard, explicit Runner selection, per-workspace permissions, persistent jobs with bounded logs, cross-platform service provisioning, signed fixed-release installation, credential rotation, and path-safety checks.

`shell` runs with the Runner service account's host permissions and is not a sandbox. Automatic upgrades and rollback, multi-tenant organizations, billing, hosted IDEs, browser automation, and model APIs are outside this release. Validate Cloudflare quotas, Durable Object migrations, native service lifecycle behavior, and your MCP clients before production use.

See the [administrator guide](admin-guide.md) and [portable installation procedure](portable-runner-installation.md).
