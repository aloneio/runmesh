# Runmesh documentation

[简体中文](README.zh-CN.md)

Choose the guide for your task. You do not need the architecture or audit reports to connect a client or manage a Runner.

## Use Runmesh

| Task | Guide |
| --- | --- |
| Connect an MCP client and run your first task | [User guide](user-guide.md) |
| Deploy the control plane, enroll a machine and grant access | [Administrator guide](admin-guide.md) |
| Update an existing installation without resetting its data | [Upgrade guide](upgrading.md) |
| Resolve connection, permission, installation or Job problems | [Troubleshooting](troubleshooting.md) |
| Check shipped changes versus upcoming improvements | [Release notes](release-notes.md) |

## Installation and safe operation

The administrator's enrollment page is the starting point for a new Runner. It supplies a version-pinned installer when a verified release is available. Existing installations should follow the upgrade guide, not repeat first-time enrollment or purge their state.

Advanced installation references: [portable archive verification](portable-runner-installation.md), [installer prerequisites](installer-prerequisites.md), [runtime configuration](runtime-config.md), [deployment](deployment.md), and [complete uninstall](runner-uninstall.md).

Read the [security model](security.md) and [permission model](permission-model.md) before granting command execution. A workspace is not an operating-system sandbox. Keep MCP URLs, enrollment commands and Runner profiles private.

## Versions and features

This checkout describes the **0.1.4 candidate, not yet published** as a stable package. The latest published stable release is **0.1.3**. Publishing a package, deploying a Worker, upgrading a Runner and refreshing a client's cached tools are separate steps. Check all of them before relying on a new feature.

The [release status](release-readiness.md) describes the reviewed stable distribution record, not the live health of your instance. [Development prereleases](dev-runner-prereleases.md) are a separate testing channel, not an automatic upgrade path for production.

## Advanced and maintainer references

For integrations, use the [MCP call contract](mcp-agent-call-contract.md), [tool examples](tool-examples.md), [catalog refresh guide](mcp-connector-refresh.md), [capability contracts](capability-contracts.md) and [workspace Context storage](context-storage.md). For maintenance, see [architecture](architecture.md), [verification](verification.md) and [main promotion policy](main-promotion-policy.md).

[Historical release notes](maintainers/release-history.md) and [dated audit evidence](maintainers/release-evidence.md) are retained for traceability. They may describe retired previews, old deployment states or incomplete checks; they are not current user instructions. [Legacy migration](migration.md) applies only to the explicitly identified old data boundary, not an ordinary v2 update.

Security reports follow the private process in [SECURITY.md](../.github/SECURITY.md). For other issues, report the version, operation, time and redacted error code; never include credentials or private output.
