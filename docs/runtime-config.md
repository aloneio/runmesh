# Minimal runtime variables and secrets

Ordinary production setup needs **two secrets and no manually supplied plaintext variables**. Use the source defaults unless your deployment needs an override. Preserve existing resource bindings and credential values during updates.

## Required secrets

| Secret | Purpose | Update rule |
| --- | --- | --- |
| `INTERNAL_CONTROL_SECRET` | Authenticates internal control-plane messages | Keep the current value when updating |
| `RUNNER_TOKEN_PEPPER` | Protects stored Runner token verifiers | Keep the current value; replacement invalidates current tokens |

Use independent cryptographically random values, at least 32 random bytes encoded as text. Never put them in Wrangler `vars`, source, a build log or an MCP conversation. Browser administrator passwords remain in the administrator setup flow; they are not environment variables.

`ADMIN_TOKEN` is optional, for the advanced programmatic Runner administration API only. Do not set it for dashboard-only use. An already configured ADMIN_TOKEN is not automatically deleted because another operator may use the API.

## Defaults and optional overrides

| Variable | Default | Optional override |
| --- | --- | --- |
| `WORKER_ID` | Production/development mode | An existing explicit ID still works |
| `RUNMESH_PUBLIC_ORIGIN` | Validated HTTPS URL plus matching Host | Keep only for reverse-proxy overrides; an explicit empty/invalid value stays fail-closed |
| `RUNMESH_AUDIT_BACKEND` | Production defaults to D1 | Explicit backend overrides are still supported |
| `RUNMESH_JOB_HISTORY_BACKEND` | Production defaults to packed D1 | Missing production D1 does not fall back to DO history writes |
| `RUNMESH_SIGNED_RELEASE_AVAILABLE` | Production: reviewed released version, or disabled for a candidate; development: `dev` discovery sentinel | An explicit empty value disables hosted installation. Development accepts only a current-series immutable signed dev prerelease and never falls back to stable. |
| `RUNMESH_DEPLOYMENT_BRANCH` / `RUNMESH_DEPLOYMENT_COMMIT` | Verified build-time Git source, compared with provider metadata | Old variables are not treated as proof of compiled source |

The development environment has one non-secret mode marker, `RUNMESH_ENVIRONMENT=development`. Test-only vars remain confined to the local test environment. A fork's public domain does not have to replace an owner's hard-coded URL. Request authority is never taken from X-Forwarded-Host. A reverse proxy using an internal request URL must supply an explicit validated public-origin override.

Bindings are not redundant runtime variables: keep the live Registry/Runner DO namespaces, HISTORY_DB, static assets and CF_VERSION_METADATA. The maintained production D1 name and v2 class identities are unchanged. Wrangler resource provisioning does not require copying an account-specific D1 UUID into the source template.

## Publication safety

The current **0.1.4** source is a candidate and defaults to disabled stable distribution. Availability follows `release/release-state.json`, including the exact version, publication commit and independently verified manifest hash. A package version alone does not activate distribution. Do not set an availability override to make an unpublished candidate appear ready. The previously published immutable v0.1.3 assets remain unchanged.

Production release and deployment require `main`; the production deployment wrapper also refuses an unactivated candidate. Development deploys separately from `dev`. The build records its clean Git commit/tree, with provider version metadata used for comparison when available. Dirty, missing or conflicting source remains unconfirmed. See [Worker build provenance](build-provenance.md) to check the actual deployed commit.

## New-install helper

After authenticating Cloudflare management and creating the Worker, inspect required secrets without changing anything:

```sh
npm run setup:secrets -- --env production
```

Create only missing required secrets:

```sh
npm run setup:secrets -- --env production --apply
```

The helper lists names, rechecks them before mutation, generates independent random values in memory and sends only missing keys through Wrangler stdin. It never prints those values or writes a secret file. A repeat run with both keys present performs no secret write. Failed inventory is not an empty inventory. An uncertain upload is not retried automatically. Do not run secret initialization concurrently on multiple machines.

This is a deliberate setup action, not a Worker cold-start hook or recurring deployment step. The helper needs management authorization; the deployed Worker must not contain a Cloudflare API token. Generated keys are retained by Cloudflare, not recoverable from this helper afterward. Operators needing independent secret backups should provision and retain values through their secure secret-management process instead.

## Upgrade and portability

Deploy the updated source while preserving existing secrets. Ordinary removed plaintext defaults are replaced by deterministic code behavior. Do not remove an intentional proxy override or emergency disable during upgrade; retain such exceptions explicitly in the deployment configuration. Existing optional secrets are not pruned blindly. Configuration changes must not rename the production Worker or its data bindings.

For a new account, the source can provision its own resources and use its own routed HTTPS domain. This is deployment portability, not an automatic data migration: restoring an existing Registry on another account still requires the original credential-protection keys and a separately reviewed data-transfer process.

Release signing keys belong only in the GitHub release environment. Cloudflare API credentials belong only in an authorized local CLI or build connection. Neither belongs in the production Worker's runtime secret list.

Reference: [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/), [automatic resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).
