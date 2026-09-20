# Runmesh documentation

[简体中文](README.zh-CN.md)

Choose a guide for the task you want to complete. Start with the user guide to connect an MCP client, or the administrator guide to set up an instance.

## Use Runmesh

| Task | Guide |
| --- | --- |
| Connect an MCP client and run your first task | [User guide](user-guide.md) |
| Deploy the control plane, enroll a machine and grant access | [Administrator guide](admin-guide.md) |
| Update an existing installation and preserve its data | [Upgrade guide](upgrading.md) |
| Resolve connection, permission, installation or Job problems | [Troubleshooting](troubleshooting.md) |
| Check shipped changes versus upcoming improvements | [Release notes](release-notes.md) |

## Installation and safe operation

Start a new Runner installation from the administrator's enrollment page, which supplies a version-pinned installer when a verified release is available. For an existing installation, follow the upgrade guide to preserve its credentials, configuration and data.

Advanced installation references: [portable archive verification](portable-runner-installation.md), [installer prerequisites](installer-prerequisites.md), [runtime configuration](runtime-config.md), [deployment](deployment.md), and [complete uninstall](runner-uninstall.md).

Read the [security model](security.md) and [permission model](permission-model.md) to choose suitable access. Commands use the Runner service account's OS privileges; run untrusted code in a container or virtual machine. Store MCP URLs, enrollment commands and Runner profiles securely.

## Versions and features

The latest published stable release is **0.1.4**, and these guides describe its features. To use a new feature, deploy the compatible Worker, install the appropriate Runner package and refresh the client's tool catalog.

Check [release status](release-readiness.md) for package availability and [build provenance](build-provenance.md) for your deployed Worker. [Development prereleases](dev-runner-prereleases.md) provide a separate testing channel.

## Advanced and maintainer references

For integrations, use the [MCP call contract](mcp-agent-call-contract.md), [tool examples](tool-examples.md), [catalog refresh guide](mcp-connector-refresh.md), [capability contracts](capability-contracts.md) and [workspace Context storage](context-storage.md). For maintenance, see [architecture](architecture.md), [verification](verification.md) and [main promotion policy](main-promotion-policy.md).

[Historical release notes](maintainers/release-history.md) and [dated audit evidence](maintainers/release-evidence.md) record the versions and review periods named in each document. [Legacy migration](migration.md) covers early development and pre-v2 transitions; use the upgrade guide for a current v2 installation.

Security reports follow the private process in [SECURITY.md](../.github/SECURITY.md). For other issues, include the version, operation, time and redacted error code. Review attachments for credentials and private output before sharing.
