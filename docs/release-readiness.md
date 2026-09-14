# Release readiness — 0.1.2

**State: RELEASED. Hosted distribution: ENABLED in the checked-in production configuration.** The immutable stable release was published at `2026-09-14T07:46:46Z` from `0b45a519febfea865bc562f4b147b616ab6ddef6` by successful Release workflow `34819111848`. All nine public assets were fetched without GitHub authentication and independently checked against the trusted source keyring. The manifest SHA256 is `abfd4d24a398abe1156ea2a8e600887f04822c854a66fea6b1fdef8dfc00d2f6`; the Runner tarball SHA256 is `dd0b766c3f96b66450b56f78a6c70ef9bb2eaadeee7d3e300bbb57316646056a` (681483 bytes). Production activation still requires this commit to reach Cloudflare via GitLab dev; do not equate this configuration state with a completed deployment. `release/release-state.json` records the reviewed publication identity.

## Release contract

Version `0.1.2`, annotated tag `v0.1.2`, stable channel, `prerelease=false`, protocol v2, artifact `runmesh-runner-0.1.2.tgz`. The existing reviewed Ed25519 public key `runmesh-preview-2026-01` remains the trust root. Existing immutable releases must not be rebuilt or replaced.

## Required gates

The exact protected dev commit must pass `verify-all` across supported Node LTS and native OS checks. The final tarball is installed offline with scripts disabled and runs real Worker/Runner E2E before signing. The release workflow also checks that the audited production health contract is deployed before creating a tag.

The signed manifest binds the artifact hash/size and commit. Draft assets must be downloaded and checked before publication, followed by a second public download check. Repository immutable releases must be enabled and the final release must report `immutable: true`.

Those publication checks passed; this activation sets the state RELEASED and hosted distribution ENABLED with `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.2`. Activation must reach both GitHub and GitLab dev, followed by public release/installer probes and an authenticated transport canary. A successful webhook or CI alone is not proof of production activation.

## Scope and cost evidence

Includes batched metadata uploads, manual bounded Job/log reads, optional retention, complete Context/preview/diagnostics authorization mapping, and archive fault isolation. See [release-chain audit](release-chain-audit.md) and [batching contract](batched-job-history.md).

Daily-cadence regression: no changed state means zero additional archive uploads; off mode creates no sync timer. Required heartbeats and bounded expiry maintenance still consume resources. These tests do not represent account-wide production usage or guarantee free-plan capacity.

## Rollout boundaries

Existing v0.1.1 hosts are not automatically upgraded or restarted. Source-side batching and local retention become available in the new signed package; live clients must refresh their cached MCP tool catalog to use workspace-bound Job fields. Hosted installation remains new-install-only; never overwrite an unmanaged installation or delete local state to upgrade the maintained Runner.

All v2 migrations are the explicitly tested additive history changes. Preserve credentials, the existing DO namespace, workspaces, live processes and local logs. No paid plan, credential rotation or data reset is part of this release.
