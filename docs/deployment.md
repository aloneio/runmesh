# Deployment reference

> This is the advanced deployment reference. Start with the [administrator guide](admin-guide.md) for a new installation and the [upgrade guide](upgrading.md) for an existing compatible v2 instance. Current user guidance is collected in the [documentation index](README.md).

Use this reference to deploy a Worker, enroll Runners, and maintain an existing instance. Start with the dashboard for normal setup; use the `ADMIN_TOKEN` API and explicit Runner flags only when you need programmatic or manual administration.

## Local validation (not deployment)

Use the repository's pinned toolchain: **Node 22.23.2** and **npm 10.9.3**.
Both versions are exact. `.node-version` and the root `packageManager` field are
the source of truth, and `scripts/check-toolchain.mjs` runs in every CI job and
fails on any other pair. The root `engines.node` range (`>=22`) is only a broad
install-time guard; it is not the supported build version.

Check both tools independently; the npm bundled with a Node installation may
not match the repository pin. Install the exact npm version when needed:

```sh
node --version                  # must print v22.23.2
npm install --global npm@10.9.3
npm --version                   # must print 10.9.3
```

Review the [upgrade guide](upgrading.md) before changing an existing deployment,
and complete first administrator setup before exposing a new instance.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run validate:worker
npm run pack:runner
```

`validate:worker` invokes Wrangler with `--dry-run`. It validates the local bundle and Durable Object bindings but neither publishes a deployment nor proves production account quotas, fresh-namespace provisioning, edge-log redaction, Internet network behavior, or external MCP-client compatibility. `pack:runner` is a local `npm pack --dry-run` check; it does not publish an artifact.

## Cloudflare resources and secrets

The deployed core uses one Worker, the current SQLite-backed `RegistryDOv2` and `RunnerDOv2` namespaces, and a separate `HISTORY_DB` D1 binding for optional metadata history. Static assets and version metadata are bindings. No additional KV, R2, queue service, inbound Runner endpoint or model API is required for the standard deployment.

Ordinary production requires only two long-lived server-side secrets, with independent cryptographically random values of 32–512 non-whitespace characters. First setup has no extra authorization token. Preserve existing values on upgrade:

```sh
cd apps/worker
npm exec --offline -- wrangler secret put RUNNER_TOKEN_PEPPER --env production
npm exec --offline -- wrangler secret put INTERNAL_CONTROL_SECRET --env production
```

No plaintext runtime variable is required for ordinary production. `RUNMESH_PUBLIC_ORIGIN` is an optional reverse-proxy override; otherwise Runmesh uses the current validated HTTPS URL and matching Host. It never uses Host or forwarded headers alone. An explicit override must be an HTTPS origin without a path, query, fragment, credentials or whitespace. Invalid or explicitly empty overrides stay fail-closed. A new fork can use its own workers.dev or custom domain without editing the author's domain in source.

The current source version, **0.1.4**, is a candidate: its production hosted-installer default is disabled. Production availability follows the reviewed publication record in `release/release-state.json`, including the exact published commit and independently verified manifest hash. Setting a package version does not publish it. Development discovers and verifies its separate immutable signed prerelease channel and does not substitute a stable Runner when discovery fails. Test distribution stays disabled. An explicit empty release override disables hosted setup in any environment. Formal publication is main-only. CI verifies the source; a configured Cloudflare build connection performs deployment. Neither a Worker deployment nor publication of a Runner archive upgrades an installed Runner.

First setup requires no additional bootstrap token. The first valid submission atomically sets the administrator password; CSRF, same-origin checks and password confirmation remain. Complete setup before untrusted exposure because an uninitialized public instance is claimable by its first successful visitor. `ADMIN_TOKEN` remains only the manual/programmatic Runner administration credential, not a browser, MCP or enrollment credential.

After the account, hostname and reviewed release activation are ready, deploy the production Worker named `runmesh`. The production wrapper rejects the current unactivated 0.1.4 candidate. For a Cloudflare Workers Builds connection, set the repository-root build command to `npm run build` and use the following deploy command; Cloudflare manages the connection authentication:

```sh
npm run deploy:worker -- --env production
```

For the separate `runmeshdev` Worker, connect `dev` and use `npm run deploy:worker -- --env development`. A passing CI run does not deploy either Worker by itself; configure its build connection and verify the live source after deployment.

The deployment wrapper checks the main/production and dev/development relationship, verifies clean source against declared CI commits, compiles its source identity and adds a corroborating provider version tag without new runtime variables. See [build provenance and post-deployment observation](build-provenance.md). Keep existing Worker and database identities on upgrade. For a new account, the resource configuration provisions local account resources, and the request supplies its validated domain. `ADMIN_TOKEN` is optional and applies only to the advanced API below. See [minimal runtime configuration](runtime-config.md) for the missing-only setup helper and compatibility overrides.

1. Open the deployed root URL and create the first administrator password. No separate setup authorization token is required. Later setup requests are rejected atomically; existing administrator settings are preserved.
2. Log in and open **Admin → Runners**. Add a safe Runner ID (or let the dashboard generate one) and a human-facing `display_name`. The display name is displayed to operators and by `runner_list`; the ID is the stable protocol identifier.
3. Copy the enrollment command and review the validity period displayed by the administrator page. Enrollment codes are single-use; **Regenerate enrollment** replaces any unused code for that Runner. Do not confuse code expiry with the separately configured Runner authorization period.
4. The authenticated Admin enrollment page displays one of two routes. It labels the fixed signed release installer as available only after the exact immutable release has been published, independently verified, and explicitly enabled for this Worker. The hosted copied command includes a quoted one-time enrollment code, so no second code entry is needed. After fixed-asset verification and staging, the installer forwards it through `runmesh enroll --code-stdin` and clears its working variable without staging an input file. Positional codes, `--code CODE`, and `--code=CODE` are supported; omitting the code retains hidden terminal input. Otherwise use the manual [portable Runner verification and installation procedure](portable-runner-installation.md). Keep both the complete copied command and the separately displayed one-time code private; the manual route still reads the code at a local prompt.

   For the manual portable route, on Linux/macOS:

   ```bash
    set -euo pipefail
    RUNNER=/opt/runmesh/current/bin/runmesh
    printf '%s' 'One-time enrollment code: ' >&2
    read -r -s RUNMESH_ENROLLMENT_CODE
    printf '\n' >&2
    printf '%s\n' "$RUNMESH_ENROLLMENT_CODE" | sudo "$RUNNER" enroll \
      --server https://mcp.example.com/runner/enroll \
      --code-stdin
    unset RUNMESH_ENROLLMENT_CODE
    sudo "$RUNNER" install --executable-path "$RUNNER"
   ```

   On Windows PowerShell, use `Read-Host` and pipe the value to
   `runmesh enroll --code-stdin`; do not put the one-time code in the
   command line or a script file.

   Enrollment obtains the Runner ID and long-lived Runner credential from the response; the command accepts no `--runner-id`. It saves a centrally managed machine profile with zero local workspaces and does not use the current directory. Configure approved Workspace roots and permissions in the Admin Panel; centralized Runner profiles reject local `workspace add/remove`.
5. In **Admin → MCP Clients**, create a client label and least-privilege scopes. Copy the generated one-time MCP URL and configure it directly in the MCP client:

   ```text
   https://mcp.example.com/<secret>/mcp
   ```
6. In that MCP client, call `runner_list`, then `runner_select({"runner_id":"..."})`; use `runner_current` to inspect the persisted client selection. A later change requires `confirm_switch: true`.

The dashboard provides Runner details, workspace-policy configuration, rename, recovery enrollment, credential rotation, revocation and deletion. Protect this administrator access. Credentials are one-time material; workspace roots are not returned to MCP clients.

### Public bootstrap and package configuration

Hosted bootstrap has separate release lanes. Production is pinned to the independently reviewed stable release. Development uses `RUNMESH_SIGNED_RELEASE_AVAILABLE=dev` as a source-owned discovery sentinel and exposes only the current next-patch (`X.Y.(Z+1)-dev.N`) immutable signed prerelease; it verifies that prerelease manifest with the embedded Ed25519 public key before advertising or rendering it, and the downloaded installer verifies the same signed contract again. Development discovery failure, stale prereleases, invalid signatures, incomplete assets, or an invalid origin report `distributable: false`; development never falls back to the stable Runner. Test remains fail-closed. An explicit empty `RUNMESH_SIGNED_RELEASE_AVAILABLE` disables hosted setup in every lane. A downloaded keyring is never a trust root. See the [portable installation procedure](portable-runner-installation.md). This does not introduce automatic upgrade or rollback of an installed Runner.

## Local Runner profiles and service manifests

Enrollment stores server URL, Runner ID, long-lived credential, and optional concurrency under centralized machine locations:

```text
Linux:   /etc/runmesh/profile.json
macOS:   /Library/Application Support/Runmesh/profile.json
Windows: C:\\ProgramData\\Runmesh\\profile.json
```

Ordinary/user POSIX profiles are created with modes `0700`/`0600`. When a dedicated system service is provisioned, its profile directory/file intentionally use the exact `0750`/`0640` shape (owned by the service's root/group boundary) so the dedicated service account can read the credential; no group/other write bits are permitted. The Windows provisioner applies Local Service ACLs to Runmesh-owned paths, while `doctor` does not inspect those ACLs. New enrollment profiles record `execution_mode: dedicated_user` and `management_mode: central`; the authenticated dashboard and manual enrollment default to `dedicated_user`. The advanced `privileged_host` option requires the visible confirmation warning and does not silently change existing machines. Profiles missing either required field, or containing local workspace entries, are rejected and must be replaced through enrollment. Centrally managed enrollment starts with zero local workspaces; central policy configures roots through the Admin Panel. Re-enrollment replaces credentials/connection data without inferring or adding a workspace. `status` redacts the token. `doctor --json` emits stable required/optional checks for profile directory/file modes, manifest/installed/active service state, Host shell runtime, execution mode, local policy revision when available, and tools; optional Python/Docker failures remain warnings, while required failures are nonzero. `env` and `doctor` operate against the profile, and `start` uses profile defaults plus explicit current transport flags when needed.

`runmesh install` provisions and starts the host service. It creates Runmesh-owned account/group and install/config/state/log directories on Linux and macOS, and applies Local Service ACLs to Runmesh-owned paths on Windows. Dedicated-user services use Linux `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon `UserName=runmesh`, or Windows `NT AUTHORITY\LOCAL SERVICE`. Grant that identity the minimum necessary access to each configured Workspace; installation does not change Workspace ownership or modes. Dashboard and direct CLI/manual setup default to dedicated-user. Privileged host execution requires the explicit `--execution-mode privileged_host --confirm-privileged-host` choice. Incomplete profiles are rejected rather than silently converted.

