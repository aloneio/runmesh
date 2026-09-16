# Deployment reference

> This page is the advanced deployment reference. If you are setting up Runmesh for the first time, start with the [administrator guide](admin-guide.md). It explains the same process in product language and lists the decisions you need to make before opening access to users.

This document describes the implemented deployment and operator paths. The dashboard-led route is the normal setup path; the `ADMIN_TOKEN` API and explicit Runner flags are advanced/manual alternatives.

## Local validation (not deployment)

Use the repository's pinned toolchain: **Node 22.23.2** and **npm 10.9.3**.
Both versions are exact. `.node-version` and the root `packageManager` field are
the source of truth, and `scripts/check-toolchain.mjs` runs in every CI job and
fails on any other pair. The root `engines.node` range (`>=22`) is only a broad
install-time guard; it is not the supported build version.

Node 22.23.2 bundles npm 10.9.8, so installing the pinned Node release is not
enough on its own — install the exact npm afterwards:

```sh
node --version                  # must print v22.23.2
npm install --global npm@10.9.3
npm --version                   # must print 10.9.3
```

Review the [security remediation and rollout notes](security-remediation.md)
before upgrading an existing deployment or provisioning a new administrator.

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

Production's release default is generated from `release/release-state.json`, not inferred from the package version. The generated module must agree with the exact published commit and independently verified manifest hash. Candidates and explicit empty release overrides remain disabled. The source-pinned installer still verifies immutable signed assets. Development reuses the independently reviewed signed stable Runner release so its enrollment page can retain one-command setup; test remains fail-closed, and an explicit empty acknowledgement disables hosted setup in any environment. Formal publication remains main-only, with the same repository immutability, signature, tag/commit and artifact checks. GitHub and GitLab CI run verification; the existing Cloudflare build connection performs deployment.

First setup requires no additional bootstrap token. The first valid submission atomically sets the administrator password; CSRF, same-origin checks and password confirmation remain. Complete setup before untrusted exposure because an uninitialized public instance is claimable by its first successful visitor. `ADMIN_TOKEN` remains only the manual/programmatic Runner administration credential, not a browser, MCP or enrollment credential.

Deploy when the account and hostname are ready. The Worker name is `runmesh`. For a direct Cloudflare Workers Builds connection, use the following as its deploy command; Cloudflare manages the connection authentication:

```sh
npm run deploy:worker -- --env production
```

The deployment wrapper checks the main/production and dev/development relationship, verifies clean source against declared CI commits, compiles its source identity and adds a corroborating provider version tag without new runtime variables. See [build provenance and post-deployment observation](build-provenance.md). Keep existing Worker and database identities on upgrade. For a new account, the resource configuration provisions local account resources, and the request supplies its validated domain. `ADMIN_TOKEN` is optional and applies only to the advanced API below. See [minimal runtime configuration](runtime-config.md) for the missing-only setup helper and compatibility overrides.

1. Open the deployed root URL and create the first administrator password. No separate setup authorization token is required. Later setup requests are rejected atomically; existing administrator settings are preserved.
2. Log in and open **Admin → Runners**. Add a safe Runner ID (or let the dashboard generate one) and a human-facing `display_name`. The display name is displayed to operators and by `runner_list`; the ID is the stable protocol identifier.
3. Copy the enrollment code. It expires in 30 minutes and is single-use. **Regenerate enrollment** replaces any unused code for that Runner with a new one.
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

The dashboard displays safe Runner details and allows Runner rename, enrollment/re-enrollment, credential rotation, revocation, and deletion. It does not show Runner credentials or workspace roots.

### Public bootstrap and package configuration

Hosted bootstrap is enabled by default in production and development only when the independently reviewed signed stable release acknowledgement is available and the request resolves to a canonical HTTPS origin. Test remains fail-closed. Explicit `RUNMESH_SIGNED_RELEASE_AVAILABLE` is still an exact-version compatibility/emergency override, not a URL, package source or substitute for signature checks; an explicit empty value disables hosted setup. Missing publication evidence or an invalid origin reports `distributable: false` without consuming a code. Every enabled installer still verifies the source-pinned manifest, signature, checksums and package with its embedded trusted public key before offline installation with scripts disabled. A downloaded keyring is never a trust root. See the [portable installation procedure](portable-runner-installation.md). This does not publish unsigned dev Runner bytes and does not introduce automatic upgrade or rollback of an installed Runner.

