# Administrator guide

[简体中文](admin-guide.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

Deploy the Runmesh control plane on Cloudflare Workers, connect your MCPs and install Skills, then add AI clients. For computer access, enroll the Linux, macOS or Windows machines that will execute work.

## Prepare the deployment

Prepare a Cloudflare account, a public HTTPS Worker origin, an administrator password of at least 12 characters, and a least-privilege plan for each machine and workspace.

See [release status](release-readiness.md) for the current version, signed packages and upgrade steps. Deploy production from `main`. Test upcoming changes with a separate `dev` Worker and resources.

In Cloudflare Workers Builds, connect the repository, choose `main`, and set the repository-root build command to `npm run build`. Set the deploy command to:

```sh
npm run deploy:worker -- --env production
```

For development, choose `dev` and use `npm run deploy:worker -- --env development`. See [deployment](deployment.md) for the complete configuration.

Use `npm run setup:secrets -- --env production` to inspect the two required secrets and add `--apply` to initialize missing values. OAuth encryption automatically uses the existing `INTERNAL_CONTROL_SECRET`. Preserve both values during upgrades: replacing the pepper invalidates enrolled Runner credentials, and replacing the control secret requires OAuth reconnection. The [runtime configuration guide](runtime-config.md) covers initialization and optional proxy/API settings.

Open the administrator page and set the password before exposing an uninitialized instance to untrusted visitors. The first successful setup creates the administrator. New Runners use `dedicated_user`. When shared MCP and Skill access is enabled, new clients default to **MCP and Skills**; choosing computer access opens its permissions with Read selected.

## Connect MCPs and install Skills

Open **MCP & Skill**. In **MCP**, enter the provider's URL, choose **No authentication** or **OAuth**, and select **Connect**. OAuth opens the provider's authorization page; on return, Runmesh loads the tools automatically.

In **Skill**, select a Skill folder or `SKILL.md` and its supporting text files, then select **Install Skill**. Enabled MCP tools and Skills are shared with all active AI clients in the instance.

Create a client from **Connect an AI client** or **AI connections**. Choose **MCP and Skills** for the shared collection, or **MCP, Skills and computer access** to add machine access. Copy the URL shown when it is created into the AI client's MCP settings. For everyday connection, update and pause actions, see the [MCP and Skill guide](central-administration.md).

## Enroll a machine

1. Open **Runner → Add Runner** and enter a recognizable display name.
2. Choose the restricted service account. Use high-privilege mode only for a trusted dedicated machine that requires it, and confirm the displayed warning.
3. Set the Runner authorization period and enrollment-code validity.
4. Generate the one-time enrollment command and run it in an administrator terminal on the target machine.
5. Return to the dashboard and confirm that the Runner is online.

Runner authorization starts when saved; `0` means no expiry. Enrollment codes start immediately and can be redeemed once. Generating a replacement invalidates the previous unused code. Keep the code and complete copied command private.

When hosted distribution is available, the installer verifies a fixed signed release, supplies its runtime and installs the service. Otherwise, follow [portable installation](portable-runner-installation.md), verify the artifact, and enroll through `runmesh enroll --code-stdin`.

A restricted service account needs OS access to the workspaces you approve. Commands run with that account's permissions; put untrusted code in a separate container or VM.

## Configure workspaces and clients

On the Runner details page, add a stable workspace name, an absolute host path and the required read, edit, shell and Job-control permissions. Save and wait for the Runner to apply the policy revision, then verify with `workspace_list` from the intended MCP client.

MCP workspace and diagnostic metadata omit configured host roots. Review file contents and command output before sharing them, as those can contain paths or other private data.

For a client using computers, open **AI connections**, choose **MCP, Skills and computer access**, and select the required permissions. Its details page lets you restrict access to selected Runners. Share the client URL with its intended user; rotate or revoke it if exposed.

## Manage access and retire machines

| Action | Effect and follow-up |
| --- | --- |
| Extend Runner authorization | Restores access after expiry; the connection and heartbeat remain available for recovery |
| Rotate a Runner credential | Invalidates the old credential and closes its old connection; use the recovery enrollment procedure on the host |
| Rotate or revoke an MCP client | Replaces or withdraws that client's access |
| Emergency lock or revoke a Runner | Blocks new protected work; inspect already-running host processes separately |
| Delete a Runner | Removes the control-plane record, workspace/policy settings and client selections; handle host removal and retained audit/history separately |
| Change the administrator password | Invalidates existing administrator sessions |

To retire the host installation, use the enrollment page's maintenance uninstaller when its release channel is available. It handles old or partial installations, deletes local Job history and preserves project workspaces. With hosted distribution unavailable, the page provides a local CLI command; check its version's purge support in [complete uninstall](runner-uninstall.md). Perform removal from a local console or SSH session, then delete the control-plane record.

## Set Job recording and retention

In **AI connections → client details → Cloud Job history**, choose whether new Jobs should save cloud snapshots and records of Job-tool calls. Local Jobs and retained output remain available. Existing cloud records keep their retention policy; enabling recording later applies to future recorded work. Required authorization and replay-prevention data is retained.

For an unrecorded Job, pass its `workspace_id` when following it on the online Runner. This requires Runner 0.1.1 or newer. See [quota isolation](quota-resilience.md) for history settings and storage behavior.

On the Runner details page, choose a history type and click **Load / Refresh**. Logs default to the last 4 KiB. Cloud history stores bounded Job metadata; output is fetched from the Runner.

Default history upload is every five minutes and cloud retention is seven days. Local age-based deletion starts disabled and requires separate confirmation when enabled. Active and uncertain recovered Jobs are retained. Batching and local retention require compatible components, available from Runner 0.1.2. See [history and retention settings](batched-job-history.md).

## Configure shared execution

Runners from 0.1.4 onward default to two execution slots, configurable from 1 to 64. Check each installed Runner's effective setting; existing explicit limits are preserved.

Compatible queues hold up to 32 waiting Jobs and eight per client, schedule clients in turn, and check authorization again before starting. A shell request with `queue: false` returns immediately when no slot is available. See [queue behavior](job-queue-and-localization.md).

From 0.1.4 onward, history reporting uploads snapshots when they change while heartbeats, authorization and maintenance continue as usual. This requires a compatible Worker and Runner. See [release notes](release-notes.md) and [history reporting](demand-job-history.md) for upgrade steps and reporting settings.

## Back up and upgrade

Back up control-plane data through your storage provider's recovery process. Protect Runner profiles, Job state, retained logs, service manifests, verified packages and project data, and rehearse restoration separately.

An upgrade keeps the existing Worker, v2 namespaces, D1 binding and secrets. Plan Worker deployment and Runner installation as separate steps. Before restarting a Runner, stop new submissions, drain active/queued work and inspect uncertain recovered processes. Record its actual service executable and version, then follow the [upgrade guide](upgrading.md).

For daily operation, review Runner/client access and recent Jobs, configure edge-log redaction, and keep a credential-rotation and host-shutdown procedure available.
