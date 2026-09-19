# Administrator guide

[简体中文](admin-guide.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

This guide covers the product workflow for deploying and operating Runmesh on Cloudflare Workers and enrolling Runner machines on Linux, macOS, or Windows.

## Prepare

Have a Cloudflare account, a public HTTPS Worker origin, a strong administrator password (at least 12 characters), the machines that will run work, and a written least-privilege workspace plan.

Check [release status](release-readiness.md) before installing a Runner. A candidate version is not a published stable package, and its hosted installer may be deliberately unavailable. Use the release and installation procedure appropriate to your environment.

Runmesh does not choose operating-system permissions or workspace ownership for you.

For a new installation, Wrangler provisions the configured resources. An update of an existing v2 installation must preserve its Worker, live DO namespaces, history database, secret values, Runner profiles and current services. Do not reset a namespace or re-enroll healthy Runners merely to update code. Legacy pre-v2 migration instructions are not normal upgrade instructions.

## Deploy the control plane

Connect the repository to Cloudflare Workers Builds. Production requires a `main` revision whose signed release has been verified and activated. The current **0.1.4 candidate cannot use the production command below**. For candidate testing, select `dev` and use `npm run deploy:worker -- --env development` with separate resources; see [deployment](deployment.md).

For an activated production release, run `npm run build` from the repository root and deploy with:

```sh
npm run deploy:worker -- --env production
```

Ordinary deployment requires only two independent Cloudflare secrets: `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER`. Generate each from at least 32 cryptographically random bytes. Preserve their existing values during updates; replacing the pepper invalidates enrolled Runner credentials. Never commit secrets or print them in CI logs.

Normal production deployment needs no additional plaintext runtime variables. Runmesh validates the public HTTPS request address, uses the configured D1 history database by default, and makes the signed installer available only after the required release verification. Reverse proxies with an internal URL can explicitly set `RUNMESH_PUBLIC_ORIGIN`; forwarded headers do not choose the trusted public address. `ADMIN_TOKEN` is optional and enables only the advanced programmatic Runner API; browser login, enrollment and MCP do not require it.

The new-install helper `npm run setup:secrets -- --env production` only checks missing secret names. Adding `--apply` creates only missing required keys after a second inventory check. It does not rotate existing values, delete other keys, print secret values or automatically retry an uncertain upload. It requires Cloudflare management authentication and an existing deployed Worker. See [minimal runtime configuration](runtime-config.md).

Open the administrator page and set the password after deployment. No extra setup token is needed, and the first successful setup creates the administrator, so complete this before exposing the uninitialized instance to untrusted traffic. New Runners default to `dedicated_user` and new MCP clients to `coding:read`; existing permissions remain unchanged. A separate development Worker uses the `dev` branch and its own secrets/resources.

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

Runmesh sends each configured workspace root only to its matching Runner and omits it from MCP workspace and diagnostic metadata. File contents and command output can still contain host paths; review them before sharing.

## Create MCP clients

Open **MCP Clients**, enter a clear label, select the minimum scopes, create the client, and copy the one-time URL to its intended user. Rotate or revoke the client immediately if the URL may have been exposed. You can restrict a client to selected Runners.

## Daily operations

- Review Runner status, clients, and recent jobs from the dashboard.
- Rotate Runner credentials or MCP client URLs when access changes.
- Revoking a Runner blocks reconnection but does not kill processes already running on the host.
- Deleting a Runner removes its control-plane record, configured workspaces and policies, and client selections. It does not uninstall the host service, stop host processes or remove local files and Jobs. Separately retained audit/history data is not a guaranteed part of that deletion.
- When the hosted release channel is available, use the enrollment page's maintenance uninstaller for complete local removal, including old/partial installations. It deletes local Job history while preserving project workspaces. When hosted distribution is unavailable, the page shows a local CLI command instead; check the installed version's purge support and the [complete uninstall guide](runner-uninstall.md) before using it. Delete the control-plane Runner record separately.
- Emergency lock blocks new protected operations; inspect host processes separately.
- Changing the administrator password invalidates existing admin sessions.

## Backups and upgrades

Protect control-plane data through the recovery process supported by your deployment. Back up each Runner's profile, job metadata, retained logs, verified package and service manifest. Runmesh does not provide an in-app full backup or automatic rollback.

Before restarting a Runner, stop new submissions, drain active/queued work and inspect uncertain recovered processes. Record the actual service executable and version, and rehearse recovery separately. Follow the [upgrade guide](upgrading.md); do not reset namespaces, rotate secrets, purge state or repeat healthy enrollment as an ordinary update.

## Production checklist

Use a canonical HTTPS origin and configure log redaction. Keep administrator credentials and Worker secrets separate. Never put MCP URLs or enrollment codes in logs or tickets. Prefer restricted service accounts and minimum workspace access. Reserve high-privilege mode for dedicated trusted hosts. Review Runner, client, and job activity regularly and maintain a credential-rotation and shutdown procedure.

## Optional cloud history and quota isolation

Open **MCP Clients → client details → Cloud Job history** to disable recording for new Jobs. This stops their optional cloud snapshots and related Job-tool audit; local Jobs and retained logs remain. Existing cloud records are not deleted, and enabling recording later does not backfill Jobs originally created without recording. Required authorization and replay-prevention records remain.

Pass `workspace_id` when following an unrecorded Job; workspace-bound Job operations require Runner 0.1.1 or newer. Unrecorded Jobs have no offline cloud history. Production uses the independent `HISTORY_DB` D1 binding for optional history and audit, while core authorization remains separate. See [quota isolation and cloud Job recording](quota-resilience.md) for the limits of this separation.

## Batched Job history

On the Runner details page, choose a history type and click **Load / Refresh**. Logs are loaded only when requested and default to the last 4 KiB. Cloud history contains bounded Job metadata, not full output logs.

The default upload window is five minutes and cloud retention is seven days. Local deletion by age is disabled by default and requires separate confirmation when enabled. Active and uncertain recovered Jobs are retained. Batching and local retention require compatible components; they first shipped in Runner 0.1.2. See [batched snapshots, manual loading and retention](batched-job-history.md) for available settings.

## Shared Runner queue and localized UI

The 0.1.4 candidate defaults to two execution slots and supports an explicit limit of 1–64; an existing configured limit is preserved. Check the installed Runner's effective setting because older packages can have different defaults. Compatible queueing supports up to 32 waiting Jobs and eight per client, with authorization checked again before execution. Set `queue: false` on a shell request to return immediately when no execution slot is available.

See [queue/UI contract](job-queue-and-localization.md) for capability negotiation, current authorization, bounded fair scheduling, restart interruption and server-side locale rendering. A Worker deployment does not upgrade any installed Runner. Check the actual version and negotiated capabilities before relying on queue or history improvements.

## Change-driven history reporting

Change-driven reporting in the 0.1.4 candidate requires a compatible Worker and Runner. Unrecorded Jobs and ordinary log reads do not enable optional uploads; unchanged acknowledged snapshots do not keep uploading while idle. This does not eliminate heartbeats, authorization or maintenance requests. The published 0.1.3 package does not include this behavior. See [release notes](release-notes.md) and [history reporting](demand-job-history.md) before relying on it.
