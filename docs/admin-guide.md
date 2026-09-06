# Administrator guide

This guide covers the product workflow for deploying and operating Runmesh on Cloudflare Workers and enrolling Runner machines on Linux, macOS, or Windows.

## Prepare

Have a Cloudflare account, a public HTTPS Worker origin, a strong administrator password (at least 12 characters), the machines that will run work, and a written least-privilege workspace plan.

Runmesh does not choose operating-system permissions or workspace ownership for you.

## Deploy the control plane

Connect the repository to Cloudflare Workers Builds. Use `dev` as the production branch and:

```sh
npm exec --offline -- wrangler deploy --config apps/worker/wrangler.jsonc --env production --strict
```

Configure these Cloudflare secrets and variables before deployment:

- `ADMIN_TOKEN` for advanced automated Runner administration;
- `SETUP_TOKEN` or `SETUP_TOKEN_HASH` for first-time setup;
- `RUNNER_TOKEN_PEPPER` and `INTERNAL_CONTROL_SECRET` for server-side credential protection;
- `RUNMESH_PUBLIC_ORIGIN` as the exact external HTTPS origin, without a path, query, or credentials.

`RUNMESH_PUBLIC_ORIGIN` is used as the default public origin and for reverse-proxy deployments. When Cloudflare routes a request through an additional custom HTTPS domain, Runmesh automatically accepts that domain when the request URL and `Host` header agree, so each new custom domain does not need a separate allowlist update.

Generate every secret with a cryptographically secure generator and use at least 32 random bytes for `SETUP_TOKEN`, `ADMIN_TOKEN`, `RUNNER_TOKEN_PEPPER`, and `INTERNAL_CONTROL_SECRET`. Never commit secrets or place them in CI logs. Protect a public, uninitialized deployment with Cloudflare Access until the intended administrator completes first setup.

## Enroll a Runner

1. Open **Runner** and choose **Add Runner**.
2. Enter a clear display name.
3. Choose a restricted service account unless high privilege is required.
4. Read and confirm the high-privilege warning when applicable.
5. Generate and copy the one-time enrollment command.
6. Run it on the target machine with administrator privileges.
7. Return to the dashboard and confirm that the Runner is online.

The console lets you set the valid days for Runner authorization and for each one-time enrollment code. Runner authorization starts when it is saved; `0` means no expiry. A code starts immediately and can be used once; generating a new code invalidates the previous unused code. When Runner authorization expires, its connection and heartbeat remain available for recovery, while new protected operations are denied until the window is extended.

When the hosted installer is enabled, the dashboard command pins the release, verifies its signature, supplies the runtime, enrolls the Runner, and installs its service. Otherwise follow the [portable installation procedure](portable-runner-installation.md) and use `runmesh enroll --code-stdin` after independently verifying the artifact.

## Configure workspaces

On the Runner details page, add a stable workspace name, an absolute host path, and only the permissions required: read, edit, shell, and job control. Save the policy and wait for the Runner to acknowledge it. Verify from an MCP client with `workspace_list`.

Workspace roots are sent only to the matching Runner. They are not returned through MCP or ordinary logs.

## Create MCP clients

Open **MCP Clients**, enter a clear label, select the minimum scopes, create the client, and copy the one-time URL to its intended user. Rotate or revoke the client immediately if the URL may have been exposed. You can restrict a client to selected Runners.

## Daily operations

- Review Runner status, clients, and recent jobs from the dashboard.
- Rotate Runner credentials or MCP client URLs when access changes.
- Revoking a Runner blocks reconnection but does not kill processes already running on the host.
- Deleting a Runner permanently removes its policies, workspaces, jobs, and client selections.
- To remove the local host installation, run `sudo /opt/runmesh/current/bin/runmesh uninstall --purge --yes` (Windows: `C:\Program Files\Runmesh\current\runmesh.cmd uninstall --purge --yes`). Delete the control-plane Runner record separately when its history is no longer needed.
- Emergency lock blocks new protected operations; inspect host processes separately.
- Changing the administrator password invalidates existing admin sessions.

## Backups and upgrades

Back up Cloudflare Durable Object data using the provider's supported export process. Back up each Runner's profile, job metadata, logs, verified package, and service manifest. The current preview does not provide an in-app backup or automatic rollback.

Before an upgrade, quiet the Runners, record the current version, and rehearse restore in a test environment. Do not delete Durable Object data as a rollback method.

## Production checklist

Use a canonical HTTPS origin and configure log redaction. Keep administrator credentials and Worker secrets separate. Never put MCP URLs or enrollment codes in logs or tickets. Prefer restricted service accounts and minimum workspace access. Reserve high-privilege mode for dedicated trusted hosts. Review Runner, client, and job activity regularly and maintain a credential-rotation and shutdown procedure.
