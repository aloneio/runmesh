# Test with development Runner releases

[简体中文](dev-runner-prereleases.zh-CN.md) · [Upgrade guide](upgrading.md)

Use a development Runner on a separate test host to try upcoming changes. Open the development Worker's administrator page and check the exact version offered before installing. The latest published stable release is **0.1.4**; development downloads are determined by the verified prerelease channel.

Updating a test environment has three steps: publish the Runner package, deploy the Worker, and install the selected package on the host. Plan service restarts around active Jobs.

## Choose and verify a package

The development Worker selects complete, public, immutable GitHub prereleases in the current dev version series. Its installer is pinned to that exact tag and verifies the signed manifest, channel, artifact URL and checksum using the embedded trusted Ed25519 key. For a manual install, follow [portable verification](portable-runner-installation.md) with a separately trusted keyring.

After installation, compare the package and CLI `--version` with the selected tag, then verify Runner connectivity, policy acknowledgement and the required MCP operations.

The release selection is fresh for 60 seconds and remains usable for up to one hour from signature verification while background refresh runs. Refreshes have a 20-second deadline. Failed refreshes retain the original expiry; expired, future-dated or unavailable selections close the installation entry point. Check the release offered by the installer when verifying a new publication, allowing for this cache window.

Versions are ordered by dev sequence. A delayed older batch therefore leaves a newer selected version in place. Production uses its separately reviewed stable release.

## Configure upstream automation

The upstream GitHub workflow `Dev Runner Prerelease` attempts publication on every fifth dev push that creates a workflow run. Publication requires the same run's verification and signing checks. Fork administrators must configure their own release automation and signing environment; the upstream workflow is restricted to its repository.

Configure the GitHub environment `dev-release` for **branch dev only**, using `RELEASE_SIGNING_KEY`, `RELEASE_SIGNING_KEY_ID` and the checked-in public keyring. Keep the stable `release` environment restricted to main. Only the publish job's signing step receives the private key.

The workflow listens to pushes on dev. Its `github.run_number` determines release opportunities:

| Push run | With a verified stable baseline of 0.1.3 |
| --- | --- |
| 1–4 | Countdown to the next release opportunity |
| 5 | `0.1.4-dev.0` |
| 10 | `0.1.4-dev.1` |
| 15 | `0.1.4-dev.2` |

A multi-commit push or merge counts once. Retries reuse the run number, and GitLab mirroring leaves this GitHub count unchanged. Counting starts when the workflow is created; disabled or skipped events that create no run are absent from the count. Review existing tags and counter migration before renaming or recreating the workflow.

The batch index continues across stable releases. If the verified stable baseline becomes `0.1.4` before run 20, that batch is `0.1.5-dev.3`. Failed batches can leave version gaps.

## Prepare the source baseline

Each new batch verifies that main's version, latest immutable stable release, signed manifest and reviewed release-state record agree. The selected main commit must be an ancestor of the fixed dev source. Synchronize main into dev through a reviewed merge when this ancestry check fails.

The first attempt records the source SHA/tree, main baseline, release identity, manifest hash, run ID, planned version and timestamp in a frozen plan. Actions retains that plan for 90 days. Retries use the same plan and version. An expired or missing plan requires maintainer investigation.

For the next stable version, follow the [release status and publication checklist](release-readiness.md). Dev release planning resumes after main's signed release has completed verification and activation.

## Build and publish

The builder creates an isolated package with the planned dev version and includes `build-inputs.json` for traceability. The tag and signed manifest identify the actual source commit.

The exact archive is installed offline and tested through the local MCP → Worker → Runner suite. Both package metadata and the installed CLI must report the planned version. The same run also requires the repository, browser, native Linux/macOS/Windows and maintained Node LTS checks.

Publication creates an annotated tag and prerelease draft, uploads the established signed assets, verifies the downloaded bytes, then publishes and checks immutability and signatures again. The assets include the portable archive, manifest, signatures, SHA256SUMS, keyring and notices. The stable Latest selection stays with the stable release.

For installations that deploy through GitLab, configure the [host synchronization bridge](deployment.md) separately. It can mirror the exact dev SHA after GitHub `verify-all`, allowing the connected Cloudflare Worker to build that push. Stable publication follows its own cross-provider checks.

## Recover a failed batch

| Situation | Action |
| --- | --- |
| Temporary CI, API or signing-environment failure | Correct the cause and use Actions **Re-run failed jobs** |
| Successful build reused by a publish-job retry | The job retrieves that build's recorded attempt and original artifact |
| Missing or expired frozen plan | Preserve the remaining evidence and ask a maintainer to reconcile the batch |
| `dev_release_superseded` | The stable baseline changed; preserve the old draft and use a later batch based on the new baseline |
| Existing tag, draft or asset conflicts with the plan | Stop publication and inspect the exact source, plan and asset bytes |
| Already published immutable release | The retry verifies the existing release read-only |

Matching drafts can receive missing assets. Keep existing tags and asset bytes intact; published releases are immutable. The workflow checks the stable baseline again before signing and before publication, so use a maintenance window if another maintainer is promoting main at the same time.

After publication succeeds, check the development Worker's selected version, install it on the intended test host and complete the [upgrade acceptance checks](upgrading.md).
