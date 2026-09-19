# Release status and readiness

[Documentation](README.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current status: 0.1.4 candidate

| Version | Status | Use |
| --- | --- | --- |
| `0.1.3` | Published stable release | Production installation |
| `0.1.4` | CANDIDATE; stable distribution DISABLED | Development testing through the verified prerelease channel |

The planned stable tag is `v0.1.4`, and its portable artifact name is `runmesh-runner-0.1.4.tgz`. Signed publication, independent verification and a reviewed activation commit advance the lifecycle to RELEASED and distribution to ENABLED. The source record is [release-state.json](../release/release-state.json), and the independent signature trust source is [trust-keyring.json](../release/trust-keyring.json).

See the [release notes](release-notes.md) for candidate improvements and [development prereleases](dev-runner-prereleases.md) for testing packages. Use [build provenance](build-provenance.md) to identify your deployed Worker and the [upgrade guide](upgrading.md) to check the installed Runner.

## Choosing an installation or upgrade

Choose a verified signed release containing the changes you need. During a compatible v2 upgrade, preserve existing resources, credentials and profiles.

Deploy the Worker, install the target Runner package on each host, and refresh the MCP client's tool catalog. Before restoring workloads, verify permissions and follow a test `shell` receipt with queries for that same Job.

## Maintainer publication checklist

For this candidate, keep package and lockfile versions, installer identity and release notes aligned at `0.1.4`. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](main-promotion-policy.md).

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

After deployment, verify the Worker version, installed Runner service lifecycle, permissions and intended client catalog. Record each observation with its time, exact version or commit, and result.

Maintainer references: [main promotion policy](main-promotion-policy.md), [verification](verification.md) and [historical release evidence](maintainers/release-evidence.md).
