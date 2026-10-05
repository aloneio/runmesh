# Publication and activation

[Maintainer documentation](README.md) · [Current release status](../release-readiness.md)

## Prepare the candidate

Keep package and lockfile versions, installer identity and release notes aligned at the selected version. Promote reviewed changes from `dev` to protected `main` through the [main promotion policy](../main-promotion-policy.md).

Prepare publication notes in `docs/releases/<version>.md`, starting with `# Runmesh <version>`. The release workflow uses these versioned notes. Record real-client and MCP provider checks in the [central rollout ledger](../central-rollout.md).

## Verify and publish

The exact main candidate must pass GitHub `verify-all`, native-platform, Node LTS and browser verification, plus the required cross-provider checks. Execute candidate-bound security regressions, verify the exact portable archive end to end, and bind the signed manifest and annotated tag to that candidate. The protected GitHub and GitLab main branches must point to the same reviewed source before signing.

Independently verify draft and public assets before recording the new RELEASED/ENABLED state. Keep existing immutable releases intact. Retain the candidate commit, gate results and asset checksums with the publication record.

## Activate and check the installation

Deploy the reviewed release activation to select the published package for stable installations. Check the deployed Worker's build provenance at `/health` and its signed package descriptor at `/runner/releases/stable`, then verify the installed Runner service lifecycle and permissions.

Runmesh uses the existing `INTERNAL_CONTROL_SECRET` for OAuth encryption and `RUNNER_TOKEN_PEPPER` for Runner credentials. Preserve both values during upgrades. For a new deployment, follow the [runtime configuration guide](../runtime-config.md) to initialize them.

Record development deployment, signed publication and production acceptance with their corresponding source commits and verification results.
