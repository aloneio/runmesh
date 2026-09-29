# Release status and readiness

[Documentation](README.md) · [Chinese](README.zh-CN.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current status: 0.1.6 candidate; 0.1.5 stable

| Version | Status | Use |
| --- | --- | --- |
| `0.1.6` | CANDIDATE; not signed or published | Release preparation and development verification |
| `0.1.5` | RELEASED; signed stable distribution verified | Current production installation and recovery |
| `0.1.4` | RELEASED; previous stable distribution | Existing installations and historical recovery |

The deployed stable channel serves 0.1.5. The 0.1.6 candidate aligns the package, lockfile and installer identities without reusing the prior release signature or activation record. Candidate commits preserve the running production Worker until independent signed-asset verification and a reviewed activation are complete.

The candidate includes production bindings and exports for MCP connections and shared Skills, alongside the existing Registry and Runner namespaces. Run `npm run setup:secrets -- --env production` to inspect initialization requirements; its explicit `--apply` action creates only missing values for the two existing secrets. OAuth encryption derives its key from `INTERNAL_CONTROL_SECRET`. Retain both existing secrets during upgrades.

Before promotion, complete the real-client and supplier checks in the [central rollout ledger](central-rollout.md) and obtain exact-source evidence from both CI providers. A successful development deployment is not a substitute for these release checks.

## Choosing an installation or upgrade

Choose a verified signed release containing the changes you need. During a compatible upgrade, preserve existing resources, credentials and profiles. Do not use a candidate package on production hosts until its signed release and activation record are complete.

## Maintainer publication checklist

For each new release, keep package and lockfile versions, installer identity and release notes aligned at the selected version. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](main-promotion-policy.md).

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

After activation, deploy the Worker, verify its build provenance and release descriptor, then verify the installed Runner service lifecycle and permissions. The protected GitHub and GitLab main branches must point to the same reviewed source commit before signing.
