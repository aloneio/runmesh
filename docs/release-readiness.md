# Release status and readiness

[Documentation](README.md) · [Chinese](README.zh-CN.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current release: 0.1.6

| Version | Status | Use |
| --- | --- | --- |
| `0.1.6` | RELEASED; signed public package independently verified | Installation and upgrades with the reviewed control-plane activation |
| `0.1.5` | RELEASED; previous signed stable distribution | Existing installations and recovery |
| `0.1.4` | RELEASED; previous stable distribution | Existing installations and historical recovery |

The 0.1.6 signed Runner package is published and independently verified. Deploy the reviewed release activation to select this version for stable installations. Check the deployed Worker at `/health` and its signed package descriptor at `/runner/releases/stable` before updating Runners.

Runmesh 0.1.6 includes production bindings and exports for MCP connections and shared Skills, alongside the existing Registry and Runner namespaces. Run `npm run setup:secrets -- --env production` to inspect initialization requirements; its explicit `--apply` action creates only missing values for the two existing secrets. OAuth encryption derives its key from `INTERNAL_CONTROL_SECRET`. Retain both existing secrets during upgrades.

For each promotion, record real-client and supplier checks in the [central rollout ledger](central-rollout.md), obtain exact-source evidence from both CI providers, and distinguish development deployment, signed publication and production acceptance.

## Choosing an installation or upgrade

Choose the verified 0.1.6 package and follow the [upgrade guide](upgrading.md) to deploy the reviewed activation, update Runners and refresh client catalogs. Preserve existing resources, credentials and profiles. Rehearse the full combination in a test environment before applying it to production.

## Maintainer publication checklist

For each new release, keep package and lockfile versions, installer identity and release notes aligned at the selected version. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](main-promotion-policy.md).

Prepare the publication notes in `docs/releases/<version>.md`, starting with `# Runmesh <version>`. The release workflow uses this version's notes; the documentation index and release status track the candidate, publication and activation separately.

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

After activation, deploy the Worker, verify its build provenance and release descriptor, then verify the installed Runner service lifecycle and permissions. The protected GitHub and GitLab main branches must point to the same reviewed source commit before signing.