## Local Runner profiles and service manifests

Enrollment stores server URL, Runner ID, long-lived credential, and optional concurrency under centralized machine locations:

```text
Linux:   /etc/runmesh/profile.json
macOS:   /Library/Application Support/Runmesh/profile.json
Windows: C:\\ProgramData\\Runmesh\\profile.json
```

Ordinary/user POSIX profiles are created with modes `0700`/`0600`. When a dedicated system service is provisioned, its profile directory/file intentionally use the exact `0750`/`0640` shape (owned by the service's root/group boundary) so the dedicated service account can read the credential; no group/other write bits are permitted. The Windows provisioner applies Local Service ACLs to Runmesh-owned paths, while `doctor` does not inspect those ACLs. New enrollment profiles record `execution_mode: dedicated_user` and `management_mode: central`; the authenticated dashboard and manual enrollment default to `dedicated_user`. The advanced `privileged_host` option requires the visible confirmation warning and does not silently change existing machines. Profiles missing either required field, or containing local workspace entries, are rejected and must be replaced through enrollment. Centrally managed enrollment starts with zero local workspaces; central policy configures roots through the Admin Panel. Re-enrollment replaces credentials/connection data without inferring or adding a workspace. `status` redacts the token. `doctor --json` emits stable required/optional checks for profile directory/file modes, manifest/installed/active service state, Host shell runtime, execution mode, local policy revision when available, and tools; optional Python/Docker failures remain warnings, while required failures are nonzero. `env` and `doctor` operate against the profile, and `start` uses profile defaults plus explicit current transport flags when needed.

`runmesh install` invokes the Runmesh service provisioner, writes a hash-marked system service manifest, and automatically activates it through an explicit host adapter. The provisioner creates the Runmesh account/group and Runmesh-owned install/config/state/log directories on Linux and macOS, and applies Local Service ACLs to Runmesh-owned install/config/state/log/profile paths on Windows. Dedicated-user services render Linux `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon `UserName=runmesh`, and Windows `NT AUTHORITY\LOCAL SERVICE` with least privilege. It never changes Workspace ownership or modes: operators must grant that service identity the minimum required access to each configured Workspace. The dashboard and direct CLI/manual setup remain dedicated-user unless the operator explicitly chooses `--execution-mode privileged_host --confirm-privileged-host` after its warning. Incomplete profiles are rejected rather than silently converted. Linux uses `/opt/runmesh`, `/etc/runmesh`, `/var/lib/runmesh`, `/var/log/runmesh`, and `runmesh-runner.service`. It requires an elevated administrator/root shell and refuses an unmanaged existing manifest. `stop`, `restart`, and `uninstall` invoke their selected adapter; `uninstall` only removes a manifest whose marker and content hash match. `--purge --yes` on a canonical 0.1.1 installation removes Runmesh installation/configuration/state/log paths and supported service remnants while preserving project workspaces. Use the [maintenance script](runner-uninstall.md) for old or incomplete installations. Use `--user` to select the explicit per-user service layout.

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

### Failed preview-release recovery

The GitHub release workflow creates the annotated tag before creating and uploading the draft release. Those GitHub operations are not transactional: a failed or cancelled run can leave an orphan tag, a draft release, or both. Do not blindly rerun the same version or add automatic `failure()` cleanup. An authorized maintainer must inspect the failed run's `GITHUB_SHA`, verify that `refs/tags/v<version>` is an annotated tag whose tag object targets exactly that commit, and verify that `GET /releases/tags/v<version>` returns `404` before treating the tag as an orphan. If a draft release exists, it is not an orphan tag: inspect its assets and either finish/publish it or remove the draft through the normal GitHub review flow; after removal, re-check that the release endpoint still returns `404` before considering tag deletion. Never delete a tag that already backs a draft or published release, or that points at a different commit. Only after both orphan checks pass may the maintainer manually delete the tag ref, preserve the CI artifact, and rerun the release. A tag deletion is irreversible and is never performed automatically by this repository.

This release has a clean data boundary. RegistryDO accepts only the current complete schema; a persisted incompatible schema fails closed and requires a fresh Durable Object namespace. There is no in-place SQL repair, data-import command, profile conversion, data downgrade, or automatic application rollback. Before rollout, stop/quiesce Runners and snapshot each host's profile/token, `runner.json`, `jobs/<id>/meta.json`, logs, verified package, `current` pointer, and service manifest for independent archival; these local files are authoritative for local jobs and are not imported into the new namespace. Back up Worker configuration plus RegistryDO and RunnerDO durable state using provider-supported export/restore, rehearse a fresh deployment and actual restore, then run `doctor --json` and representative policy/workflow checks. If a rollout must be withdrawn, remove the signed-release acknowledgement and redeploy to close future hosted-bootstrap rendering, review cached/downloaded installers, and revoke/regenerate credentials or enrollment codes as needed; do not run an older Worker against this namespace. Preserve `RUNNER_TOKEN_PEPPER` and `INTERNAL_CONTROL_SECRET`, or plan complete Runner re-enrollment if either is intentionally rotated. For immediate shutdown, stop/disable each local Runner service and inspect/terminate already-running local Jobs separately: credential revocation only closes the transport and prevents reconnect, and does not kill host processes. Do not delete Durable Object data as a rollback mechanism. For a local package/service failure, retain the verified package and restore its managed `current` pointer/service state manually. Enrollment redemption is remote, single-use, and irreversible: a rollback does not restore a redeemed code or token, so revoke/rotate credentials and generate a replacement enrollment code when needed.

The local short-operation maximum is 8 seconds and the Worker bridge timeout is 12 seconds; use `exec_start` for longer work. Registry retains active jobs and up to 1,000 terminal jobs per Runner. Local per-Job and aggregate logs are bounded; quota exhaustion is recorded as `output_truncated` and requires operator review.

MCP URL path credentials can be captured by infrastructure outside application code. Configure Cloudflare log redaction, retain a rotation/revocation procedure, and perform deployed acceptance testing before production use.

## Optional cloud history and quota isolation

See [quota isolation and cloud Job recording](quota-resilience.md). Production uses the independent `HISTORY_DB` D1 binding for optional audit. Core enrollment, credential and policy authority stays in RegistryDO. MCP client detail provides a switch for new cloud Job snapshots and related Job-tool audit; local Runner jobs/logs remain. Workspace-bound Job operations require Runner 0.1.1+. A successful GitHub `dev` push waits for every mandatory CI job, then fast-forwards the same verified commit to GitLab `dev`; that GitLab push triggers the maintained Cloudflare development deployment. The synchronizer never force-pushes and refuses divergence.

The synchronization bridge is a persistent `runmesh-dev-sync.timer` on oci0. It runs as the unprivileged `xwzy` account, uses that host's existing GitHub/GitLab credential helpers, and never copies a GitLab token into GitHub Actions. Each run fetches both `dev` refs, waits until the exact GitHub SHA has a successful GitHub Actions `verify-all` check, requires the existing GitLab SHA to be its ancestor, and then pushes that exact SHA. A diverged branch is left unchanged for operator review.

## Batched Job history

See [batched snapshots, manual loading and retention](batched-job-history.md). Production uses `RUNMESH_JOB_HISTORY_BACKEND=d1`; the default upload window is five minutes. History is loaded only on request. Source-side batching and local day-based cleanup are shipped in immutable v0.1.2; existing v0.1.1 assets and installed services remain unchanged.

## Production branch cutover

The serving Worker is promoted to protected GitLab main; dev is reserved for a separate development Worker. Existing v0.1.2 publication provenance above is historical and is not rewritten. Future formal publication is main-only. See [exact settings and checks](production-main-cutover.md).

## Minimal-host bootstrap

The [installer prerequisite contract](installer-prerequisites.md) uses pinned official gzip archives, checks service prerequisites before registration, and classifies stage errors. No system package manager is executed automatically and no new Worker runtime variables are required.
