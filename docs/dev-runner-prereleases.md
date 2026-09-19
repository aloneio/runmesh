# Automatic development Runner prereleases

Use development Runner prereleases to test upcoming changes on a separate development host. In the upstream repository, GitHub's `Dev Runner Prerelease` workflow attempts a prerelease on every fifth dev push that starts the workflow. Publication still requires its verification and signing checks to pass. The stable `Release` workflow is main-only. Publishing an archive does not deploy a Worker or upgrade an installed Runner.

For installation, use the development Worker's administrator page and check the exact version it offers. The current source is a **0.1.4 candidate**; its source version is not proof that a corresponding stable or dev archive has been published. Forks must configure their own release automation and signing environment; the upstream workflow is repository-restricted.

## Counting and versions

The workflow is exclusively `push` on `dev`, with no path filters, PR, tag, manual or reusable triggers. Its own `github.run_number` is the push counter: 5, 10, 15, and so on are release opportunities. A push containing several commits counts once. A merge into dev counts as one push. Mirroring the same push to GitLab does not count a second time. `run_attempt` is not counted; retry through Actions **Re-run jobs**, not by adding a manual trigger to this workflow.

The counter starts with this workflow's first run; earlier repository pushes are not reconstructed. Disabled workflows and skip-CI events that create no run do not count. Repository administrators should review counter migration and existing tags before renaming, recreating or adding triggers to the workflow.

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

Job workspace binding accepts compatible versions in this dev channel: `0.1.4-dev.0` is newer than stable `0.1.1`; `0.1.1-dev.0` and older previews remain unsupported. Version compatibility does not bypass client, workspace, policy or Job identity checks.

The development prerelease is signed only after the same run's required GitHub verification succeeds, including repository, browser, native Linux/Windows/macOS Runner and maintained Node LTS checks. GitLab `dev` can serve as the downstream mirror/deployment trigger after GitHub `verify-all`, but that mirror requires the separately configured host bridge; this workflow does not perform it. GitLab SaaS compute availability and Cloudflare external commit statuses are not Runner-signing prerequisites. Stable/main publication has its separate cross-provider release policy.

Signing reuses the existing `RELEASE_SIGNING_KEY`, `RELEASE_SIGNING_KEY_ID` and checked-in trust keyring. Only the publish job receives the private signing key, only during the signing step. Configure the separate GitHub environment `dev-release` to allow **only branch dev**. Do not broaden the existing main-only `release` environment.

The publisher creates an annotated tag with the private project Git identity, creates a draft with `prerelease=true` and `make_latest=false`, uploads exactly the established nine assets, re-downloads and verifies them, then publishes. Publication must return `immutable=true`, followed by another download/signature/content check. The stable Latest release is not changed. Assets include the portable `.tgz`, signed manifest, signature descriptor, SHA256SUMS, trust keyring and notices.

## Recovery and use

An existing tag must have the exact source and plan annotation. An existing draft must belong to this run's plan, and every uploaded byte must match before missing assets are uploaded. No tag update, asset overwrite or `--clobber` is allowed. A verified published retry performs read-only verification and does not republish. Conflicting or malformed evidence requires operator investigation.

Use **Re-run failed jobs** after correcting a temporary CI, mirror, API or environment problem. The publish job references the build job's recorded attempt, not blindly the new run attempt, so a retry that reuses a successful build downloads the correct original artifact. Full reruns produce a separately named build artifact. Different batches have independent run-ID locks and unique versions, avoiding shared pending-run eviction.

Publishing makes the prerelease archive eligible for the development Worker. `runmeshdev` discovers only complete, immutable GitHub prereleases whose tags match the dev version contract, then renders an installer pinned to that exact tag. The installer still verifies the signed manifest, channel, prerelease flag, artifact URL and checksum with the embedded trusted Ed25519 public key. Discovery failure disables development bootstrap; it never falls back to the stable Runner. Production remains pinned to the reviewed stable release. Publishing does **not** automatically upgrade/restart already connected Runners or promote dev to main.

## Check a prerelease before using it

Check that the release is public, immutable, marked as a prerelease and contains all signed assets. For manual installation, follow the [portable verification procedure](portable-runner-installation.md) using a separately trusted keyring. Compare the package and installed CLI versions with the selected dev tag. CI success alone does not prove that publication or host installation completed.

## Development installer availability

The development release descriptor, installer, maintenance download and administrator pages use the same verified dev selection. It is cached as fresh for 60 seconds and may remain usable for up to one hour from signature verification while a background refresh runs. Refreshes have a 20-second deadline. A failed refresh does not extend that hour; expired or future-dated cache entries are not used. Unavailable responses are not cached.

Versions are selected by dev sequence, not publication time, so publishing an older batch late does not replace a newer version. A healthy `/health` response alone does not show that installation is available. Check the selected release and the exact version in the offered POSIX or PowerShell installer; allow for the cache window when verifying a newly published archive.
