# Runtime configuration and secrets

[简体中文](runtime-config.zh-CN.md) · [Administrator guide](admin-guide.md)

Start with the source defaults and the Worker secrets prepared by the initialization helper. Add an override only when your deployment needs one.

## Required secrets

| Secret | Purpose | During upgrades |
| --- | --- | --- |
| `INTERNAL_CONTROL_SECRET` | Authenticates internal control-plane messages and derives the OAuth encryption key | Preserve the current value; replacement requires OAuth reconnection |
| `RUNNER_TOKEN_PEPPER` | Protects stored Runner token verifiers | Preserve the current value; replacement invalidates current tokens |

The helper generates these two secrets from at least 32 cryptographically random bytes each. OAuth encryption derives its key automatically from `INTERNAL_CONTROL_SECRET`. Cloudflare secrets holds the deployed values; follow the backup guidance below if you need a separate recovery copy. Set the administrator password through the first-setup page.

Dashboard administration uses your administrator session. Configure `ADMIN_TOKEN` when you need programmatic Runner administration.

## Defaults and overrides

| Setting | Default and when to change it |
| --- | --- |
| `WORKER_ID` | Derived from production/development mode; an existing explicit ID remains supported |
| `RUNMESH_PUBLIC_ORIGIN` | Validated HTTPS request URL and matching Host. Set an explicit public HTTPS origin when a reverse proxy supplies an internal request URL |
| `RUNMESH_AUDIT_BACKEND` | D1 in production; development without `HISTORY_DB` uses the Registry Durable Object's SQLite storage. Preserve an intentional backend override |
| `RUNMESH_JOB_HISTORY_BACKEND` | Packed D1 in production; development without `HISTORY_DB` uses the Registry Durable Object's SQLite storage. An explicit `d1` setting requires the binding |
| `CENTRAL_SKILLS_ENABLED` / `CENTRAL_DIRECT_TOOLS_ENABLED` / `CENTRAL_GOVERNANCE_ENABLED` | Enabled with `1` in the checked-in production and development configuration; preserve these settings with the `CAPABILITIES` binding when upgrading shared MCP and Skill features |
| `RUNMESH_SIGNED_RELEASE_AVAILABLE` | The reviewed stable release in production, or disabled for a candidate; `dev` discovery in development. An explicit empty value disables hosted installation |
| `RUNMESH_DEPLOYMENT_BRANCH` / `RUNMESH_DEPLOYMENT_COMMIT` | Build tools read the branch and commit from Git and check any supplied values against it; use [provenance checks](build-provenance.md) to inspect the deployed source |

A public-origin override contains the scheme, hostname and optional port, for example `https://runmesh.example.com`. Leave out paths, query strings, fragments, credentials and whitespace. Use a valid value or remove the override to restore automatic selection. Runmesh derives the default from the direct request URL and Host header; configure the override when a proxy uses a different internal address.

Development uses `RUNMESH_ENVIRONMENT=development`; its checked-in configuration has no D1 binding or retention Cron Trigger. Keep test variables in the local test environment. Preserve the `REGISTRY`, `RUNNER` and `CAPABILITIES` Durable Object namespaces, any existing `HISTORY_DB`, static assets and `CF_VERSION_METADATA` bindings when updating an instance.

## Release and environment selection

The [release status](release-readiness.md) identifies the current stable package. A `released` record in `release/release-state.json` enables the independently verified stable package; a `candidate` record keeps its hosted stable installer disabled while publication is being prepared. Deploy the activated `main` source, then check your Worker's release descriptor for installation availability. An explicit empty `RUNMESH_SIGNED_RELEASE_AVAILABLE` override disables hosted installation.

Production uses protected `main`; candidate testing uses the separate `dev` Worker. The development panel offers a verified signed prerelease from its own channel. Check the version shown in that panel before installation. See [development prereleases](dev-runner-prereleases.md) for publication and refresh timing.

## Initialize missing secrets

After authenticating your Cloudflare CLI and creating the Worker, inspect the required secret names:

```sh
npm run setup:secrets -- --env production
```

Create missing required values:

```sh
npm run setup:secrets -- --env production --apply
```

The helper creates and uploads the missing secrets while preserving existing values. Run initialization with one operator at a time. If the command reports a Cloudflare access or upload error, check the account connection and secret inventory before retrying.

Cloudflare retains the generated keys. If you require an independently recoverable backup, generate and retain values through your secret-management process before uploading them.

## Update or move an installation

Preserve the Worker name, live data bindings, both existing secrets and intentional overrides such as a proxy origin or emergency installer disable. Deploy the updated Worker, then follow the [upgrade guide](upgrading.md) for each Runner.

A new account can provision its own resources and use its routed HTTPS domain. Moving existing data requires a separate transfer plan that includes the original credential-protection keys.

Keep release signing keys in the GitHub release environment and Cloudflare API credentials in the authorized CLI or build connection. The Worker runtime receives only its application secrets.

References: [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/), [resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).
