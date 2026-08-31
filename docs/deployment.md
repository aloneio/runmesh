# Deployment

This document describes the implemented deployment and operator paths. The dashboard-led route is the normal setup path; the `ADMIN_TOKEN` API and explicit Runner flags are advanced/manual alternatives.

## Local validation (not deployment)

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run validate:worker
npm run pack:runner
```

`validate:worker` invokes Wrangler with `--dry-run`. It validates the local bundle and Durable Object bindings but neither publishes a deployment nor proves production account quotas, Durable Object migration behavior, edge-log redaction, Internet network behavior, or external MCP-client compatibility. `pack:runner` is a local `npm pack --dry-run` check; it does not publish an artifact.

## Cloudflare resources and secrets

The deployed core uses only:

- one Worker;
- SQLite-backed `RegistryDO` and `RunnerDO` classes;
- no KV, D1, R2, Queues, Sandbox, Containers, Dynamic Workers, tunnels, inbound service, OAuth, AI/model API, or GitHub Actions runtime.

Configure the four server-side secrets before deployment:

```sh
cd apps/worker
npm exec --offline -- wrangler secret put ADMIN_TOKEN --env production
npm exec --offline -- wrangler secret put SETUP_TOKEN --env production          # or configure SETUP_TOKEN_HASH instead
npm exec --offline -- wrangler secret put RUNNER_TOKEN_PEPPER --env production
npm exec --offline -- wrangler secret put INTERNAL_CONTROL_SECRET --env production
```

Set the non-secret Worker variable `RUNMESH_PUBLIC_ORIGIN` in the `vars` section of `apps/worker/wrangler.jsonc` (or the equivalent environment-specific Wrangler configuration) before deployment. It must be the canonical externally reachable HTTPS origin, for example `https://mcp.example.com`: do not include a path, query, fragment, credentials, whitespace, wildcard, or an `http://` scheme. A trailing slash is normalized. When this variable is configured, the request `Host` used for browser CSRF/Admin POSTs, Admin-generated URLs, and hosted installer requests must match it; an internal proxy URL may differ, but an untrusted `Host` header must never be used as the public origin. Missing or invalid configuration keeps hosted bootstrap unavailable, while a mismatched request is rejected with a generic `421` response. Local development may omit the variable and use a loopback HTTP request origin, but the signed hosted path cannot be enabled without it.

Leave `RUNMESH_SIGNED_RELEASE_AVAILABLE` unset in the default/development vars. The checked-in `production` environment contains the literal acknowledgement for the independently verified immutable `v0.1.0-dev.2` release alongside `RUNMESH_PUBLIC_ORIGIN`; this is an explicit release gate, not a URL or version selector. Before changing that acknowledgement or enabling it for another deployment, an authorized maintainer must check the repository's [immutable-release setting](https://docs.github.com/en/rest/repos/repos?apiVersion=latest#check-if-immutable-releases-are-enabled-for-a-repository) with an administration-read credential and require a successful response showing `enabled: true`; `401`, `403`, or `404` is a release blocker. The GitHub preview workflow intentionally does not request that elevated permission, so its successful run alone is not proof of immutability. The workflow is pinned to this same version because the hosted installer embeds its version, URLs, and signing key; update and independently review that installer contract before introducing a later release version. The GitHub and GitLab repositories are connected to Cloudflare Workers Builds; configure each connection to deploy the `dev` branch with `npm exec --offline -- wrangler deploy --config apps/worker/wrangler.jsonc --env production --strict`. Cloudflare manages the build connection's authentication, while GitHub Actions and GitLab CI only run verification.

The first administrator setup requires the configured `SETUP_TOKEN` or the SHA-256 verifier in `SETUP_TOKEN_HASH`; the setup token is never stored in RegistryDO or displayed by the dashboard. First setup is atomic and first-success-wins, so an uninitialized public instance must be protected by deployment access controls until the intended administrator completes setup. `ADMIN_TOKEN` is only for the manual/programmatic Runner administration API. It is not an administrator-password replacement, browser cookie, MCP credential, or Runner enrollment code.

Deploy when the account and hostname are ready. The Worker name is `runmesh`. For a direct Cloudflare Workers Builds connection, use the following as its deploy command; Cloudflare manages the connection authentication:

```sh
npm exec --offline -- wrangler deploy --config apps/worker/wrangler.jsonc --env production --strict
```

The checked-in `production` environment targets the maintained
`runmesh.aloneio.workers.dev` deployment and enables the independently
verified fixed signed Runner release. For a fork or a different hostname,
replace `RUNMESH_PUBLIC_ORIGIN` in that environment with the canonical HTTPS
origin before deploying; keep the release acknowledgement disabled until the
matching immutable release has been independently verified.

