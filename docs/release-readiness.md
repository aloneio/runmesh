# Release status and readiness

[Documentation](README.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current status: 0.1.4 released

| Version | Status | Use |
| --- | --- | --- |
| `0.1.4` | RELEASED; stable distribution ENABLED in source | Production installation after deploying activated `main` source |
| `0.1.3` | Previous published stable release | Existing installations and its original signed package |

The signed stable release is published under tag `v0.1.4`, with portable package `runmesh-runner-0.1.4.tgz`. Its public assets have been independently verified. The reviewed activation in [release-state.json](../release/release-state.json) records the signed source commit and manifest hash and enables stable hosted distribution in source. Use [trust-keyring.json](../release/trust-keyring.json) as the independent signature trust source.

See the [release notes](release-notes.md) for 0.1.4 improvements and [development prereleases](dev-runner-prereleases.md) for testing packages. After deploying activated `main` source, use [build provenance](build-provenance.md) to verify the live Worker commit and check its `/runner/releases/latest` descriptor for installation availability. Follow the [upgrade guide](upgrading.md) to check and update each installed Runner.

## Choosing an installation or upgrade

Choose a verified signed release containing the changes you need. During a compatible v2 upgrade, preserve existing resources, credentials and profiles.

Deploy the Worker, install the target Runner package on each host, and refresh the MCP client's tool catalog. Before restoring workloads, verify permissions and follow a test `shell` receipt with queries for that same Job.

## Maintainer publication checklist

For each new release, keep package and lockfile versions, installer identity and release notes aligned at the selected version. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](main-promotion-policy.md).

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

After deployment, verify the Worker version, installed Runner service lifecycle, permissions and intended client catalog. Record each observation with its time, exact version or commit, and result.

Maintainer references: [main promotion policy](main-promotion-policy.md), [verification](verification.md) and [historical release evidence](maintainers/release-evidence.md).
