# 0.1.3 — fair multi-client Job queues and stable single-language UI

Published as an immutable stable main-branch release at `2026-09-14T14:03:29Z` from `90395a1a37e608ed40fe3646c1a06f5d4d4f4d83`; public signatures and checksums independently verified before activation.

Adds bounded per-client fair queues without increasing default process concurrency. A second MCP client receives a queued Job ID immediately while another command runs. Queued launches recheck current client/workspace authorization; cancellation and policy changes cannot start stale work. Legacy peers retain immediate-only admission.

Administrator pages render one language before display. Removes unconditional translation on English navigation, mixed-language labels and refresh cross-fades. History and logs remain explicitly requested and bounded; code, user data, commands and logs are not translated. Local Chromium validation covers both languages and mobile width.

Publication does not restart installed services or replace immutable packages. See [release readiness](release-readiness.md) and [queue/UI contract](job-queue-and-localization.md) for limits and restart behavior.

## Historical releases (unchanged)

# 0.1.2 — batched Job history, bounded reads and release-chain hardening

Published as an immutable stable release at `2026-09-14T07:46:46Z` from `0b45a519febfea865bc562f4b147b616ab6ddef6`. Signed assets were independently downloaded from the public unauthenticated release URLs and verified before enabling the production installer.

## Runner

Negotiates `job_history_protocol=1` with the audited Worker. Batched mode coalesces Job metadata at 1/5/15/60-minute intervals (five minutes by default) instead of emitting a full history update after every lifecycle event. Unchanged acknowledged snapshots are not uploaded again. Off mode creates no history sync timer. Deferred or failed archives can be retried without restarting commands.

Optional local day-based cleanup is separately confirmed and deletes only expired terminal Job metadata/logs. Running and uncertain recovered processes remain protected. Existing count/byte caps still apply.

## Worker and history

Uses one bounded D1 JSON snapshot for up to 500 recent Job metadata records, with revision fencing and independently selectable retention. Lists and logs are read only on request, with latest 10/20/50/100 records and 1/4/16 KiB log pages. Raw commands, credentials and full private logs are not uploaded as cloud history.

Completes final authorization mappings for diagnostics, patch preview and every Context method. Current scope, policy, workspace and transport checks remain in force. D1 history failure does not replay commands or fall back to core-DO history writes.

## Verification and installation

The release process runs end-to-end checks against the exact portable tarball before signing, checks the audited public Worker before creating a tag, and independently re-downloads draft and published assets. The manifest, Ed25519 signature, checksums and immutable annotated tag bind the release to its verified commit.

This package does not automatically upgrade existing services. Install through the enabled fixed-version installer or the documented independently verified portable route. Refresh cached MCP tool schemas for workspace-bound Job operations. Existing v0.1.1 releases, credentials and live processes are not replaced by publishing this release.

Measured local regression: updating one or 100 Jobs in an existing packed snapshot writes one D1 row. An unchanged simulated daily upload cadence emits no additional uploads. Required heartbeat and bounded maintenance costs remain; this is not a promise of zero total usage or unlimited free-tier capacity.

See [release readiness](release-readiness.md), [batching and retention](batched-job-history.md), and [chain audit](release-chain-audit.md).

---

## Previous releases

# 0.1.1 — published stable patch release

Carries the post-0.1.0 Runner and control-plane hardening into a new immutable patch release instead of reusing the already published v0.1.0 identity. It adds bounded Git history inspection, patch preview/search improvements, durable workspace Context handoff with observed Git-baseline aging, clearer Job launch/audit receipts, shareable allow-listed diagnostics, validated operational runbooks, and CI parity checks. The immutable v0.1.1 release was published from the verified `dev` commit, independently re-downloaded and verified, and is explicitly enabled by the checked-in production Worker configuration.

See [release readiness](release-readiness.md). The v0.1.0 release remains immutable and is not replaced.

# 0.1.0 — published stable base

