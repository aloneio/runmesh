# Runmesh v0.1.0-dev.2 Development Preview

## English

This development preview packages the currently supported Runmesh Agent Control Plane capabilities.

This preview includes:

- a Cloudflare Worker and SQLite-backed Durable Object control plane;
- outbound-only Runner connectivity over authenticated WebSocket;
- immutable desired and active Policy snapshots with revision/checksum verification, stale-ack protection, and fail-closed policy admission while a policy is pending, offline, invalid, or mismatched;
- centrally managed Workspace policy and fail-closed authorization;
- persistent Runner Jobs with bounded UTF-8-safe logs and retained Registry metadata;
- the compact MCP surface for Runner, Workspace, inspect, read, edit, shell, and job operations;
- dedicated-user service provisioning and a manually verifiable portable Runner package path; and
- source-available licensing under PolyForm Noncommercial License 1.0.0.

This is a development preview. Target-environment validation remains necessary for cross-platform service behavior and deployed Cloudflare behavior. Hosted bootstrap, automatic Runner update, and rollback are not included. `shell` is a host capability, not an operating-system sandbox.

Install and configure the control plane using the [README](../README.md) and [deployment guide](deployment.md). Community contributions are welcome; see the [contribution guide](../CONTRIBUTING.md) for the complete contribution terms and process.

Release assets include the Runner package, manifest, detached Ed25519 signature, trust keyring, SHA-256 checksums, license, NOTICE, and third-party notices. Verify the signature and checksums before installation.

Commercial use requires separate written authorization. See [COMMERCIAL_LICENSE.md](../COMMERCIAL_LICENSE.md).

## Runmesh v0.1.0-dev.2 开发预览版

本开发预览版提供当前已支持的 Runmesh Agent Control Plane 能力。

本版本包含：

- Cloudflare Worker 与 SQLite-backed Durable Object 控制平面；
- 基于认证 WebSocket 的仅出站 Runner 连接；
- 不可变的 Desired 与 Active Policy 快照，包含 revision/checksum 校验、过期 ACK 保护，以及在策略 pending、offline、invalid 或不一致时 fail-closed 的准入控制；
- 集中管理的 Workspace 策略和 fail-closed 授权；
- 带有界 UTF-8 安全日志和保留 Registry 元数据的持久 Runner Job；
- 覆盖 Runner、Workspace、inspect、read、edit、shell、job 的精简 MCP 工具面；
- dedicated-user 服务配置以及可手动验证的便携式 Runner package 路径；以及
- PolyForm Noncommercial License 1.0.0 源码可用许可。

这是开发预览版。跨平台服务行为和已部署 Cloudflare 行为仍需在目标环境中验证。Hosted bootstrap、Runner 自动更新和回滚尚未包含。`shell` 是宿主机能力，不是操作系统 sandbox。

请参考 [README.zh-CN.md](../README.zh-CN.md) 和[部署文档](deployment.md)完成控制平面的安装和配置。欢迎社区贡献，请阅读[贡献指南](../CONTRIBUTING.zh-CN.md)了解完整的贡献条款和流程。

Release assets 包含 Runner package、manifest、Ed25519 detached signature、trust keyring、SHA-256 checksums、许可证、NOTICE 和第三方通知。安装前请验证签名和校验和。

商业使用需要单独书面授权，请查看 [COMMERCIAL_LICENSE.zh-CN.md](../COMMERCIAL_LICENSE.zh-CN.md)。
