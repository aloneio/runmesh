<p align="center">
  <img src="./assets/logo.png" alt="Runmesh" width="460" />
</p>

<p align="center"><strong>Give AI clients safe access to the computers you approve</strong></p>
<p align="center">Runmesh is a self-hosted remote development and automation control plane for MCP clients.</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./docs/user-guide.md">User guide</a> ·
  <a href="./docs/admin-guide.md">Administrator guide</a> ·
  <a href="./docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="./docs/README.md">All documentation</a>
</p>

> [!IMPORTANT]
> Runmesh is provided under the PolyForm Noncommercial License 1.0.0. Commercial use requires separate written authorization. See [Commercial License](docs/legal/COMMERCIAL_LICENSE.md).

## What Runmesh does

Runmesh connects ChatGPT, Claude, Cursor, and other MCP-compatible clients to computers you control. An AI client can inspect approved files, suggest or apply changes, run authorized commands, and follow long-running jobs.

Each execution machine runs a Runmesh Runner, which connects to the control plane over an encrypted outbound connection. Files and commands are handled on the machine, and requested output passes through the control plane to the authenticated client. The control plane stores configuration, bounded audit metadata and optional recent Job metadata.

Runmesh is useful for maintaining servers, sharing a controlled development machine with a team, running builds and operational tasks, and giving each client a precise set of machines, workspaces, and capabilities.

## Get started

If an administrator has given you an MCP URL:

1. Paste the complete URL into an MCP Streamable HTTP client.
2. Call `runner_list` to see available machines.
3. Call `runner_current`. If no machine is selected, call `runner_select` with the intended Runner ID, then confirm with `runner_current`.
4. Call `workspace_list` to see the workspaces approved for you.
5. Start with `read` or `inspect`; use `edit`, `shell`, or `job` only when needed.

The MCP URL is a credential, shown when a client is created or rotated. Store it securely and share it only with its intended user. See the [user guide](docs/user-guide.md) for the complete workflow.

## Administrator quick setup

Use the signed **0.1.4** stable release for production, with the corresponding activated `main` source for Worker deployment. Test upcoming changes in the separate `dev` environment described in the [deployment reference](docs/deployment.md).

1. Deploy a released production Worker from `main`, configure `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER`, and set the first administrator password before exposing the instance to untrusted visitors.
2. Add a machine on the **Runner** page. Keep the default `dedicated_user` execution mode unless you need and accept host-level privileges.
3. Copy the one-time enrollment command and run it on the target machine.
4. Add approved workspaces and permissions in the Runner details page.
5. Create an MCP client with the least privileges needed; new clients default to `coding:read`. Copy its one-time URL.
6. Share the URL with its intended user, and rotate or revoke it when necessary.

The standard installer downloads a fixed, verified release, supplies the runtime, enrolls the Runner, and configures its service. If hosted installation is unavailable, the dashboard shows the offline-verifiable portable procedure. See the [administrator guide](docs/admin-guide.md).

The copied enrollment command contains a single-use credential; keep the complete command private. For hidden manual code entry, follow the [interactive installation steps](docs/portable-runner-installation.md); Windows also requires removing `-NonInteractive` from the copied PowerShell command.

Ordinary production uses **two independent long-lived secrets**. Domain, history-backend and reviewed-release defaults are automatic. `ADMIN_TOKEN` is optional for advanced API administration. Preserve existing secret values during upgrades. The setup helper and reverse-proxy settings are documented in [minimal runtime configuration](docs/runtime-config.md).

## Capabilities and permissions

| Capability | What it does | Default behavior |
| --- | --- | --- |
| Read | Browse files and directories in approved workspaces | Read-only, paginated, and bounded |
| Edit | Apply changes with baseline checks | Requires write permission; follow recovery guidance if the result is uncertain |
| Inspect | View Git status, diffs, and bounded diagnostics | Read-only and limited to the permitted workspace |
| Shell | Run commands as the Runner service identity | Requires execution permission and uses the service account's OS privileges |
| Job | List, read, provide input to, or cancel long-running work | Paginated logs with bounded retention |
| Context | Save and retrieve workspace handoff notes | Optional, permission-controlled local storage with explicit cleanup |

Effective permission is the intersection of the client, Runner, and workspace policies. Each operation stays on the selected Runner; switching machines is an explicit client action.

## Secure operation

- Copy MCP URLs when creating or rotating them, and keep enrollment codes and Runner profiles private. Revoke or replace credentials if they are exposed.
- Administrators manage workspace roots; ordinary MCP workspace metadata omits those absolute paths. File contents and command output can still contain host paths. File-tool path checks reject traversal, device paths, and symlink escapes.
- The admin UI uses secure cookies, CSRF and origin checks, and login throttling.
- Run untrusted code inside a dedicated container or virtual machine with a restricted service account.
- Production operators should configure edge log redaction and maintain a credential rotation procedure.

## Versions and upgrades

The latest published stable version is **0.1.4**. See [release notes](docs/release-notes.md) for its improvements and [release status](docs/release-readiness.md) for installation availability. Development uses a separate verified prerelease channel.

An upgrade has three steps: deploy the Worker, install the target Runner package, and refresh the MCP client's tool catalog. Verify a representative task afterward using the [upgrade guide](docs/upgrading.md).

A new deployment provisions its own resources. For an existing v2 installation, preserve the Worker, live namespaces, D1 binding, secrets and enrolled Runners. Before rollout, check account quotas, service startup and shutdown, edge-log redaction, and the MCP clients you plan to use.

## Documentation

- [User guide](docs/user-guide.md): connect an MCP client, select a Runner, use workspaces, and manage jobs.
- [Administrator guide](docs/admin-guide.md): deploy, enroll Runners, configure workspaces, and create clients.
- [Upgrade guide](docs/upgrading.md): update compatible installations and verify Worker, Runner and client together.
- [Troubleshooting](docs/troubleshooting.md): login, connectivity, installation, permissions, and job issues.
- [Security model](docs/security.md): credential handling and trust boundaries.
- [Portable installation](docs/portable-runner-installation.md): offline verification and manual setup.
- [Deployment reference](docs/deployment.md): Cloudflare and advanced operations.
- [Release notes](docs/release-notes.md): changes and known limits for each release.

The [documentation index](docs/README.md) also links to architecture, protocol and maintainer references, with dated records available for historical context.

## License and support

Runmesh is maintained by aloneio. Report security vulnerabilities through the private process in [.github/SECURITY.md](.github/SECURITY.md); use Issues for ordinary bugs and product feedback. See [trademarks](docs/legal/TRADEMARKS.md) for name and logo usage.