System installation requires an elevated administrator/root shell and refuses an unmanaged existing service manifest. Linux uses `/opt/runmesh`, `/etc/runmesh`, `/var/lib/runmesh`, `/var/log/runmesh`, and `runmesh-runner.service`. `stop`, `restart`, and `uninstall` use the host service manager; ordinary uninstall removes only a matching managed manifest. Complete `--purge --yes` cleanup additionally removes Runmesh installation, configuration, state and logs. Older CLI versions may implement a narrower purge, so use the current verified [maintenance script](runner-uninstall.md) for old or incomplete installations. Project workspaces are retained. Use `--user` with the local CLI when you deliberately need the current user's service layout.

The Runner needs only outbound access. A saved profile requires `wss://`; cleartext `ws://` is available only for loopback development with explicit `--insecure-local`.

## Advanced/manual Runner API

Use this only when dashboard enrollment is not appropriate. The `ADMIN_TOKEN`-protected API registers/rotates a Runner and returns the plaintext token only in that response:

```sh
curl -sS -X POST https://mcp.example.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc","execution_mode":"dedicated_user"}'
```

Start it with explicit transport configuration:

```sh
RUNMESH_RUNNER_TOKEN='<returned-runner-token>' \
runmesh start \
  --server wss://mcp.example.com \
  --runner-id home-pc
```

