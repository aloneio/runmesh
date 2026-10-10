# Test with development Runner releases

[简体中文](dev-runner-prereleases.zh-CN.md) · [Upgrade guide](upgrading.md)

Use a development Runner on a separate test host to try upcoming changes. Open the development Worker's administrator page and check the exact version offered before installing. Development downloads use the verified prerelease channel; the current production version is listed in [release status](release-readiness.md).

Copy the install command from the development panel to enroll with that development Worker. Commands from the production panel use its stable release and production address. Keep the two installations in their intended environments.

For a test host, install the version offered by the development panel and finish or cancel active Jobs before restarting its service. Administrators who publish their own development channel can follow the automation steps below.

## Choose and verify a package

The development Worker selects complete, public, immutable GitHub prereleases with a verified signature and a protocol compatible with the Worker. Its installer is pinned to that exact tag and verifies the signed manifest, channel, artifact URL and checksum using the embedded trusted Ed25519 key. For a manual install, follow [portable verification](portable-runner-installation.md) with a separately trusted keyring.

After installation, compare the package and CLI `--version` with the selected tag, then verify Runner connectivity, policy acknowledgement and the required MCP operations.

The Worker normally refreshes its selection after 60 seconds and can continue offering a verified package for up to one hour while refreshing in the background. Check the version displayed in the panel after a new publication. If installation is temporarily unavailable, check the release workflow and try the panel again after the next refresh.

Versions are ordered by dev sequence. A delayed older batch therefore leaves a newer selected version in place. During Worker updates, a verified compatible dev package can remain available until a new batch is published and verified. Check the displayed package version and its changes before installation. Production uses its separately reviewed stable release.

## Configure development release automation

The maintained GitHub workflow `Dev Runner Prerelease` runs in `aloneio/runmesh` and attempts publication on every fifth dev push that creates a workflow run. Each release completes verification and signing in that run. The checked-in publication scripts and Worker download URLs also use `aloneio/runmesh`. Publishing a fork requires reviewed source changes to the repository checks, API and asset URLs, and trusted public key, together with its workflow and signing environment. A self-hosted Worker can continue using the project's verified release channel without publishing a fork.

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

The first attempt saves a release plan with the source commit, stable baseline and planned version. Actions retains that plan, or a recorded deferral, for 90 days so retries can continue the same batch. If the record is missing or expired, review the workflow and existing release assets before proceeding.

While main prepares a stable release, a due batch records a **deferred** outcome. After the stable release is verified and activated, the next due dev push can plan a new batch. A retry keeps the original batch's decision. Maintainers can use the [publication checklist](maintainers/release-process.md) for the stable release.

## Build and publish

The builder creates an isolated package with the planned dev version and includes `build-inputs.json` for traceability. The tag and signed manifest identify the actual source commit.

The exact archive is installed offline and tested through the local MCP → Worker → Runner suite. Both package metadata and the installed CLI must report the planned version. The same run also requires the repository, browser, native Linux/macOS/Windows and maintained Node LTS checks.

Publication creates an annotated tag and prerelease draft, uploads the established signed assets, verifies the downloaded bytes, then publishes and checks immutability and signatures again. The assets include the portable archive, manifest, signatures, SHA256SUMS, keyring and notices. The stable Latest selection stays with the stable release.

For installations that deploy through GitLab, configure the [synchronization and build connection](deployment.md) so the Worker updates after the dev commit passes GitHub `verify-all`.

## Recover a failed batch

| Situation | Action |
| --- | --- |
| Temporary CI, API or signing-environment failure | Correct the cause and use Actions **Re-run failed jobs** |
| Successful build reused by a publish-job retry | The job retrieves that build's recorded attempt and original artifact |
| Missing or expired release plan | Keep the workflow records and release assets, then ask a maintainer to review the batch |
| `dev_release_superseded` | The stable baseline changed; preserve the old draft and use a later batch based on the new baseline |
| Existing tag, draft or asset conflicts with the plan | Stop publication and inspect the exact source, plan and asset bytes |
| Already published immutable release | The retry verifies the existing release read-only |

Matching drafts can receive missing assets. Keep existing tags and asset bytes intact; published releases are immutable. The workflow checks the stable baseline again before signing and before publication, so use a maintenance window if another maintainer is promoting main at the same time.

After publication succeeds, check the development Worker's selected version, install it on the intended test host and complete the [upgrade acceptance checks](upgrading.md).
