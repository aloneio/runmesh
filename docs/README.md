# Runmesh documentation

[简体中文](README.zh-CN.md)

Choose a guide for the task you want to complete. Start with the user guide to connect an MCP client, or the administrator guide to set up an instance.

## Use Runmesh

| Task | Guide |
| --- | --- |
| Connect an MCP client and run your first task | [User guide](user-guide.md) |
| Deploy the control plane, enroll a machine and grant access | [Administrator guide](admin-guide.md) |
| Connect MCPs, install Skills and share them with AI clients | [MCP and Skill guide](central-administration.md) |
| Complete OAuth sign-in or reconnect an MCP account | [Account authorization](central-oauth.md) |
| Prepare a Skill folder and update its contents | [Skill installation](central-skills.md) |
| Update an existing installation and preserve its data | [Upgrade guide](upgrading.md) |
| Remotely upgrade a Runner or choose an earlier version | [Runner versions](runner-versions.md) |
| Resolve connection, permission, installation or Job problems | [Troubleshooting](troubleshooting.md) |
| Read version changes and upgrade guidance | [Release notes](release-notes.md) |

## Install and manage your instance

To add a computer, open **Runner → Add Runner** and run the generated installation command on that machine. To update an existing installation, follow the [upgrade guide](upgrading.md).

Installation references: [portable installation](portable-runner-installation.md), [system requirements](installer-prerequisites.md), [runtime configuration](runtime-config.md), [deployment](deployment.md), and [uninstall](runner-uninstall.md).

Use the [permission guide](permission-model.md) to choose access for each client and workspace. The [security guide](security.md) covers credentials, service accounts and host isolation.

## Versions and features

Runmesh shares enabled MCP tools and Skills with connected clients. After adding or updating them, refresh your AI client's tool catalog. To work with files or run commands, add computer access and install a Runner on the target machine.

Check [release status](release-readiness.md) for package availability and [build provenance](build-provenance.md) for your deployed Worker. [Development prereleases](dev-runner-prereleases.md) provide a separate testing channel.

## Integration and maintenance

For custom integrations, start with the [tool examples](tool-examples.md), [MCP call contract](mcp-agent-call-contract.md) and [catalog refresh guide](mcp-connector-refresh.md).

The [maintainer documentation](maintainers/README.md) covers architecture, development, publication and historical review records.

Security reports follow the private process in [SECURITY.md](../.github/SECURITY.md). For other issues, include the version, operation, time and redacted error code. Review attachments for credentials and private output before sharing.