`POST /admin/runners/<runner_id>/rotate` registers a replacement token; `POST /admin/runners/<runner_id>/revoke` invalidates the token. The manual API is separate from browser-session dashboard actions and enrollment-code redemption.

## Upgrade, migration, and operational limits

### Compatible updates

An existing compatible v2 deployment retains its Worker, live Durable Object namespaces, D1 binding, secrets, Runner profiles and service layout. Do not reset them for a normal code update. Incompatible schema or profile errors require inspection of the deployed source and bindings, not improvised SQL repair or automatic recreation. Only the explicitly identified [legacy transitions](migration.md) use the older clean-break procedure.

Follow the [upgrade guide](upgrading.md): stop new submissions, drain or reconcile Jobs, protect configuration and data, rehearse recovery separately, verify the target signed package, update components deliberately, then test the real MCP-to-Runner path. The first-install portable examples intentionally refuse an existing installation and are not a generic updater. Preserve both required secrets; rotation and recovery enrollment are separate credential-management operations.

Closing installer availability blocks future hosted bootstrap; it does not revoke downloaded installers or stop host processes. Revoking access is not process termination. When shutdown is necessary, use the reviewed host service procedure and inspect already-running Jobs separately. Never delete durable data or purge Runner state as a rollback shortcut.

### Failed publication is a maintainer task

