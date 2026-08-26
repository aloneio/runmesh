# Deployment

This document describes the implemented deployment and operator paths. The dashboard-led route is the normal setup path; the `ADMIN_TOKEN` API and explicit Runner flags are advanced/manual alternatives.

## Local validation (not deployment)

```sh
npm install
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

Configure the three server-side secrets before deployment:

```sh
cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
```

`ADMIN_TOKEN` is only for the manual/programmatic Runner administration API. It is not an administrator-password replacement, browser cookie, MCP credential, or Runner enrollment code.

Deploy when the account and hostname are ready:

```sh
npx wrangler deploy --config wrangler.jsonc
```

## Dashboard-led setup

1. Open the deployed root URL and create the first administrator password immediately. Setup is atomic first-success-wins; there is no bootstrap-password secret.
2. Log in and open **Admin → Runners**. Add a safe Runner ID (or let the dashboard generate one) and a human-facing `display_name`. The display name is displayed to operators and by `runner_list`; the ID is the stable protocol identifier.
3. Copy the enrollment code. It expires in 30 minutes and is single-use. **Regenerate enrollment** replaces any unused code for that Runner with a new one.
4. On the host, redeem it from an elevated administrator/root shell with the supported CLI. Enrollment creates a machine Runner with no workspace access; add approved roots later with `coding-runner workspace add`:

   ```sh
   coding-runner enroll \
     --server https://mcp.example.com/runner/enroll \
     --code '<one-time-enrollment-code>'
   coding-runner install
   ```

   Enrollment obtains the Runner ID and long-lived Runner credential from the response; the command accepts no `--runner-id`. It saves a centralized machine profile with zero workspaces and does not use the current directory.
5. In **Admin → MCP Clients**, create a client label and least-privilege scopes. Copy the generated one-time MCP URL and configure it directly in the MCP client:

   ```text
   https://mcp.example.com/<secret>/mcp
   ```
6. In that MCP client, call `runner_list`, then `runner_select({"runner_id":"..."})`; use `runner_current` to inspect the persisted client selection. A later change requires `confirm_switch: true`.

The dashboard displays safe Runner details and allows Runner rename, enrollment/re-enrollment, credential rotation, revocation, and deletion. It does not show Runner credentials or workspace roots.

### Public bootstrap and package configuration

The Worker exposes public, cacheable, secret-free `/runner/install.sh` and `/runner/install.ps1` bootstrap scripts. The dashboard renders the corresponding `curl ... | sh -s -- <one-time-code>` or PowerShell command; the code is passed only as a command argument and the generated enrollment page remains `no-store`. Installers require an already installed Node.js 20+ / npm runtime, an elevated administrator/root shell, and refuse to overwrite an existing managed profile or service unless explicitly re-enrolled. They install centrally and run `coding-runner enroll` followed by `coding-runner install`; Linux activation is automatic through the system service manager.

No public npm package is published by this repository. `/runner/releases/latest` remains compatible and `/runner/releases/stable` exposes the same stable, secret-free manifest. Both report `channel: "stable"`, current/latest package versions, protocol min/max, package/artifact source, and an optional SHA-256 artifact checksum. They return `distributable: false` until the operator configures a stable package spec through `RUNNER_PACKAGE_SPEC` (an exact `package@x.y.z` or HTTPS `.tgz` URL; mutable `latest`, GitHub, and `/main`/`/master` sources are rejected), with `RUNNER_PACKAGE_NAME` / `RUNNER_PACKAGE_VERSION` required when using a tarball URL. Set `RUNNER_ARTIFACT_SHA256` to include configured tarball checksum metadata. The installers fail clearly when no distributable spec is configured; they never download GitHub main or embed an administrator, MCP, or long-lived Runner credential. Runner updates, download, installation, and rollback remain explicitly deferred; the admin Version policy only records Stable/Pinned desired-version intent.

The bootstrap scripts install the system/machine Runner, require an elevated administrator/root shell, use a centralized installation layout, and run `coding-runner enroll` followed by `coding-runner install`. Linux automatically runs system `daemon-reload`, `enable --now`, and an active-unit check; host lifecycle management is not downgraded to per-user services.

## Local Runner profiles and service manifests

Enrollment stores server URL, Runner ID, long-lived credential, and optional concurrency under centralized machine locations:

```text
Linux:   /etc/remote-coding-runtime/profile.json
macOS:   /Library/Application Support/RemoteCodingRunner/profile.json
Windows: C:\\ProgramData\\RemoteCodingRunner\\profile.json
```

The POSIX profile directory/file are created with modes `0700`/`0600`; the Windows path uses normal Windows storage and `doctor` does not inspect ACLs. New enrollment profiles record `execution_mode: dedicated_user`; legacy profiles without this field preserve their privileged-host service layout when explicitly confirmed rather than silently changing an installed service. Enrollment starts with zero local workspaces; add roots explicitly with `workspace add`. Re-enrollment replaces credentials/connection data without inferring or adding a workspace. `status` redacts the token. `doctor --json` emits stable required/optional checks for profile directory/file modes, manifest/installed/active service state, Host shell runtime, execution mode, local policy revision when available, and tools; optional Python/Docker failures remain warnings, while required failures are nonzero. `workspace list|add|remove`, `env`, and `doctor` operate against the profile. `start` uses profile defaults unless explicit legacy Runner transport options are provided.

`coding-runner install` writes a hash-marked system service manifest and automatically activates it through an explicit host adapter. New dedicated-user services render Linux `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon `UserName=runmesh`, and Windows `NT AUTHORITY\LOCAL SERVICE` with least privilege. Operators must provision the `runmesh` account/group and grant it profile/state/workspace access. `--execution-mode privileged_host --confirm-privileged-host` is the explicit root/SYSTEM opt-in; legacy profiles without execution mode retain their old privileged layout for compatibility. Linux uses `/opt/remote-coding-runtime`, `/etc/remote-coding-runtime`, `/var/lib/remote-coding-runtime`, and `/etc/systemd/system/remote-coding-runner.service`; it runs `systemctl daemon-reload`, `systemctl enable --now remote-coding-runner.service`, and an active-unit check. It requires an elevated administrator/root shell and refuses an unmanaged existing manifest. `stop`, `restart`, and `uninstall` invoke their selected adapter; `uninstall` only removes a manifest whose marker and content hash match. `--purge --yes` additionally removes the local profile but leaves configured workspace roots and persistent job state untouched. Use `--user` only for explicit legacy per-user compatibility.

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

RegistryDO startup performs additive in-place SQL repair/migrations for known older fields, tables, and indexes (for example Runner display names, public info, enrollments, client active-runner state, and throttle state). There is no separate versioned migration CLI and no rollback/downgrade contract. Back up state and rehearse production upgrades; deployed migration behavior is not proven by local validation.

The local short-operation maximum is 8 seconds and the Worker bridge timeout is 12 seconds; use `exec_start` for longer work. Registry retains active jobs and up to 1,000 terminal jobs per Runner. Local per-Job and aggregate logs are bounded; quota exhaustion is recorded as `output_truncated` and requires operator review.

MCP URL path credentials can be captured by infrastructure outside application code. Configure Cloudflare log redaction, retain a rotation/revocation procedure, and perform deployed acceptance testing before production use.
