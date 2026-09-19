# Runtime configuration and secrets

[简体中文](runtime-config.zh-CN.md) · [Administrator guide](admin-guide.md)

Start with the source defaults and two independent Worker secrets. Add an override only when your deployment needs one.

## Required secrets

| Secret | Purpose | During upgrades |
| --- | --- | --- |
| `INTERNAL_CONTROL_SECRET` | Authenticates internal control-plane messages | Preserve the current value |
| `RUNNER_TOKEN_PEPPER` | Protects stored Runner token verifiers | Preserve the current value; replacement invalidates current tokens |

Generate each value from at least 32 cryptographically random bytes encoded as text. Store them as Cloudflare secrets and keep them out of source, logs and conversations. Set the administrator password through the first-setup page.

For programmatic Runner administration, also configure `ADMIN_TOKEN`. Dashboard-only installations can use the two required secrets.

## Defaults and overrides

| Setting | Default and when to change it |
| --- | --- |
| `WORKER_ID` | Derived from production/development mode; an existing explicit ID remains supported |
| `RUNMESH_PUBLIC_ORIGIN` | Validated HTTPS request URL and matching Host. Set an explicit public HTTPS origin when a reverse proxy supplies an internal request URL |
| `RUNMESH_AUDIT_BACKEND` | D1 in production; preserve an intentional backend override |
| `RUNMESH_JOB_HISTORY_BACKEND` | Packed D1 in production; keep the `HISTORY_DB` binding available |
| `RUNMESH_SIGNED_RELEASE_AVAILABLE` | The reviewed stable release in production, or disabled for a candidate; `dev` discovery in development. An explicit empty value disables hosted installation |
| `RUNMESH_DEPLOYMENT_BRANCH` / `RUNMESH_DEPLOYMENT_COMMIT` | Deployment identity comes from verified build-time Git source and is compared with provider metadata; use [provenance checks](build-provenance.md) to inspect it |

A public-origin override must be a complete HTTPS origin, without a path, query, fragment, credentials or whitespace. An empty or invalid override rejects requests that require a public origin. Runmesh validates the request itself rather than using forwarded host headers.

Development uses `RUNMESH_ENVIRONMENT=development`. Keep test variables in the local test environment. Preserve the Registry/Runner Durable Object namespaces, `HISTORY_DB`, static assets and `CF_VERSION_METADATA` bindings when updating an existing instance.

## Release and environment selection

Current source is the **0.1.4 candidate**, with stable distribution disabled. Production becomes available after signed publication, independent verification and reviewed activation in `release/release-state.json`. Keep this recorded state as the source of installation availability.

Production uses protected `main`; candidate testing uses the separate `dev` Worker. Development selects a verified signed prerelease from its own channel and closes hosted installation when that selection is unavailable. See [development prereleases](dev-runner-prereleases.md).

## Initialize missing secrets

After authenticating your Cloudflare CLI and creating the Worker, inspect the required secret names:

```sh
npm run setup:secrets -- --env production
```

Create missing required values:

```sh
npm run setup:secrets -- --env production --apply
```

The helper rechecks the inventory, generates independent values in memory and uploads missing keys through Wrangler stdin. Existing values remain intact. Keep initialization to one operator at a time. If inventory fails, resolve the Cloudflare access problem; if an upload result is uncertain, check the secret inventory before another attempt.

Cloudflare retains the generated keys. If you require an independently recoverable backup, generate and retain values through your secret-management process before uploading them.

## Update or move an installation

Preserve the Worker name, live data bindings, both required secrets and intentional overrides such as a proxy origin or emergency installer disable. Deploy the updated Worker, then follow the [upgrade guide](upgrading.md) for each Runner.

A new account can provision its own resources and use its routed HTTPS domain. Moving existing data requires a separate transfer plan that includes the original credential-protection keys.

Keep release signing keys in the GitHub release environment and Cloudflare API credentials in the authorized CLI or build connection. The Worker runtime receives only its application secrets.

References: [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/), [resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).
