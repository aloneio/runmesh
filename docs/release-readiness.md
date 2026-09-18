# Release status and readiness

[Documentation](README.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Prepared stable candidate: 0.1.4

**State: CANDIDATE. Distribution: DISABLED for 0.1.4 until signed publication and independent verification complete.** This record describes the checked-in candidate, not a claim that 0.1.4 is already published or deployed. Its lifecycle becomes RELEASED and its fixed installer becomes ENABLED only through a separately reviewed activation commit.

The candidate version is `0.1.4`, its future stable tag is `v0.1.4`, and its portable artifact is `runmesh-runner-0.1.4.tgz`. [release-state.json](../release/release-state.json) intentionally contains no previous release commit or manifest hash. The independent trust source remains [trust-keyring.json](../release/trust-keyring.json). Existing immutable `v0.1.3` and development prereleases are not replaced.

The standard production installer is pinned by the reviewed release state. Publishing does not deploy a Worker, update a Runner, restart services or refresh an MCP client. Check your actual components using the [upgrade guide](upgrading.md). Development distribution is a separate prerelease channel; it does not replace stable distribution.

## Candidate contents and installation

The [0.1.4 release notes](release-notes.md) describe the task-control, recovery, MCP, history and release-hardening changes. A source version label, local tests or a development archive cannot certify those changes as shipped. Do not reuse the 0.1.3 release commit or manifest hash for a new build.

For users, wait for the appropriate verified signed release and an operator-approved upgrade. Preserve existing v2 resources, credentials and profiles; do not follow historical clean-break migrations for a compatible update.

## Maintainer publication checklist

Before publication, choose a new stable version and synchronize package/lock versions, installer identity, release notes and a fresh candidate lifecycle. Promote reviewed changes from `dev` to protected `main` without bypassing its required checks.

The exact main candidate must pass GitHub `verify-all`, native-platform/Node LTS/browser verification and the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact.

Separately verify production deployment, installed Runner service lifecycle, permissions, `shell` to same-Job follow-up, and the intended client catalog. Source CI, signed publication and installed-component acceptance are distinct evidence. This documentation update does not perform or authorize a stable publication.

The [main promotion policy](main-promotion-policy.md), [verification reference](verification.md) and [historical release evidence](maintainers/release-evidence.md) provide maintainer detail. Dated audit reports retain historical findings and limitations; they are not a current user upgrade procedure or a substitute for new-candidate evidence.
