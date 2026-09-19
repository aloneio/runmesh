# Release status and readiness

[Documentation](README.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current status: 0.1.4 candidate

**0.1.4 is not yet published as a stable release. State: CANDIDATE. Stable distribution: DISABLED.** Use the [release notes](release-notes.md) to see its planned improvements. Production deployment and stable installation remain gated until signed publication, independent verification and a reviewed activation commit set the lifecycle to RELEASED and distribution to ENABLED.

The latest published stable release is `v0.1.3`; its archives remain unchanged. The planned 0.1.4 tag is `v0.1.4`, and its portable artifact name is `runmesh-runner-0.1.4.tgz`. A filename or source version alone does not establish that an asset is available or verified. The checked-in status is recorded in [release-state.json](../release/release-state.json); independent signature verification uses [trust-keyring.json](../release/trust-keyring.json).

Development deployments can run candidate code while stable distribution remains disabled. Development Runner packages use a [separate prerelease channel](dev-runner-prereleases.md). Check the health/version of your own Worker and the installed Runner separately; this page does not report live deployment health.

## Choosing an installation or upgrade

For production, wait for a verified signed release that contains the changes you need, then follow the [upgrade guide](upgrading.md). Preserve existing v2 resources, credentials and profiles. Historical clean-break migration instructions do not apply to a compatible update.

Publishing a package, deploying a Worker, upgrading a Runner and refreshing an MCP client's tool catalog are separate operations. A Worker update does not install new Runner code or restart its service. Before restoring workloads, verify permissions and follow a test `shell` receipt with queries for that same Job.

## Maintainer publication checklist

For this candidate, keep package and lockfile versions, installer identity and release notes aligned at `0.1.4`. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](main-promotion-policy.md).

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

After deployment, separately verify the Worker version, installed Runner service lifecycle, permissions and the intended client catalog. Record each observation with its time, exact version or commit, and result; source CI and signed publication cannot substitute for installed-component checks.

The [main promotion policy](main-promotion-policy.md), [verification reference](verification.md) and [historical release evidence](maintainers/release-evidence.md) provide maintainer detail. Dated audit reports retain historical findings and limitations; they are not a current user upgrade procedure or a substitute for new-candidate evidence.
