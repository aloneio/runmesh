# Runmesh Development Preview

## English

This Runmesh development preview is the first public development preview of the Runmesh Agent Control Plane.

This preview includes:

- a Cloudflare Worker and SQLite-backed Durable Object control plane;
- outbound-only Runner connectivity over authenticated WebSocket;
- Protocol v2 policy revision fencing and checksums;
- managed Workspace policy and fail-closed authorization;
- persistent Runner Jobs with bounded UTF-8-safe logs;
- the compact MCP surface for Runner, Workspace, inspect, read, edit, shell, and job operations;
- dedicated-user service layouts and a self-contained Runner package smoke path;
- source-available licensing under PolyForm Noncommercial License 1.0.0.

This is a development preview. Cross-platform native service installation, artifact update/rollback, and deployed Cloudflare behavior require validation in the target environment before operational use. `shell` is a host capability, not an operating-system sandbox.

Install and configure the control plane using the [README](../README.md) and [deployment guide](deployment.md). Community contributions are welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md) for the complete contribution terms and process.

Release assets include the Runner package, manifest, detached Ed25519 signature, trust keyring, SHA-256 checksums, license, NOTICE, and third-party notices. Verify the signature and checksums before installation.

Commercial use requires separate written authorization. See [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).

## 简体中文

本次 Runmesh 开发预览版是 Runmesh Agent Control Plane 的首个公开开发预览版。

本版本包含：

- Cloudflare Worker 与 SQLite-backed Durable Object 控制平面；
- 基于认证 WebSocket 的仅出站 Runner 连接；
- Protocol v2 策略版本 fencing 与 checksum；
- Managed Workspace 策略和 fail-closed 授权；
- 支持有界 UTF-8 安全日志的持久 Runner Job；
- 覆盖 Runner、Workspace、inspect、read、edit、shell、job 的精简 MCP 工具面；
- dedicated-user 服务布局和自包含 Runner package smoke 路径；
- PolyForm Noncommercial License 1.0.0 源码可见许可。

这是开发预览版。跨平台原生服务安装、artifact 更新/回滚以及已部署 Cloudflare 行为仍需在目标环境中验证后再投入运行。`shell` 是宿主机能力，不是操作系统 sandbox。

请参考 [README.zh-CN.md](../README.zh-CN.md) 和[部署文档](zh-CN/deployment.md)完成配置。欢迎社区贡献，请阅读 [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) 了解完整的贡献条款和流程。

Release assets 包含 Runner package、manifest、Ed25519 detached signature、trust keyring、SHA-256 checksums、许可证、NOTICE 和第三方通知。安装前请验证签名和校验和。

商业使用需要单独书面授权，请查看 [COMMERCIAL_LICENSE.zh-CN.md](../COMMERCIAL_LICENSE.zh-CN.md)。
