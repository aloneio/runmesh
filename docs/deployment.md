# Deployment reference

Start with the [administrator guide](admin-guide.md) for setup or the [upgrade guide](upgrading.md) for an existing protocol-v2 installation. This reference covers build configuration, resource bindings and advanced administration.

## Validate the source

Use the repository's pinned toolchain, **Node 22.23.2** and **npm 10.9.3**. Check both versions, as a Node installation may bundle a different npm:

```sh
node --version                  # must print v22.23.2
npm install --global npm@10.9.3
npm --version                   # must print 10.9.3
npm ci
npm test
npm run typecheck
npm run build
npm run validate:worker
npm run pack:runner
```

`validate:worker` checks the local bundle and Durable Object bindings with Wrangler dry-run; `pack:runner` checks package contents with npm pack dry-run. Complete the [verification checks](verification.md) appropriate to your change before deployment.

## Select the environment

| Environment | Branch | Worker | Release requirement |
| --- | --- | --- | --- |
| Production | `main` | `runmesh` | Signed stable release verified and activated |
| Development | `dev` | `runmeshdev` | Candidate source; hosted installation uses its verified dev prerelease channel |

Current source is the **0.1.4 candidate**. Use development for testing until [release activation](release-readiness.md) is complete.

In Cloudflare Workers Builds, select the repository root and set the build command to `npm run build`. Use the matching deploy command:

```sh
# Development
npm run deploy:worker -- --env development

# Production, after stable release activation
npm run deploy:worker -- --env production
```

Cloudflare manages build-connection authentication. The deployment wrapper checks the branch, release state and clean Git source against the CI declarations, then records the source commit/tree. After deployment, compare the live commit through [build provenance](build-provenance.md).

For the maintained GitLab deployment path, configure the host-side `scripts/sync-gitlab-dev.mjs` bridge separately. It waits for GitHub `verify-all` on the exact dev SHA, checks ancestry and fast-forwards GitLab dev. A connected Cloudflare Worker then builds that push. Supply the bridge's authentication and schedule as part of your deployment configuration; divergence requires operator reconciliation.

## Provision resources and secrets

A standard deployment uses the Worker, SQLite-backed `RegistryDOv2` and `RunnerDOv2`, the `HISTORY_DB` D1 history database, static assets and version metadata. New installations provision their own account resources. Upgrades retain the live resource identities.

Create two independent cryptographically random secrets, using at least 32 random bytes encoded as text. Accepted values are 32–512 non-whitespace characters:

```sh
cd apps/worker
npm exec --offline -- wrangler secret put RUNNER_TOKEN_PEPPER --env production
npm exec --offline -- wrangler secret put INTERNAL_CONTROL_SECRET --env production
```

Use the appropriate environment for your Worker, and retain both values during updates. Replacing `RUNNER_TOKEN_PEPPER` invalidates enrolled Runner credentials. The [runtime configuration guide](runtime-config.md) includes a helper that initializes only missing secrets.

The default public origin is the validated HTTPS request URL with a matching Host. A reverse proxy that supplies an internal URL needs an explicit `RUNMESH_PUBLIC_ORIGIN`: an HTTPS origin without path, query, fragment, credentials or whitespace. An empty or invalid override rejects requests requiring a trusted public origin.

History defaults to the production D1 binding. Installation availability comes from the reviewed release record. Use intentional overrides only for the cases described in [runtime configuration](runtime-config.md).

## Complete administrator setup

1. Open the Worker's root URL and set the first administrator password before exposing the new instance to untrusted visitors. The first valid submission creates the administrator.
2. Open **Admin → Runners**, add a recognizable display name and review the execution mode.
3. Set the Runner authorization period and one-time enrollment-code validity, then copy the displayed command.
4. Execute it on the intended machine in an administrator terminal.
5. Add workspace roots and permissions in the Runner details page, and wait for policy acknowledgement.
6. Create a least-privilege MCP client in **Admin → MCP Clients** and copy its one-time URL to the intended user.

The MCP connection format is:

```text
https://mcp.example.com/<secret>/mcp
```

In that client, check `runner_current`, use `runner_list` to find the target, and select it explicitly with `runner_select` when needed. Switching an existing selection requires `confirm_switch: true`. Verify the result with `runner_current` and `workspace_list`.

## Install and enroll Runners

The enrollment page offers a hosted installer when its release channel is available. The installer verifies the fixed signed package and runtime, enrolls through `--code-stdin`, installs the selected service identity and starts the service. Keep the entire copied command private because it contains a single-use credential.

For hidden code entry, follow the platform instructions in [installer prerequisites](installer-prerequisites.md). On Windows, an interactive prompt also requires removing `-NonInteractive` from the copied command.

If hosted distribution is unavailable, use the [portable verification and installation procedure](portable-runner-installation.md). Enrollment obtains the Runner ID and credential from the server and creates a centrally managed profile. Configure workspaces in the administrator page after enrollment.

Production installation uses the activated stable release. Development discovers a complete, immutable signed prerelease in the current series. An unavailable dev selection closes that channel's installer. An explicit empty `RUNMESH_SIGNED_RELEASE_AVAILABLE` disables hosted installation. Details and retry handling are in [development prereleases](dev-runner-prereleases.md).

## Host profiles and services

| Platform | System profile | Dedicated service identity |
| --- | --- | --- |
| Linux | `/etc/runmesh/profile.json` | `runmesh` user and group |
| macOS | `/Library/Application Support/Runmesh/profile.json` | `runmesh` LaunchDaemon user |
| Windows | `C:\ProgramData\Runmesh\profile.json` | `NT AUTHORITY\LOCAL SERVICE` |

The default `dedicated_user` mode requires explicit OS access to approved workspaces. `runmesh install` provisions Runmesh-owned accounts/directories and starts the service; administrators grant project-directory access separately. Privileged execution requires `--execution-mode privileged_host --confirm-privileged-host`.

POSIX owner-only profiles use directory/file modes `0700`/`0600`. A dedicated system service uses the controlled root/group boundary with `0750`/`0640`. Windows provisioning applies Local Service ACLs to Runmesh-owned paths. Protect profiles as long-lived credentials.

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

Use `POST /admin/runners/<runner_id>/rotate` to replace the token and `POST /admin/runners/<runner_id>/revoke` to revoke it. Protect token values in your automation's secret-management system. Browser administration uses its own session and password flow.

## Operate and update the deployment

Follow `shell` receipts with the original Job ID and workspace ID. A foreground wait can end while the process continues. After an uncertain command or edit, inspect the original operation before retrying.

Set cloud recording and retention through [history settings](batched-job-history.md) and [quota isolation](quota-resilience.md). Production defaults to a five-minute upload window and bounded recent metadata. Retrieve output from retained Runner logs; discarded output is permanently lost.

For compatible upgrades, preserve Worker/database identities, secrets and Runner state. Rehearse recovery, pause new submissions, drain or reconcile Jobs, deploy the Worker and update each Runner explicitly, then complete [acceptance checks](upgrading.md). Use [legacy migration](migration.md) only when its stated older data boundary applies.

For removal, use [complete uninstall](runner-uninstall.md) from a local console or SSH session. Revoking access blocks new work; inspect already-running host processes as part of shutdown.

Configure edge-log redaction for MCP URL credentials and retain a credential-rotation procedure. Before production use, test the intended MCP clients, host service lifecycle and account quotas.

If a publication workflow fails, preserve its run, tag, draft and asset evidence for the maintainer. Reconcile the existing publication state before retrying, using the [prerelease recovery procedure](dev-runner-prereleases.md) or the stable release's reviewed process.