Tag creation, draft upload and publication are separate operations. A failed workflow may leave a tag or draft, so do not blindly reuse the version, delete references, overwrite assets or add automatic cleanup. An absent release-by-tag response alone is not proof that no draft exists. Preserve the run's source and artifact evidence and have an authorized maintainer reconcile the exact tag, draft and assets before recovery. Development retries must follow the [prerelease recovery contract](dev-runner-prereleases.md); stable publication keeps its independent main-only checks. Published immutable releases remain unchanged.

### Jobs and retained output

Use the public `shell` tool for commands and `job` to follow its returned Job ID and workspace ID. The foreground wait and transport timeouts are not process execution deadlines. Query the original operation after an uncertain response instead of starting it again. Cloud history is a bounded recent snapshot, not a permanent archive or live process authority. Local per-Job and aggregate output caps also apply; `output_truncated` may indicate discarded bytes that Runmesh cannot recover.

MCP URL path credentials can be captured by infrastructure outside application code. Configure Cloudflare log redaction, retain a rotation/revocation procedure, and perform deployed acceptance testing before production use.

## Optional cloud history and quota isolation

See [quota isolation and cloud Job recording](quota-resilience.md). Production uses the independent `HISTORY_DB` D1 binding for optional audit. Core enrollment, credential and policy authority stays in RegistryDO. MCP client detail provides a switch for new cloud Job snapshots and related Job-tool audit; local Runner jobs/logs remain. Workspace-bound Job operations require Runner 0.1.1+.

For installations using both providers, separately configure the optional host-side `scripts/sync-gitlab-dev.mjs` bridge. It fetches both `dev` refs, requires successful GitHub Actions `verify-all` for the exact GitHub SHA, and checks that GitLab's current SHA is its ancestor before fast-forwarding. It uses separately provisioned authentication, never force-pushes and leaves divergence unchanged. The maintained development Worker builds the resulting GitLab push through its configured Cloudflare connection. The repository's CI workflows do not perform this mirror step, install a scheduler or configure your provider connections.

## Batched Job history

See [batched snapshots, manual loading and retention](batched-job-history.md). Production uses `RUNMESH_JOB_HISTORY_BACKEND=d1`; the default upload window is five minutes. History is loaded only on request. Source-side batching and local day-based cleanup are shipped in immutable v0.1.2; existing v0.1.1 assets and installed services remain unchanged.

## Production branch cutover

Production uses protected `main`; `dev` is reserved for a separate development Worker. A fork must configure and verify its own provider connections. Existing published provenance is historical and is not rewritten. Formal publication is main-only; see the [promotion policy](main-promotion-policy.md). The [historical cutover record](production-main-cutover.md) describes the maintained deployment, not settings automatically applied to every installation.

## Minimal-host bootstrap

The [installer prerequisite contract](installer-prerequisites.md) uses pinned official gzip archives, checks service prerequisites before registration, and classifies stage errors. No system package manager is executed automatically and no new Worker runtime variables are required.
