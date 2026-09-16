# Automatic development Runner prereleases

The dedicated GitHub `Dev Runner Prerelease` workflow publishes a **prerelease**, not a stable release, on every fifth dev push that starts this workflow. The stable `Release` workflow remains main-only; its version/key checks now use a reviewed source contract rather than a hard-coded version. No deployed Worker, hosted stable-installer pointer, credential, production namespace or installed Runner is changed by publishing a development archive.

## Counting and versions

The workflow is exclusively `push` on `dev`, with no path filters, PR, tag, manual or reusable triggers. Its own `github.run_number` is the push counter: 5, 10, 15, and so on are release opportunities. A push containing several commits counts once. A merge into dev counts as one push. Mirroring the same push to GitLab does not count a second time. `run_attempt` is not counted; retry through Actions **Re-run jobs**, not by adding a manual trigger to this workflow.

Counting begins when this new workflow is introduced; earlier repository pushes are not reconstructed. Workflow-disabled pushes and GitHub skip-CI events that never create a run cannot be counted by this design. Do not rename/recreate this workflow or add other triggers without reviewing the counter migration and tag collisions.

At the start of a due batch, main's version must match the latest published immutable stable release, its reviewed release-state evidence and an authenticated signed manifest. The selected main commit must be an ancestor of the fixed dev source. Only then is the patch incremented. The suffix is `-dev.<batch index>`, beginning at zero. For a verified main version of `0.1.3`, pushes 5, 10 and 15 plan `0.1.4-dev.0`, `0.1.4-dev.1` and `0.1.4-dev.2`. A verified main version of `0.1.1` instead starts with `0.1.2-dev.0`.

The batch index is global to this workflow, not reset by a stable release. For example, if main becomes `0.1.4` before push 20, that batch is `0.1.5-dev.3`. Failed batches may leave gaps; they never publish unverified code merely to maintain contiguous numbering.

The first attempt stores a closed schema-2 plan containing the triggering SHA/tree, main SHA/version, stable release ID, signed source commit, reviewed manifest SHA-256, push number, workflow run ID, version/tag and source timestamp. This plan is uploaded before verification or signing and reused unchanged on retries, even if main has advanced. Plan artifacts are retained for 90 days; missing/expired plan evidence fails closed instead of silently assigning a different version. Legacy schema-1 plans stay readable for verifying completed historical releases but cannot authorize a new publication.

## Main upgrades and obsolete batches

A version-only main bump, an unactivated candidate, a mismatching Latest release, an unmerged main commit or a bad signature blocks a new batch. The observer reads the trust keyring from the fixed main source, not from a downloaded keyring, and verifies that the annotated stable tag, signed manifest commit and reviewed `release/release-state.json` agree. The current main snapshot and original signed release commit are separate identities: later reviewed history maintenance must not falsify the historical signed commit.

Use a normal reviewed merge to synchronize main into dev. The release task never merges or rewrites branches. Cherry-picks or squash-equivalent trees do not pass the conservative ancestry rule automatically. A later main commit also needs to be included before a new batch can proceed.

Before signing and immediately before a draft becomes public, the workflow observes the stable baseline again. A different stable release marks the unpublished batch `dev_release_superseded`: no version reassignment, no tag/asset overwrite and no public transition. A draft already uploaded before an upgrade remains a draft. A complete immutable release instead takes a read-only verification path using the original source trust keyring and exact built archive; it skips signing and mutable publication checks on a publish-job retry. A full workflow retry may still repeat its earlier source/build checks.

Main and Latest are re-read after downloading signature evidence to reject mixed snapshots. The final prepublication check minimizes the race window, but GitHub does not offer an atomic transaction spanning branch/ref observations and release publication. These guards must not be described as a distributed lock against a simultaneous external main update. No existing immutable release is deleted or rewritten to hide a detected conflict.

To prepare a future **stable** release, review and synchronize the root/workspace/lock versions, the source-pinned installer version and key, and a `release-state.json` with `state=candidate`, `release_branch=main`, and no old release commit/hash. `scripts/stable-publication.mjs` validates the stable version, candidate lifecycle and embedded public key against the source keyring. Existing version, documentation, full CI, owner, exact-main-tip and signature gates still apply. After public asset verification, record the new released commit/manifest hash through the existing reviewed activation process. Dev prereleases wait for that completed state rather than guessing that a candidate was published.

## Build and trust boundary

The original checked-out manifests keep their stable source version. The dev builder reuses the existing Runner prepack/declaration pipeline and shared bundler, overrides only ignored distribution bytes, and creates an isolated staging package with the planned version. The signed archive includes `build-inputs.json` containing that plan. The tag and signed manifest point to the actual source commit; the staged version override is explicit and reproducible, not an uncommitted source rewrite.