1. Open the deployed root URL and create the first administrator password immediately. Setup is atomic first-success-wins; there is no bootstrap-password secret.
2. Log in and open **Admin → Runners**. Add a safe Runner ID (or let the dashboard generate one) and a human-facing `display_name`. The display name is displayed to operators and by `runner_list`; the ID is the stable protocol identifier.
3. Copy the enrollment code. It expires in 30 minutes and is single-use. **Regenerate enrollment** replaces any unused code for that Runner with a new one.
4. The authenticated Admin enrollment page displays one of two routes. It labels the fixed signed preview installer as available only after the exact immutable release has been published, independently verified, and explicitly enabled for this Worker. That OS-specific command contains no enrollment code; after fixed-asset verification and staging, the installer prompts locally and forwards the code only through `coding-runner enroll --code-stdin`. Otherwise use the manual [portable Runner verification and installation procedure](portable-runner-installation.md). Never put an enrollment code in a command line, URL, shell history, or persistent configuration; keep any prompt variable local and ephemeral.

   For the manual portable route, on Linux/macOS:

   ```bash
    set -euo pipefail
    RUNNER=/opt/runmesh/current/bin/coding-runner
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
   `coding-runner enroll --code-stdin`; do not put the one-time code in the
   command line or a script file.

   Enrollment obtains the Runner ID and long-lived Runner credential from the response; the command accepts no `--runner-id`. It saves a centrally managed machine profile with zero local workspaces and does not use the current directory. Configure approved Workspace roots and permissions in the Admin Panel; centralized Runner profiles reject local `workspace add/remove`.
5. In **Admin → MCP Clients**, create a client label and least-privilege scopes. Copy the generated one-time MCP URL and configure it directly in the MCP client:

   ```text
   https://mcp.example.com/<secret>/mcp
   ```
6. In that MCP client, call `runner_list`, then `runner_select({"runner_id":"..."})`; use `runner_current` to inspect the persisted client selection. A later change requires `confirm_switch: true`.

The dashboard displays safe Runner details and allows Runner rename, enrollment/re-enrollment, credential rotation, revocation, and deletion. It does not show Runner credentials or workspace roots.

### Public bootstrap and package configuration

Hosted bootstrap is disabled by default for local/development environments. The checked-in `production` environment enables it only with the canonical `RUNMESH_PUBLIC_ORIGIN` and the exact `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.0-dev.2` acknowledgement, after the immutable release has been independently verified. `/runner/releases/latest` and `/runner/releases/stable` report `distributable: false` whenever either gate is missing or invalid. The acknowledgement is an equality gate, not a configurable URL, package name, npm spec, checksum, or version source. Before enabling it for another deployment, verify the exact `v0.1.0-dev.2` tag/commit and signed manifest/Runner tarball with `scripts/release-verify.mjs` and a trust keyring from an independently trusted checkout, then verify `SHA256SUMS` and the remaining notices/keyring separately. When disabled, generated scripts fail closed without consuming enrollment codes. When enabled, they use only source-pinned GitHub URLs and an embedded Ed25519 public key to verify `manifest.json`, its detached signature/descriptor, `SHA256SUMS`, and the fixed local tarball before npm installs it with scripts disabled. The downloaded keyring is never a trust root. See the complete [portable Runner verification and installation procedure](portable-runner-installation.md), including the one-command Worker trust limitation and high-assurance offline route. Automatic update and rollback remain outside this preview.

## Local Runner profiles and service manifests

Enrollment stores server URL, Runner ID, long-lived credential, and optional concurrency under centralized machine locations:

```text
Linux:   /etc/runmesh/profile.json
macOS:   /Library/Application Support/Runmesh/profile.json
Windows: C:\\ProgramData\\Runmesh\\profile.json
```

Ordinary/user POSIX profiles are created with modes `0700`/`0600`. When a dedicated system service is provisioned, its profile directory/file intentionally use the exact `0750`/`0640` shape (owned by the service's root/group boundary) so the dedicated service account can read the credential; no group/other write bits are permitted. The Windows provisioner applies Local Service ACLs to Runmesh-owned paths, while `doctor` does not inspect those ACLs. New enrollment profiles record `execution_mode: dedicated_user` and `management_mode: central`. Profiles that omit `execution_mode` or `management_mode` are reported as `migration_required`: a missing `execution_mode` blocks system installation until the operator explicitly supplies `--execution-mode dedicated_user` or `--execution-mode privileged_host` (with confirmation for the latter), while a missing `management_mode` leaves `workspace list` readable but blocks local `workspace add/remove` until `workspace migrate --management-mode central|legacy_manual` records the choice. Legacy profile/state paths are not auto-discovered or imported; select a reviewed profile explicitly for manual migration. Centrally managed enrollment starts with zero local workspaces; central policy configures roots through the Admin Panel. Re-enrollment replaces credentials/connection data without inferring or adding a workspace. `status` redacts the token. `doctor --json` emits stable required/optional checks for profile directory/file modes, manifest/installed/active service state, Host shell runtime, execution mode, local policy revision when available, and tools; optional Python/Docker failures remain warnings, while required failures are nonzero. `env` and `doctor` operate against the profile, and `start` uses profile defaults unless explicit legacy Runner transport options are provided.

`coding-runner install` invokes the Runmesh service provisioner, writes a hash-marked system service manifest, and automatically activates it through an explicit host adapter. The provisioner creates the Runmesh account/group and Runmesh-owned install/config/state/log directories on Linux and macOS, and applies Local Service ACLs to Runmesh-owned install/config/state/log/profile paths on Windows. New dedicated-user services render Linux `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon `UserName=runmesh`, and Windows `NT AUTHORITY\LOCAL SERVICE` with least privilege. It never changes Workspace ownership or modes: operators must grant that service identity the minimum required access to each configured Workspace. `--execution-mode privileged_host --confirm-privileged-host` is the explicit root/SYSTEM opt-in; profiles without `execution_mode` are blocked until the operator explicitly selects `dedicated_user` or `privileged_host` (with confirmation for the latter), and are not silently migrated. Linux uses `/opt/runmesh`, `/etc/runmesh`, `/var/lib/runmesh`, `/var/log/runmesh`, and `runmesh-runner.service`. It requires an elevated administrator/root shell and refuses an unmanaged existing manifest. `stop`, `restart`, and `uninstall` invoke their selected adapter; `uninstall` only removes a manifest whose marker and content hash match. `--purge --yes` additionally removes the local profile but leaves configured workspace roots and persistent job state untouched. Use `--user` only for explicit per-user compatibility (legacy per-user mode).