The first stable release established the signed portable Runner, protected release workflow, cross-platform service lifecycle, bounded filesystem/Job operations, and the protocol-v2 control plane. Subsequent source changes are intentionally released under v0.1.1 rather than rebuilding or replacing these immutable assets.

# 0.1.0-dev.5 — complete maintenance cleanup

Adds a separately verified one-command uninstaller that works with old, missing
or damaged Runner installations. Canonical `uninstall --purge --yes` now removes
Runmesh runtime/config/state/log roots and supported service remnants, with
explicit leftover reporting. Project workspaces are retained. Install rollback
remains narrowly scoped. Installation status output is shorter and numbered;
cryptographic verification is unchanged. See [maintenance details](runner-uninstall.md).

# Worker installer activation for the published dev.4 Runner

Production now enables the independently verified dev.4 signed Runner. Both
restricted and explicitly confirmed privileged modes receive one fetch-and-run
command with the one-time code already attached. No additional manual runtime
installation or second enrollment-code entry is required. The immutable Runner
artifact and tag are not rebuilt or replaced; these changes affect Worker
rendering, script mode selection, tests, and deployment configuration only.

The earlier candidate notes below describe the state before this activation.

# 0.1.0-dev.4 — unreleased security candidate

This source identity is distinct from immutable dev.3; no publication or
production rollout is implied by these notes. Hosted distribution is disabled
until new signed assets are published and independently verified.

MCP audit is metadata-only with a one-time legacy audit purge and seven-day
retention. Hosted copied commands include one-time enrollment codes for convenience;
positional, `--code`, and `--code=` inputs are supported. Hidden prompting remains
optional when no code is supplied. Downstream stdin avoids temporary input files. Registry settings outages return 503 without false
password lockouts. First administrator setup no longer requires a separate
bootstrap token (explicit product decision); CSRF, same-origin and atomic
first-success-wins protections remain. New Runner/client defaults remain
`dedicated_user` / `coding:read`.

This candidate also includes password-generation session CAS, Linux directory
handle and search budget fixes, Git ownership/confinement checks, nonce-aware
throttle pages, bounded source eviction, precise CI tooling, independent
production validation and native-platform/Node 20 CI definitions.
See [rollout notes](security-remediation.md) for remaining platform and cloud
acceptance, legacy backup retention and new signed release requirements.

---

## Previous release notes (historical)

# Runmesh 0.1.0-dev.3 版本说明

这是一个开发预览版，适合在受控环境试用。该版本采用 clean-break 数据边界：不会导入旧表、旧 profile、旧服务清单或旧凭据；请按[版本切换指南](migration.md)使用全新 Durable Object 命名空间并重新注册 Runner。发布前请先备份 Worker 配置和 Runner 本地目录，并在一台测试机器上验证。

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
- Cloudflare 配额、全新 Durable Object 命名空间、Windows/macOS 原生服务和外部 MCP 客户端仍需在目标环境验收。

## 安装和升级

管理员请先阅读[管理员指南](admin-guide.zh-CN.md)。无法使用托管安装器时，请使用[便携式安装流程](portable-runner-installation.md)并独立校验发布包。

## English

This is a development preview for controlled evaluation. It adds a unified dashboard, explicit Runner selection, per-workspace permissions, persistent jobs with bounded logs, cross-platform service provisioning, signed fixed-release installation, credential rotation, and path-safety checks. This release uses a clean-break data boundary: earlier tables, profiles, service manifests, and credentials are not imported; deploy a fresh Durable Object namespace and enroll Runners again.

`shell` runs with the Runner service account's host permissions and is not a sandbox. Automatic upgrades and rollback, multi-tenant organizations, billing, hosted IDEs, browser automation, and model APIs are outside this release. Validate Cloudflare quotas, fresh-namespace behavior, native service lifecycle behavior, and your MCP clients before production use.

See the [administrator guide](admin-guide.md) and [portable installation procedure](portable-runner-installation.md).