The exact staged archive is installed offline into a separate directory and tested through the existing real MCP/Worker/Runner suite. Both the installed package version and actual CLI `--version` must equal the plan. The regular source CI still runs its complete Linux, Windows, macOS, LTS, browser and integration gates. Release verification has a run-specific concurrency group, so a newer ordinary dev push cannot cancel it.

The historical Job workspace-binding version floor also recognizes this explicit dev lane using correct prerelease ordering: `0.1.4-dev.0` is newer than stable `0.1.1`; `0.1.1-dev.0` and older previews remain rejected. Version compatibility does not bypass client, workspace, policy or actual Job identity checks.

The development prerelease is signed only after the same run's required GitHub reusable verification succeeds. That aggregate includes the repository verification, browser suite, native Linux/Windows/macOS Runner checks and maintained Node LTS checks. GitLab `dev` is a downstream mirror/deployment trigger after GitHub `verify-all`; GitLab SaaS compute quota and Cloudflare external commit statuses are deliberately not Runner-signing prerequisites. Stable/main publication keeps its separate cross-provider release policy.

Signing reuses the existing `RELEASE_SIGNING_KEY`, `RELEASE_SIGNING_KEY_ID` and checked-in trust keyring. Only the publish job receives the private signing key, only during the signing step. Configure the separate GitHub environment `dev-release` to allow **only branch dev**. Do not broaden the existing main-only `release` environment.

The publisher creates an annotated tag with the private project Git identity, creates a draft with `prerelease=true` and `make_latest=false`, uploads exactly the established nine assets, re-downloads and verifies them, then publishes. Publication must return `immutable=true`, followed by another download/signature/content check. The stable Latest release is not changed. Assets include the portable `.tgz`, signed manifest, signature descriptor, SHA256SUMS, trust keyring and notices.

## Recovery and use

An existing tag must have the exact source and plan annotation. An existing draft must belong to this run's plan, and every uploaded byte must match before missing assets are uploaded. No tag update, asset overwrite or `--clobber` is allowed. A verified published retry performs read-only verification and does not republish. Conflicting or malformed evidence requires operator investigation.

Use **Re-run failed jobs** after correcting a temporary CI, mirror, API or environment problem. The publish job references the build job's recorded attempt, not blindly the new run attempt, so a retry that reuses a successful build downloads the correct original artifact. Full reruns produce a separately named build artifact. Different batches have independent run-ID locks and unique versions, avoiding shared pending-run eviction.

Publishing makes the prerelease archive eligible for the development Worker. `runmeshdev` discovers only complete, immutable GitHub prereleases whose tags match the dev version contract, then renders an installer pinned to that exact tag. The installer still verifies the signed manifest, channel, prerelease flag, artifact URL and checksum with the embedded trusted Ed25519 public key. Discovery failure disables development bootstrap; it never falls back to the stable Runner. Production remains pinned to the reviewed stable release. Publishing does **not** automatically upgrade/restart already connected Runners or promote dev to main.

## Ownership and verification

`scripts/dev-release/policy.mjs` owns pure counting/version/plan rules; `plan.mjs` observes source and Actions context; `build.mjs` owns isolated packaging; the required reusable GitHub CI owns release verification; `publisher.mjs` owns the testable publication state transitions; `github.mjs` and `publish.mjs` own API/filesystem adapters. Shared bundling, manifest and signature primitives are reused. Runtime Runner/Worker modules do not depend on release automation.

`test/dev-release.test.mjs` is registered in the existing tooling lane on both providers. It covers cadence, malformed plans, stable-lane separation, version injection, API failures, output bounds, partial drafts, published retries, conflicting tags/assets, exact-source CI and workflow permissions/dependencies. Actual signing, hosted Actions scheduling, immutable GitHub publication and installation require their own observed evidence; local fixtures are not live publication evidence.

## Development installer availability

Development HTTP release, installer, maintenance and administrator enrollment/detail routes use the same verified dev-only descriptor. A cached descriptor is fresh for 60 seconds. For up to one hour from its original signature verification, it can be served immediately while a request-owned `waitUntil` refresh runs. The complete outbound refresh has a 20-second deadline; a slow GitHub request must not hold a usable installer response open. Failed refreshes never update the verification timestamp. Future-dated or expired cache records are not served, and unavailable results remain `no-store`.

Publication dates do not determine version order: a delayed older prerelease must not displace a newer dev sequence. Cache data is projected to the public allow-list. Signature checks, the deployment gate and the prohibition on development-to-stable fallback remain mandatory. A healthy `/health` response alone is not installer acceptance; verify both POSIX/PowerShell installer pins and the selected release, including after the freshness window expires.
