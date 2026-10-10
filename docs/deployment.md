# Deployment reference

Start with the [administrator guide](admin-guide.md) for setup or the [upgrade guide](upgrading.md) for an existing protocol-v2 installation. This reference covers build configuration, resource bindings and advanced administration.

## Validate the source

Use the repository's pinned toolchain, **Node 22.23.2** and **npm 10.9.3**. Check both versions, as a Node installation may bundle a different npm:

```sh
node --version                  # must print v22.23.2
npm install --global npm@10.9.3
npm --version                   # must print 10.9.3
npm ci
npm run typecheck
npm run build
npm test
npm run validate:worker
npm run pack:runner
```

`validate:worker` checks the local bundle and Durable Object bindings with Wrangler dry-run; `pack:runner` checks package contents with npm pack dry-run. Complete the [verification checks](verification.md) appropriate to your change before deployment.

## Select the environment

| Environment | Branch | Worker | Release requirement |
| --- | --- | --- | --- |
| Production | `main` | `runmesh` | Signed stable release verified and activated |
| Development | `dev` | `runmeshdev` | Candidate source; hosted installation uses its verified dev prerelease channel |

The [release status](release-readiness.md) lists the current stable package and installation options. Deploy the activated `main` source for production, then verify the live commit through [build provenance](build-provenance.md).

In Cloudflare Workers Builds, select the repository root and set the build command to `npm run build`. Use the matching deploy command:

```sh
# Development
npm run deploy:worker -- --env development

# Production
npm run deploy:worker -- --env production
```

Cloudflare manages build-connection authentication. The deployment wrapper checks the branch, release state and clean Git source against the CI declarations, then records the source commit/tree. After deployment, compare the live commit through [build provenance](build-provenance.md).

For candidate commits on `main`, Workers Builds completes these checks and keeps the active production Worker in place. Its log records `production_preserved` and `uploaded: false` while the signed release is prepared and verified. Pushing the reviewed release activation then deploys that source automatically with its commit tag. A manual production deployment requires the activated release record.

If you deploy through a GitLab mirror, configure `scripts/sync-gitlab-dev.mjs` on your automation host with the required authentication and schedule. It copies a dev commit after that commit passes GitHub `verify-all`; the connected Cloudflare Worker then builds the GitLab push. Resolve any branch divergence before resuming synchronization.

## Provision resources and secrets

A standard production deployment uses the Worker, SQLite-backed `RegistryDOv2`, `RunnerDOv2` and `CapabilitiesDOv1`, the `HISTORY_DB` D1 history database, static assets and version metadata. The checked-in development environment uses its own Durable Objects and stores history in Registry SQLite, with no D1 binding or Cron Trigger. New installations provision their own account resources. Upgrades retain the live resource identities and shared-capability settings described in [runtime configuration](runtime-config.md).

