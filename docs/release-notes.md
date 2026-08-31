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
- dedicated-user service provisioning and a fixed signed hosted-bootstrap path gated on explicit release availability; and
- source-available licensing under PolyForm Noncommercial License 1.0.0.

This is a development preview. Target-environment validation remains necessary for cross-platform service behavior and deployed Cloudflare behavior. A fixed signed hosted-bootstrap implementation is included; the default/local environment remains disabled, while the checked-in `production` environment carries the gates for the independently verified immutable release. Hosted commands are exposed only after that environment is deployed with a canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN` and the exact `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.2` acknowledgement. Automatic Runner update, data downgrade, and upgrade rollback are not included. `shell` is a host capability, not an operating-system sandbox.

Install and configure the control plane using the [README](../README.md) and [deployment guide](deployment.md). Community contributions are welcome; see the [contribution guide](../.github/CONTRIBUTING.md) for the complete contribution terms and process.

Release assets include the Runner package, manifest, detached Ed25519 signature, trust keyring, SHA-256 checksums, license, NOTICE, and third-party notices. Verify the manifest signature with the trust keyring from an independently trusted source checkout, not the keyring downloaded with the assets; then verify `SHA256SUMS`, install the verified local `.tgz`, and confirm `coding-runner --version`. See the [portable Runner installation procedure](portable-runner-installation.md).

Commercial use requires separate written authorization. See [COMMERCIAL_LICENSE.md](legal/COMMERCIAL_LICENSE.md).

## Runmesh v0.1.0-dev.2 开发预览版

本开发预览版提供当前已支持的 Runmesh Agent Control Plane 能力。

本版本包含：

- Cloudflare Worker 与 SQLite-backed Durable Object 控制平面；
- 基于认证 WebSocket 的仅出站 Runner 连接；
- 不可变的 Desired 与 Active Policy 快照，包含 revision/checksum 校验、过期 ACK 保护，以及在策略 pending、offline、invalid 或不一致时 fail-closed 的准入控制；
- 集中管理的 Workspace 策略和 fail-closed 授权；
- 带有界 UTF-8 安全日志和保留 Registry 元数据的持久 Runner Job；
- 覆盖 Runner、Workspace、inspect、read、edit、shell、job 的精简 MCP 工具面；
- dedicated-user 服务配置以及受显式 release availability gate 保护的 fixed signed hosted-bootstrap 路径；以及
- PolyForm Noncommercial License 1.0.0 源码可用许可。

这是开发预览版。跨平台服务行为和已部署 Cloudflare 行为仍需在目标环境中验证。固定 signed hosted-bootstrap 实现已经包含；默认/本地环境仍保持关闭，仓库内 `production` 环境携带独立核验过的 immutable release gates。只有在该环境部署并同时配置 canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN` 与精确的 `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.2` acknowledgement 后，才会暴露 hosted 命令。Runner 自动更新、数据 downgrade 和升级回滚尚未包含。`shell` 是宿主机能力，不是操作系统 sandbox。

请参考 [README.zh-CN.md](../README.zh-CN.md) 和[部署文档](deployment.md)完成控制平面的安装和配置。欢迎社区贡献，请阅读[贡献指南](../.github/CONTRIBUTING.zh-CN.md)了解完整的贡献条款和流程。

Release assets 包含 Runner package、manifest、Ed25519 detached signature、trust keyring、SHA-256 checksums、许可证、NOTICE 和第三方通知。必须使用独立可信源代码 checkout 中的 trust keyring 验证 manifest 签名，不能使用与 assets 一起下载的 keyring；随后验证 `SHA256SUMS`、安装已验证的本地 `.tgz`，并确认 `coding-runner --version`。参见[便携式 Runner 安装流程](portable-runner-installation.md)。

商业使用需要单独书面授权，请查看 [COMMERCIAL_LICENSE.zh-CN.md](legal/COMMERCIAL_LICENSE.zh-CN.md)。
