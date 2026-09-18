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

Each execution machine runs a Runmesh Runner. The Runner opens an encrypted outbound connection to the control plane, so the machine does not need a public inbound port, SSH service, or VPN tunnel. Authoritative files and command execution stay on the machine. Requested output is relayed through the control plane to the authenticated client; durable MCP audit stores metadata only, not tool bodies.

Runmesh is useful for maintaining servers, sharing a controlled development machine with a team, running builds and operational tasks, and giving each client a precise set of machines, workspaces, and capabilities.

## Get started

If an administrator has given you an MCP URL:

1. Paste the complete URL into an MCP Streamable HTTP client.
2. Call `runner_list` to see available machines.
3. If more than one machine is available, call `runner_select`, then confirm with `runner_current`.
4. Call `workspace_list` to see the workspaces approved for you.
5. Start with `read` or `inspect`; use `edit`, `shell`, or `job` only when needed.

The MCP URL is a credential and is shown only when a client is created or rotated. Never post it in chat, tickets, screenshots, logs, or source control. See the [user guide](docs/user-guide.md) for the complete workflow.

## Administrator quick setup

1. Deploy the production Worker from `main`, configure only `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER`, and set the first administrator password.
2. Add a machine on the **Runner** page and review the execution privilege warning.
3. Copy the one-time enrollment command and run it on the target machine.
4. Add approved workspaces and permissions in the Runner details page.
5. Create an MCP client with the least privileges needed and copy its one-time URL.
6. Share the URL with its intended user, and rotate or revoke it when necessary.

The standard installer downloads a fixed, verified release, supplies the runtime, enrolls the Runner, and configures its service. If hosted installation is unavailable, the dashboard shows the offline-verifiable portable procedure. See the [administrator guide](docs/admin-guide.md).

Ordinary production requires **two independent long-lived secrets and no manually filled plaintext runtime variables**. Domain, history-backend and reviewed-release defaults are automatic. `ADMIN_TOKEN` is optional for advanced API administration. Preserve existing secret values during upgrades. The missing-only helper and reverse-proxy exceptions are documented in [minimal runtime configuration](docs/runtime-config.md).

## Capabilities and permissions

| Capability | What it does | Default behavior |
| --- | --- | --- |
| Read | Browse files and directories in approved workspaces | Read-only, paginated, and bounded |
| Edit | Apply changes with baseline checks | Requires write permission and protects the original on failure |
| Inspect | View Git status, diffs, and bounded diagnostics | Read-only; never exposes the host root |
| Shell | Run commands as the Runner service identity | Explicitly authorized; not a sandbox |
| Job | List, read, provide input to, or cancel long-running work | Paginated logs with bounded retention |

Effective permission is the intersection of the client, Runner, and workspace policies. A denied layer stops the operation. Runmesh never silently switches to another machine when the selected Runner is unavailable.

## Security boundary

- MCP URLs, enrollment codes, and Runner credentials are shown once and can be rotated or revoked.
- Runners use encrypted outbound connections; execution machines need no public inbound service.
- Workspace roots stay private to the Runner; path checks reject traversal, device paths, and symlink escapes.
- The admin UI uses secure cookies, CSRF and origin checks, and login throttling.
- `shell` has the operating-system permissions of the Runner service account. It is not a container or virtual machine; use an external sandbox for untrusted code.
- Production operators should configure edge log redaction and maintain a credential rotation procedure.

## Current release boundary

See [release notes](docs/release-notes.md) for shipped features versus changes not yet published, and [release status](docs/release-readiness.md) for the reviewed signed distribution record. Source changes do not update already-installed components. Runner management, workspace policy, MCP clients, persistent jobs, reconnect handling, service provisioning, and gated signed installation are included. Automatic upgrades and rollback, multi-tenant organizations, billing, hosted IDEs, browser automation, model APIs, and operating-system sandboxing remain outside this release.

A new deployment provisions its own resources. Updating an existing v2 installation preserves its Worker, live namespaces, D1 binding, secrets and enrolled Runners; a normal code update is not a reason to reset or re-enroll them. Earlier pre-v2 migration procedures are separate. Validate quotas, service lifecycle behavior, edge-log redaction and the MCP clients you plan to use before rollout.

## Documentation

- [User guide](docs/user-guide.md): connect an MCP client, select a Runner, use workspaces, and manage jobs.
- [Administrator guide](docs/admin-guide.md): deploy, enroll Runners, configure workspaces, and create clients.
- [Upgrade guide](docs/upgrading.md): update compatible installations and verify Worker, Runner and client together.
- [Troubleshooting](docs/troubleshooting.md): login, connectivity, installation, permissions, and job issues.
- [Security model](docs/security.md): credential handling and trust boundaries.
- [Portable installation](docs/portable-runner-installation.md): offline verification and manual setup.
- [Deployment reference](docs/deployment.md): Cloudflare and advanced operations.
- [Release notes](docs/release-notes.md): changes and known limits for each release.

Use the [documentation index](docs/README.md) for task-based guides. Architecture, transport, legacy transitions and dated audits are separate maintainer references, not ordinary installation instructions.

## License and support

Runmesh is maintained by aloneio. Report security vulnerabilities through the private process in [.github/SECURITY.md](.github/SECURITY.md); use Issues for ordinary bugs and product feedback. See [trademarks](docs/legal/TRADEMARKS.md) for name and logo usage.

## Current security and rollout defaults

The reviewed release-state record and generated release module decide whether
production's fixed signed installer is available. A version label alone does
not activate it. Development uses a separately verified prerelease channel; it never falls
back to the stable installer when unavailable. Existing immutable packages
are never overwritten by a Worker update.
First administrator setup needs no additional bootstrap token: use password
confirmation, CSRF and same-origin protected atomic first-success-wins setup.
Finish initialization before exposing a new instance to untrusted visitors.
New Runners default to `dedicated_user` and new MCP clients to `coding:read`.
Hosted installer commands include the single-use enrollment code, so no second
code entry is needed. Omit the code argument to use the hidden manual prompt.
Keep the complete copied command private. See the [administrator guide](docs/admin-guide.md) and [upgrade guide](docs/upgrading.md).

Release gates, runtime support and upgrade precautions: [release readiness](docs/release-readiness.md).
