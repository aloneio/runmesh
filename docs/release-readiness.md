# Release status and readiness

[Documentation](README.md) · [Chinese](README.zh-CN.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current status: 0.1.5 candidate

| Version | Status | Use |
| --- | --- | --- |
| `0.1.5` | CANDIDATE; stable distribution pending signed publication | Production rollout after the reviewed release is published and the activated `main` source is deployed |
| `0.1.4` | RELEASED; previous stable distribution | Existing installations and recovery until 0.1.5 activation |

The 0.1.5 candidate contains the Windows Task Scheduler probe fix. Its signed portable package is still being built and independently verified; the existing immutable 0.1.4 release remains unchanged. Stable hosted installation stays bound to the reviewed release record and is enabled only after publication.

## Choosing an installation or upgrade

Choose a verified signed release containing the changes you need. During a compatible upgrade, preserve existing resources, credentials and profiles. Do not use a candidate package on production hosts until its signed release and activation record are complete.

## Maintainer publication checklist

For each new release, keep package and lockfile versions, installer identity and release notes aligned at the selected version. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](main-promotion-policy.md).

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

After activation, deploy the Worker, verify its build provenance and release descriptor, then verify the installed Runner service lifecycle and permissions.