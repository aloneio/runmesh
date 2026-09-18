# Administrator guide

[简体中文](admin-guide.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

This guide covers the product workflow for deploying and operating Runmesh on Cloudflare Workers and enrolling Runner machines on Linux, macOS, or Windows.

## Prepare

Have a Cloudflare account, a public HTTPS Worker origin, a strong administrator password (at least 12 characters), the machines that will run work, and a written least-privilege workspace plan.

Runmesh does not choose operating-system permissions or workspace ownership for you.

For a new installation, Wrangler provisions the configured resources. An update of an existing v2 installation must preserve its Worker, live DO namespaces, history database, secret values, Runner profiles and current services. Do not reset a namespace or re-enroll healthy Runners merely to update code. Legacy pre-v2 migration instructions are not normal upgrade instructions.

## Deploy the control plane

Connect the repository to Cloudflare Workers Builds. Use `main` for production, run `npm run build` from the repository root, and deploy with:

```sh
npm run deploy:worker -- --env production
```

Ordinary deployment requires only two independent Cloudflare secrets: `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER`. Generate each from at least 32 cryptographically random bytes. Preserve their existing values during updates; replacing the pepper invalidates enrolled Runner credentials. Never commit secrets or print them in CI logs.

No plaintext runtime variable is required for normal production. The public origin comes from the matching HTTPS request URL and Host, history defaults to the configured D1 backend, and signed-installer activation is compiled from the independently verified release-state record. Forwarded headers cannot choose an origin. Reverse proxies with an internal URL can explicitly set `RUNMESH_PUBLIC_ORIGIN`. `ADMIN_TOKEN` is optional and enables only the advanced programmatic Runner API; browser login, enrollment and MCP do not require it.

The new-install helper `npm run setup:secrets -- --env production` only checks missing secret names. Adding `--apply` creates only missing required keys after a second inventory check. It does not rotate existing values, delete other keys, print secret values or automatically retry an uncertain upload. It requires Cloudflare management authentication and an existing deployed Worker. See [minimal runtime configuration](runtime-config.md).

First administrator setup has no extra bootstrap token. CSRF, same-origin checks and atomic first-success-wins remain. Complete setup before exposing an uninitialized instance to untrusted traffic. New Runners default to `dedicated_user` and new MCP clients to `coding:read`; existing permissions remain unchanged. A separate development Worker uses the `dev` branch and its own secrets/resources.

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
- Use the one-command maintenance uninstaller shown on the enrollment page for complete local removal, including old/partial installations. Local job history is deleted; project workspaces are preserved. See [complete uninstall](runner-uninstall.md). Delete the control-plane Runner record separately.
- Emergency lock blocks new protected operations; inspect host processes separately.
- Changing the administrator password invalidates existing admin sessions.

## Backups and upgrades

Protect control-plane data through the recovery process supported by your deployment. Back up each Runner's profile, job metadata, retained logs, verified package and service manifest. Runmesh does not provide an in-app full backup or automatic rollback.

Before restarting a Runner, stop new submissions, drain active/queued work and inspect uncertain recovered processes. Record the actual service executable and version, and rehearse recovery separately. Follow the [upgrade guide](upgrading.md); do not reset namespaces, rotate secrets, purge state or repeat healthy enrollment as an ordinary update.

## Production checklist

Use a canonical HTTPS origin and configure log redaction. Keep administrator credentials and Worker secrets separate. Never put MCP URLs or enrollment codes in logs or tickets. Prefer restricted service accounts and minimum workspace access. Reserve high-privilege mode for dedicated trusted hosts. Review Runner, client, and job activity regularly and maintain a credential-rotation and shutdown procedure.

## Optional cloud history and quota isolation

See [quota isolation and cloud Job recording](quota-resilience.md). Production uses the independent `HISTORY_DB` D1 binding for optional audit. Core enrollment, credential and policy authority stays in RegistryDO. MCP client detail provides a switch for new cloud Job snapshots and related Job-tool audit; local Runner jobs/logs remain. Workspace-bound Job operations require Runner 0.1.1+. GitLab main push, not GitHub verification alone, triggers the maintained production deployment.

## Batched Job history

See [batched snapshots, manual loading and retention](batched-job-history.md). Production uses `RUNMESH_JOB_HISTORY_BACKEND=d1`; the default upload window is five minutes. History is loaded only on request. Source-side batching and local day-based cleanup are shipped in v0.1.2; immutable v0.1.1 and existing services are unchanged.

## Shared Runner queue and localized UI

Current-source Runners default to two execution slots; an explicit configured limit is preserved. The bounded queue permits up to 32 waiting Jobs and up to eight per client. Older installed packages can have different defaults. Queueing requires compatible negotiated support and authorization at execution time.

See [queue/UI contract](job-queue-and-localization.md) for capability negotiation, current authorization, bounded fair scheduling, restart interruption and server-side locale rendering. A Worker deployment does not upgrade any installed Runner. Check the actual version and negotiated capabilities before relying on queue or history improvements.

## Source changes and recording preferences

New change-driven reporting requires a compatible Worker and Runner. Unrecorded Jobs and ordinary log reads do not enable optional uploads; re-enabling recording does not backfill originally unrecorded Jobs. Existing archived history is not deleted by disabling new recording. These development-source improvements are not retroactively added to immutable 0.1.3. See [release notes](release-notes.md) and the [reporting reference](demand-job-history.md).
