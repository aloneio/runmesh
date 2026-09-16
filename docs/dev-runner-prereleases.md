# Automatic development Runner prereleases

The dedicated GitHub `Dev Runner Prerelease` workflow publishes a **prerelease**, not a stable release, on every fifth dev push that starts this workflow. The existing stable `Release` workflow remains main-only and unchanged. No deployed Worker, hosted stable-installer pointer, credential, production namespace or installed Runner is changed by publishing a development archive.

## Counting and versions

The workflow is exclusively `push` on `dev`, with no path filters, PR, tag, manual or reusable triggers. Its own `github.run_number` is the push counter: 5, 10, 15, and so on are release opportunities. A push containing several commits counts once. A merge into dev counts as one push. Mirroring the same push to GitLab does not count a second time. `run_attempt` is not counted; retry through Actions **Re-run jobs**, not by adding a manual trigger to this workflow.

Counting begins when this new workflow is introduced; earlier repository pushes are not reconstructed. Workflow-disabled pushes and GitHub skip-CI events that never create a run cannot be counted by this design. Do not rename/recreate this workflow or add other triggers without reviewing the counter migration and tag collisions.

At the start of a due batch, the workflow reads the stable version from the actual main commit and increments its patch. The suffix is `-dev.<batch index>`, beginning at zero. For a main version of `0.1.3`, pushes 5, 10 and 15 plan `0.1.4-dev.0`, `0.1.4-dev.1` and `0.1.4-dev.2`. A main version of `0.1.1` instead starts with `0.1.2-dev.0`.

The batch index is global to this workflow, not reset by a stable release. For example, if main becomes `0.1.4` before push 20, that batch is `0.1.5-dev.3`. Failed batches may leave gaps; they never publish unverified code merely to maintain contiguous numbering.

The first attempt stores a closed plan containing the triggering SHA/tree, main SHA/version, push number, workflow run ID, version/tag and source timestamp. This plan is uploaded before verification or signing and reused unchanged on retries, even if main has advanced. Plan artifacts are retained for 90 days; missing/expired plan evidence fails closed instead of silently assigning a different version.

## Build and trust boundary

The original checked-out manifests keep their stable source version. The dev builder reuses the existing Runner prepack/declaration pipeline and shared bundler, overrides only ignored distribution bytes, and creates an isolated staging package with the planned version. The signed archive includes `build-inputs.json` containing that plan. The tag and signed manifest point to the actual source commit; the staged version override is explicit and reproducible, not an uncommitted source rewrite.

The exact staged archive is installed offline into a separate directory and tested through the existing real MCP/Worker/Runner suite. Both the installed package version and actual CLI `--version` must equal the plan. The regular source CI still runs its complete Linux, Windows, macOS, LTS, browser and integration gates. Release verification has a run-specific concurrency group, so a newer ordinary dev push cannot cancel it.

Before signing, the same dev commit must have successful GitLab push-pipeline `verify` and `browser` jobs, with no allowed failures. The bounded wait is at most 40 observations with 30-second pauses; unavailable or failed evidence never becomes success. This project's GitLab mirror is private: configure `GITLAB_READ_API_TOKEN` in the GitHub `dev-release` environment using a project-scoped `read_api` token with Reporter access. Do not copy the operator's broad management token. Missing configuration produces an explicit failure, not an anonymous-query fallback. GitHub verification is an explicit required reusable-workflow dependency of the same release run.

Signing reuses the existing `RELEASE_SIGNING_KEY`, `RELEASE_SIGNING_KEY_ID` and checked-in trust keyring. Only the publish job receives the private signing key, only during the signing step. Configure the separate GitHub environment `dev-release` to allow **only branch dev**. Do not broaden the existing main-only `release` environment.

The publisher creates an annotated tag with the private project Git identity, creates a draft with `prerelease=true` and `make_latest=false`, uploads exactly the established nine assets, re-downloads and verifies them, then publishes. Publication must return `immutable=true`, followed by another download/signature/content check. The stable Latest release is not changed. Assets include the portable `.tgz`, signed manifest, signature descriptor, SHA256SUMS, trust keyring and notices.

## Recovery and use

An existing tag must have the exact source and plan annotation. An existing draft must belong to this run's plan, and every uploaded byte must match before missing assets are uploaded. No tag update, asset overwrite or `--clobber` is allowed. A verified published retry performs read-only verification and does not republish. Conflicting or malformed evidence requires operator investigation.

Use **Re-run failed jobs** after correcting a temporary CI, mirror, API or environment problem. The publish job references the build job's recorded attempt, not blindly the new run attempt, so a retry that reuses a successful build downloads the correct original artifact. Full reruns produce a separately named build artifact. Different batches have independent run-ID locks and unique versions, avoiding shared pending-run eviction.

Publishing makes the prerelease archive available for explicit development installation. It does **not** automatically upgrade/restart the currently connected Runner, repoint the production installer, promote dev to main or alter an existing immutable release. Verify downloaded assets against the trusted source keyring before installing in the development environment. The prerelease remains subject to the same execution-permission and supported-Node requirements as its source.

## Ownership and verification

`scripts/dev-release/policy.mjs` owns pure counting/version/plan rules; `plan.mjs` observes source and Actions context; `build.mjs` owns isolated packaging; `verify-ci.mjs` adapts exact GitLab evidence; `publisher.mjs` owns the testable publication state transitions; `github.mjs` and `publish.mjs` own API/filesystem adapters. Shared bundling, manifest and signature primitives are reused. Runtime Runner/Worker modules do not depend on release automation.

`test/dev-release.test.mjs` is registered in the existing tooling lane on both providers. It covers cadence, malformed plans, stable-lane separation, version injection, API failures, output bounds, partial drafts, published retries, conflicting tags/assets, exact-source CI and workflow permissions/dependencies. Actual signing, hosted Actions scheduling, GitLab availability and installation require their own observed evidence; local fixtures are not live publication evidence.
