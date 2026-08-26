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
4. On the host, from the directory to become the initial workspace, redeem it with the supported CLI:

   ```sh
   coding-runner enroll \
     --server https://mcp.example.com/runner/enroll \
     --code '<one-time-enrollment-code>'
   coding-runner start
   ```

   Enrollment obtains the Runner ID and long-lived Runner credential from the response; the command accepts no `--runner-id`. It saves a local profile and adds the current directory as a writable, shell-enabled initial workspace.
5. In **Admin → MCP Clients**, create a client label and least-privilege scopes. Copy the generated one-time MCP URL and configure it directly in the MCP client:

   ```text
   https://mcp.example.com/<secret>/mcp
   ```
6. In that MCP client, call `runner_list`, then `runner_select({"runner_id":"..."})`; use `runner_current` to inspect the persisted client selection. A later change requires `confirm_switch: true`.

The dashboard displays safe Runner details and allows Runner rename, enrollment/re-enrollment, credential rotation, revocation, and deletion. It does not show Runner credentials or workspace roots.

### Public bootstrap and package configuration

The Worker exposes public, cacheable, secret-free `/runner/install.sh` and `/runner/install.ps1` bootstrap scripts. The dashboard renders the corresponding `curl ... | sh -s -- <one-time-code>` or PowerShell command; the code is passed only as a command argument and the generated enrollment page remains `no-store`. Installers require an already installed Node.js 20+ / npm runtime, refuse to overwrite an existing managed profile or service unless explicitly re-enrolled, install per-user, and run `coding-runner enroll` followed by `coding-runner install`. They print service activation commands for the operator to review and run; host service activation remains manual and no system service manager is invoked automatically.

No public npm package is published by this repository. `/runner/releases/latest` therefore returns `distributable: false` until the operator configures a stable package spec through `RUNNER_PACKAGE_SPEC` (an exact `package@x.y.z` or HTTPS `.tgz` URL; GitHub `main` is rejected), with `RUNNER_PACKAGE_NAME` / `RUNNER_PACKAGE_VERSION` required when using a tarball URL. The installers fail clearly when no distributable spec is configured; they never download GitHub main or embed an administrator, MCP, or long-lived Runner credential.

## Local Runner profiles and service manifests

Enrollment stores server URL, Runner ID, long-lived credential, workspace configuration, and optional concurrency under:

```text
Linux:   ~/.remote-coding-runner/profile.json
macOS:   ~/Library/Application Support/RemoteCodingRunner/profile.json
Windows: %LOCALAPPDATA%\RemoteCodingRunner\profile.json
```

The POSIX profile directory/file are created with modes `0700`/`0600`; the Windows path uses normal Windows storage and `doctor` does not inspect ACLs. `status` redacts the token. `workspace list|add|remove`, `env`, and `doctor` operate against the profile. `start` uses profile defaults unless explicit legacy Runner transport options are provided.

`coding-runner install` writes a hash-marked per-user service manifest and refuses an unmanaged existing manifest:

- Linux: systemd user unit;
- macOS: LaunchAgent plist;
- Windows: Scheduled Task XML.

It writes the manifest but only reports the host `systemctl`, `launchctl`, or `schtasks` commands. `stop`, `restart`, and `uninstall` likewise render/report lifecycle commands instead of executing them. `uninstall` only removes a manifest whose marker and content hash match; `--purge --yes` additionally removes the local profile but leaves configured workspace roots and persistent job state untouched. Review and run the reported host command yourself.

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

The local short-operation maximum is 8 seconds and the Worker bridge timeout is 12 seconds; use `exec_start` for longer work. Registry retains active jobs and up to 1,000 terminal jobs per Runner. Complete local logs are unbounded by default and need disk monitoring.

MCP URL path credentials can be captured by infrastructure outside application code. Configure Cloudflare log redaction, retain a rotation/revocation procedure, and perform deployed acceptance testing before production use.