The Runner needs only outbound access. A saved profile requires `wss://`; cleartext `ws://` is available only for loopback development with explicit `--insecure-local`.

## Advanced/manual Runner API

Use this only when dashboard enrollment is not appropriate. The `ADMIN_TOKEN`-protected API registers/rotates a Runner and returns the plaintext token only in that response:

```sh
curl -sS -X POST https://mcp.example.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc"}'
```

Start it with explicit transport configuration:

```sh
CODING_RUNNER_TOKEN='<returned-runner-token>' \
coding-runner start \
  --server wss://mcp.example.com \
  --runner-id home-pc \
  --workspace zero=/home/me/code/zero\;writable\;noshell
```

`POST /admin/runners/<runner_id>/rotate` registers a replacement token; `POST /admin/runners/<runner_id>/revoke` invalidates the token. The manual API is separate from browser-session dashboard actions and enrollment-code redemption.

## Upgrade, migration, and operational limits

### Failed preview-release recovery

The GitHub preview workflow creates the annotated tag before creating and uploading the draft release. Those GitHub operations are not transactional: a failed or cancelled run can leave an orphan tag, a draft release, or both. Do not blindly rerun the same version or add automatic `failure()` cleanup. An authorized maintainer must inspect the failed run's `GITHUB_SHA`, verify that `refs/tags/v<version>` is an annotated tag whose tag object targets exactly that commit, and verify that `GET /releases/tags/v<version>` returns `404` before treating the tag as an orphan. If a draft release exists, it is not an orphan tag: inspect its assets and either finish/publish it or remove the draft through the normal GitHub review flow; after removal, re-check that the release endpoint still returns `404` before considering tag deletion. Never delete a tag that already backs a draft or published release, or that points at a different commit. Only after both orphan checks pass may the maintainer manually delete the tag ref, preserve the CI artifact, and rerun the release. A tag deletion is irreversible and is never performed automatically by this repository.

RegistryDO startup performs additive in-place SQL repair/migrations for known older fields, tables, and indexes (for example Runner display names, public info, enrollments, client active-runner state, and throttle state). There is no separate versioned migration CLI, data downgrade, or automatic application rollback. Before migration, stop/quiesce Runners and snapshot each host's profile/token, `runner.json`, `jobs/<id>/meta.json`, logs, verified package, `current` pointer, and service manifest; these local files are authoritative for local jobs and are not stored in RunnerDO. Back up Worker configuration plus RegistryDO and RunnerDO durable state (using provider-supported export/restore; this release has no in-app backup command) and rehearse production upgrades and an actual restore, then run `doctor --json` and reconciliation checks. If a rollout must be withdrawn, remove the signed-release acknowledgement and redeploy to close future hosted-bootstrap rendering, review cached/downloaded installers, and revoke/regenerate credentials or enrollment codes as needed; then deploy only a previously verified Worker that is compatible with the already-applied additive schema. Preserve `RUNNER_TOKEN_PEPPER` and `INTERNAL_CONTROL_SECRET`, or plan a complete re-enrollment if either is intentionally rotated. For immediate shutdown, stop/disable each local Runner service and inspect/terminate already-running local Jobs separately: credential revocation only closes the transport and prevents reconnect, and does not kill host processes. Do not delete Durable Object data as a rollback mechanism. For a local package/service failure, retain the previous verified package and restore its managed `current` pointer/service state manually. Enrollment redemption is remote, single-use, and irreversible: a rollback does not restore a redeemed code or token, so revoke/rotate credentials and generate a replacement enrollment code when needed.

The local short-operation maximum is 8 seconds and the Worker bridge timeout is 12 seconds; use `exec_start` for longer work. Registry retains active jobs and up to 1,000 terminal jobs per Runner. Local per-Job and aggregate logs are bounded; quota exhaustion is recorded as `output_truncated` and requires operator review.

MCP URL path credentials can be captured by infrastructure outside application code. Configure Cloudflare log redaction, retain a rotation/revocation procedure, and perform deployed acceptance testing before production use.
