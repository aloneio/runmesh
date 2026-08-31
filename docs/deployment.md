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
npm exec --offline -- wrangler secret put ADMIN_TOKEN
npm exec --offline -- wrangler secret put SETUP_TOKEN          # or configure SETUP_TOKEN_HASH instead
npm exec --offline -- wrangler secret put RUNNER_TOKEN_PEPPER
npm exec --offline -- wrangler secret put INTERNAL_CONTROL_SECRET
```

The first administrator setup requires the configured `SETUP_TOKEN` or the SHA-256 verifier in `SETUP_TOKEN_HASH`; the setup token is never stored in RegistryDO or displayed by the dashboard. First setup is atomic and first-success-wins, so an uninitialized public instance must be protected by deployment access controls until the intended administrator completes setup. `ADMIN_TOKEN` is only for the manual/programmatic Runner administration API. It is not an administrator-password replacement, browser cookie, MCP credential, or Runner enrollment code.

Deploy when the account and hostname are ready. The Worker name is `runmesh`:

```sh
npm exec --offline -- wrangler deploy --config wrangler.jsonc
```

1. Open the deployed root URL and create the first administrator password immediately. Setup is atomic first-success-wins; there is no bootstrap-password secret.
2. Log in and open **Admin → Runners**. Add a safe Runner ID (or let the dashboard generate one) and a human-facing `display_name`. The display name is displayed to operators and by `runner_list`; the ID is the stable protocol identifier.
3. Copy the enrollment code. It expires in 30 minutes and is single-use. **Regenerate enrollment** replaces any unused code for that Runner with a new one.
4. On the host, download all assets listed in the [portable Runner verification and installation procedure](portable-runner-installation.md), including the `.tgz`, manifest, detached signature, signature descriptor, checksums, informational keyring, and release license/notice files. Verify them with the trust keyring from an independently trusted source checkout, not with the keyring downloaded beside the artifact. Follow the complete procedure, then redeem the one-time code with the installed CLI and install the service:

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

Hosted bootstrap is disabled for this development preview. `/runner/releases/latest` and `/runner/releases/stable` report `distributable: false`, `package_name: ""`, `package_version: ""`, `package_spec: ""`, `artifact: null`, `artifacts: null`, and `published_at: null`. The generated scripts fail closed without consuming enrollment codes, accessing the network, running npm, or installing arbitrary packages. The supported manual route is the [portable Runner verification and installation procedure](portable-runner-installation.md), followed by CLI enrollment and service installation. Automatic signed bootstrap, update, and rollback are roadmap items and are not implemented.

## Local Runner profiles and service manifests

Enrollment stores server URL, Runner ID, long-lived credential, and optional concurrency under centralized machine locations:

```text
Linux:   /etc/runmesh/profile.json
macOS:   /Library/Application Support/Runmesh/profile.json
Windows: C:\\ProgramData\\Runmesh\\profile.json
```

The POSIX profile directory/file are created with modes `0700`/`0600`; the Windows provisioner applies Local Service ACLs to Runmesh-owned paths, while `doctor` does not inspect those ACLs. New enrollment profiles record `execution_mode: dedicated_user`; legacy profiles without this field preserve their privileged-host service layout when explicitly confirmed rather than silently changing an installed service. Centrally managed enrollment starts with zero local workspaces; central policy configures roots through the Admin Panel. Re-enrollment replaces credentials/connection data without inferring or adding a workspace. `status` redacts the token. `doctor --json` emits stable required/optional checks for profile directory/file modes, manifest/installed/active service state, Host shell runtime, execution mode, local policy revision when available, and tools; optional Python/Docker failures remain warnings, while required failures are nonzero. `workspace list|add|remove`, `env`, and `doctor` operate against the profile. `start` uses profile defaults unless explicit legacy Runner transport options are provided.

`coding-runner install` invokes the Runmesh service provisioner, writes a hash-marked system service manifest, and automatically activates it through an explicit host adapter. The provisioner creates the Runmesh account/group and Runmesh-owned install/config/state/log directories on Linux and macOS, and applies Local Service ACLs to Runmesh-owned install/config/state/log/profile paths on Windows. New dedicated-user services render Linux `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon `UserName=runmesh`, and Windows `NT AUTHORITY\LOCAL SERVICE` with least privilege. It never changes Workspace ownership or modes: operators must grant that service identity the minimum required access to each configured Workspace. `--execution-mode privileged_host --confirm-privileged-host` is the explicit root/SYSTEM opt-in; legacy profiles without execution mode retain their old privileged layout for compatibility. Linux uses `/opt/runmesh`, `/etc/runmesh`, `/var/lib/runmesh`, `/var/log/runmesh`, and `runmesh-runner.service`. It requires an elevated administrator/root shell and refuses an unmanaged existing manifest. `stop`, `restart`, and `uninstall` invoke their selected adapter; `uninstall` only removes a manifest whose marker and content hash match. `--purge --yes` additionally removes the local profile but leaves configured workspace roots and persistent job state untouched. Use `--user` only for explicit legacy per-user compatibility.

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