Production uses one Cron Trigger (`*/15 * * * *`) for [D1 history retention](quota-resilience.md#retention). Reserve one slot within the target account's [Cron Trigger allowance](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits). If deployment reports error `10072`, review existing schedules and remove an obsolete schedule you manage, or increase the account allowance, then rerun deployment. A Worker upload can succeed before trigger configuration fails; verify the final deployment status and the `runmesh` Cron Trigger together.

Create two independent cryptographically random secrets, using at least 32 random bytes encoded as text. Accepted values are 32–512 non-whitespace characters:

```sh
cd apps/worker
npm exec --offline -- wrangler secret put RUNNER_TOKEN_PEPPER --env production
npm exec --offline -- wrangler secret put INTERNAL_CONTROL_SECRET --env production
```

Use the appropriate environment for your Worker, and retain both values during updates. MCP OAuth automatically derives its encryption key from `INTERNAL_CONTROL_SECRET` and needs no additional setup. Replacing `RUNNER_TOKEN_PEPPER` invalidates enrolled Runner credentials; replacing `INTERNAL_CONTROL_SECRET` requires OAuth reconnection. The [runtime configuration guide](runtime-config.md) includes a helper that initializes only missing secrets.

The default public origin comes from the Worker's HTTPS request URL and matching Host. For a reverse proxy that supplies an internal URL, set `RUNMESH_PUBLIC_ORIGIN` to the public scheme and hostname, such as `https://runmesh.example.com`. Include a port only when needed; leave out paths, query strings, fragments, credentials and whitespace. Use a valid origin or remove the override to restore automatic selection.

History defaults to the production D1 binding. Installation availability comes from the reviewed release record. Use intentional overrides only for the cases described in [runtime configuration](runtime-config.md).

## Complete administrator setup

1. Open the Worker's root URL and set the first administrator password before exposing the new instance to untrusted visitors. The first valid submission creates the administrator.
2. Open **Admin → Runners**, add a recognizable display name and review the execution mode.
3. Set the Runner authorization period and one-time enrollment-code validity, then copy the displayed command.
4. Execute it on the intended machine in an administrator terminal.
5. Add workspace roots and permissions in the Runner details page, and wait for policy acknowledgement.
6. Create a least-privilege MCP client in **Admin → AI connections** and share the URL shown when it is created with its intended user.

The MCP connection format is:

```text
https://mcp.example.com/<secret>/mcp
```

In that client, check `runner_current`, use `runner_list` to find the target, and select it explicitly with `runner_select` when needed. Switching an existing selection requires `confirm_switch: true`. Verify the result with `runner_current` and `workspace_list`.

## Install and enroll Runners

The enrollment page offers a hosted installer when its release channel is available. The installer verifies the fixed signed package and runtime, enrolls through `--code-stdin`, installs the selected service identity and starts the service. Keep the entire copied command private because it contains a single-use credential.

For hidden code entry, follow the platform instructions in [installer prerequisites](installer-prerequisites.md). On Windows, an interactive prompt also requires removing `-NonInteractive` from the copied command.

If hosted distribution is unavailable, use the [portable verification and installation procedure](portable-runner-installation.md). Enrollment obtains the Runner ID and credential from the server and creates a centrally managed profile. Configure workspaces in the administrator page after enrollment.

Production installation uses the activated stable release. Development offers a signed prerelease compatible with the Worker protocol. The panel shows the available version; when a new development package is pending, follow [development prereleases](dev-runner-prereleases.md). Set `RUNMESH_SIGNED_RELEASE_AVAILABLE` to an empty value when you need to pause hosted installation.

## Host profiles and services

| Platform | System profile | Dedicated service identity |
| --- | --- | --- |
| Linux | `/etc/runmesh/profile.json` | `runmesh` user and group |
| macOS | `/Library/Application Support/Runmesh/profile.json` | `runmesh` LaunchDaemon user |
| Windows | `C:\ProgramData\Runmesh\profile.json` | `NT AUTHORITY\LOCAL SERVICE` |

The default `dedicated_user` mode requires explicit OS access to approved workspaces. `runmesh install` provisions Runmesh-owned accounts/directories and starts the service; administrators grant project-directory access separately. Privileged execution requires `--execution-mode privileged_host --confirm-privileged-host`.

POSIX owner-only profiles use directory/file modes `0700`/`0600`. Dedicated system-service configuration uses `0750`/`0640`, allowing root and the service group to access it. Runtime state, including policies and Jobs, uses `0700`/`0600` for the service account. These permissions also apply after upgrades and reinstalls. Windows applies Local Service ACLs to Runmesh-owned paths. Store profiles with the same care as other long-lived credentials.

Use the actual service executable for `runmesh --version`, with no additional arguments. Use `doctor --json` for configuration and host-service checks; add `--profile` for a custom profile or `--user` for the current user's service. `status --json` shows the redacted profile summary. Check Windows ACLs separately when diagnosing access.

Saved profiles require `wss://`. Local loopback development can use `ws://` with explicit `--insecure-local`.

## Advanced Runner administration API

For programmatic administration, configure the optional `ADMIN_TOKEN`. Register a Runner with:

```sh
curl -sS -X POST https://mcp.example.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc","execution_mode":"dedicated_user"}'
```

The response contains the plaintext Runner token once. Start the Runner with explicit transport configuration:

```sh
RUNMESH_RUNNER_TOKEN='<returned-runner-token>' \
runmesh start \
  --server wss://mcp.example.com \
  --runner-id home-pc
```

Use `POST /admin/runners/<runner_id>/rotate` to replace the token and `POST /admin/runners/<runner_id>/revoke` to revoke it. Revocation requires a JSON body whose `confirmation` exactly matches the Runner ID, for example `{"confirmation":"home-pc"}`. Rotation returns the replacement token once; update the host's credential before reconnecting. Protect token values in your automation's secret-management system. Browser administration uses its own session and password flow.

## Operate and update the deployment

Follow `shell` receipts with the original Job ID and workspace ID. A foreground wait can end while the process continues. After an uncertain command or edit, inspect the original operation before retrying.

Set cloud recording and retention through [history settings](batched-job-history.md) and [quota isolation](quota-resilience.md). Production defaults to a five-minute upload window and bounded recent metadata. Retrieve output from retained Runner logs; discarded output is permanently lost.

For compatible upgrades, preserve Worker/database identities, secrets and Runner state. Rehearse recovery, pause new submissions, drain or reconcile Jobs, deploy the Worker and update each Runner explicitly, then complete [acceptance checks](upgrading.md). Use [legacy migration](migration.md) only when its stated older data boundary applies.

For removal, use [complete uninstall](runner-uninstall.md) from a local console or SSH session. Revoking access blocks new work; inspect already-running host processes as part of shutdown.

Configure edge-log redaction for MCP URL credentials and retain a credential-rotation procedure. Before production use, test the intended MCP clients, host service lifecycle and account quotas.

If a publication workflow fails, preserve its run, tag, draft and asset evidence for the maintainer. Reconcile the existing publication state before retrying, using the [prerelease recovery procedure](dev-runner-prereleases.md) or the stable release's reviewed process.
