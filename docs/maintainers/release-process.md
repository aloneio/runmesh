# Publication and activation

[Maintainer documentation](README.md) · [Current release status](../release-readiness.md)

## Prepare the release

Keep package and lockfile versions, installer identity and release notes aligned at the selected version. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](../main-promotion-policy.md).

Prepare publication notes in `docs/releases/<version>.md`, starting with `# Runmesh <version>`. The release workflow uses these versioned notes. Use the [deployment checklist](../central-rollout.md) for real-client and MCP provider checks, and keep their results with the release verification record.

## Verify and publish

The exact main source must pass GitHub `verify-all`, native-platform, Node LTS and browser verification, plus the required cross-provider checks. Execute the security regressions for that source, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to the same reviewed commit. The protected GitHub and GitLab main branches must point to that source before signing.

Independently verify draft and public assets before recording the release as `released`. Keep existing immutable releases intact. Retain the source commit, gate results and asset checksums with the publication record.

## Activate and check the installation

After completing [independent package verification](../portable-runner-installation.md#independently-verify-a-downloaded-package), update `release/release-state.json` with the verified publication evidence:

```json
{
  "version": "<version>",
  "state": "released",
  "release_branch": "main",
  "release_commit": "<manifest commit_sha>",
  "manifest_sha256": "<SHA256 of the verified public manifest.json>"
}
```

Use the published version, its full 40-character source commit and the manifest's 64-character SHA256 digest. Generate and check the compiled activation:

```sh
npm run generate:version
npm run generate:facts
npm run check:docs
node scripts/check-release-contract.mjs --require-distributable
```

The publication workflow requires the exact `verify-all` gate set. **RELEASED** records the independently verified publication, and generation places the selected version in `REVIEWED_RELEASE_VERSION`. **ENABLED** is confirmed after deployment when `/runner/releases/stable` returns that version with `distributable: true`. Production uses the generated version as its default activation value, together with a valid public origin and disabled test mode. An explicit empty `RUNMESH_SIGNED_RELEASE_AVAILABLE` override pauses hosted distribution.

Include `apps/worker/src/generated-release.ts` and the current release status in the activation change. Verify and promote that change through `dev` to protected `main`, then deploy it through the [production deployment procedure](../deployment.md#select-the-environment).

The publication commit identifies the signed Runner package and remains in `release_commit`. The later activation commit identifies the Worker that selects that package for stable installations. Compare `/health` with the activation commit using [build provenance](../build-provenance.md#verify-a-deployment), and confirm that `/runner/releases/stable` selects the published version. Complete the Runner service lifecycle and permission checks in the [upgrade guide](../upgrading.md).

Runmesh uses the existing `INTERNAL_CONTROL_SECRET` for OAuth encryption and `RUNNER_TOKEN_PEPPER` for Runner credentials. Preserve both values during upgrades. For a new deployment, follow the [runtime configuration guide](../runtime-config.md) to initialize them.

Record development deployment, signed publication and production acceptance with their corresponding source commits and verification results.

## Release-specific verification

For each release, verify maintenance responses and release artifact reads when the complete body arrives before stream close or EOF. The completion path checks the signal immediately before recording success, so a cancellation remains visible to the caller and the operation can be retried safely. Record the full test matrix, signed asset checksums, protected branch promotion and production acceptance with the publication record.
