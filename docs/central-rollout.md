# Deploy MCP connections and Skills

[简体中文](central-rollout.zh-CN.md) · [Administrator guide](admin-guide.md) · [Upgrade guide](upgrading.md)

Use this sequence to add shared MCP connections and Skills to an existing Runmesh instance, then verify them from the AI clients your users rely on.

## Prepare the instance

1. Choose the control-plane version from the [release status](release-readiness.md) and review its [release notes](release-notes.md).
2. Save a backup of the deployment configuration and retained data. Keep the existing Worker, Registry, Runner and Capabilities resources, D1 bindings and deployment secrets.
3. Deploy through your existing production path. Confirm the running commit and environment using [build provenance](build-provenance.md).

OAuth connections use the existing `INTERNAL_CONTROL_SECRET`; Runner credentials use `RUNNER_TOKEN_PEPPER`. Preserve both values during an upgrade so existing account connections and registered machines continue working. The [runtime configuration guide](runtime-config.md) covers setup for a new instance.

## Connect a service and install a Skill

1. Open **MCP & Skill → MCP**, enter the provider's public HTTPS endpoint and select its authentication method. Follow [Connect an MCP](central-remote-mcp.md), including the provider's sign-in flow when using OAuth.
2. Open the saved connection's tool list and confirm that the tools you expect are present.
3. Open **MCP & Skill → Skills**, install a folder containing `SKILL.md` and its text references, then inspect the installed files. See [Install and update a Skill](central-skills.md).
4. Create a client connection with the access your user needs, copy its MCP address and add it to that user's AI client.

Shared tools and Skills can be used directly through the client connection. For file access and host commands, also enable computer access and configure a Runner with approved workspaces.

## Check the complete workflow

Use separate credentials in each AI client that will access the instance. Refresh the Runmesh tool and resource lists, then complete these checks:

| Check | Expected result |
| --- | --- |
| Read a Skill and one referenced file | Both reads use the selected Skill version. |
| Call a harmless provider tool | The client receives the provider's result. |
| Update a Skill or refresh a provider's tools | A refreshed client sees the selected version and current catalog. |
| Pause and re-enable a connection | Access follows the connection's current state. |
| Rotate a test client credential | The replacement address works and the retired address is rejected. |
| Use an approved Runner workspace | File access and a small test command follow the configured permissions. |
| Follow a test command | The original Job ID and workspace ID retrieve its status and retained logs. |

For workflows that use long tasks, input or cancellation, exercise those operations in a test workspace too. Record the component versions, provider and client names, test time and result so future upgrades can repeat the same checks.

## Monitor and recover

Review response times and Cloudflare usage with representative traffic before expanding access. Use the [cost measurement guide](cost-baseline.md) to compare storage, CPU and request usage over consistent time windows.

When a provider needs attention, inspect its card, refresh its tools or complete sign-in. After a call times out, check its result at the provider before repeating a change. Keep the original Job ID when following work on a Runner. The [troubleshooting guide](troubleshooting.md) gives the recovery steps for each component.

For an upgrade rollback, restore the tested combination of program, configuration and data versions while retaining the current secrets and registered identities. Follow the [upgrade guide](upgrading.md) and keep the backup until the restored workflow passes the same checks.
