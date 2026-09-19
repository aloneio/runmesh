# Independent candidate review — 2026-09-17

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

**Decision: HOLD. Repairs are applied, but post-repair oci0 verification, a new commit, remote CI and deployment acceptance are not complete.**

This review is not approval to replace the immutable v0.1.3 assets or to publish a new stable release. Earlier clean-candidate results below must not be reused as evidence for the modified checkout.

## Candidate and isolation

- Host: oci0, Runner `runner-9412d87b080f4b4092b9b1b934039ea9`.
- Dedicated detached checkout: `/home/xwzy/runmesh-release-review-20260917-1612`.
- Clean starting commit: `a9a1712198ef614effa6355a2bc2bd48ffb381ec`.
- Starting tree: `b4cbef3f9d1e05843c502c9e70342055ba069eb8`.
- The initial GitHub/GitLab remote observation had dev at `ed2967a6157eadff8e08d3121bfe96e11a26cdd7` and main at `b330f1dcb4334c1d36cf7c5858adf0de692e5b97`. These are observations, not a claim that remote branches have remained unchanged.
- The main working directory contained another audit's uncommitted changes. It and the separate final-audit checkout were preserved. The new checkout inherited their committed cumulative candidate rather than overwriting their work.
- Installation and the baseline gate loop ran as `xwzy`, with Node `v22.23.2` on Linux arm64 and a checkout-local npm cache.
- Initial filesystem observation: 46 GB total, approximately 8.2 GB available, 82% used, inode usage 23%. No old development files were deleted. Final available space was not remeasured.

## RVW01 — positive test fixtures depend on the caller's umask

The independent baseline unit lane failed 51 Runner tests in five files. Forty-nine failures rejected group/other-writable state directories; two positive Git trust fixtures were excluded from trusted paths. The fixtures used default-mode `mkdir` while production correctly rejects writable state/trust boundaries.

Applied changes explicitly create private positive fixtures, including newly created recursive parents, with `mode: 0o700`:

| File under apps/runner/test | Baseline failures | Repair |
| --- | ---: | --- |
| runtime.test.ts | 44 | Create the fixture state directory with an explicit private mode. |
| job-queue.test.ts | 1 | Create the recovery state/jobs hierarchy with a private mode. |
| purge.test.ts | 4 | Create synthetic installation parents with a private mode before using PolicyStore. |
| git-ownership.test.ts | 1 | Give the positive trusted executable hierarchy a private mode. |
| patch-git.test.ts | 1 | Make positive and symlink-test ancestors explicit; retain the deliberate chmod 0777 negative case. |

Production permission checks, symlink checks, ownership checks and intentionally unsafe negative fixtures were not weakened. The actual login-shell umask was not independently measured; the failure traces and fixture source establish the unsafe default-mode assumption.

## RVW02 — browser Runner mutations misclassify upstream unavailability

Source inspection found that several browser actions mapped Registry/Runner 429 or 5xx responses to HTTP 400. This incorrectly describes a control-plane outage or uncertain operation as invalid administrator input.

Added `adminUpstreamError` to `apps/worker/src/http/responses.ts` and used it in `apps/worker/src/http/runner-actions.ts` for validity, version policy, permissions, emergency lock, rename and workspace create/update/delete failures. It maps 429/5xx to 503, preserves 404 and the validity action's existing 409 handling, discards upstream response bodies, and does not expose raw provider diagnostics. It adds no mutation replay or automatic retry and does not change successful accepted-policy semantics.

Added ten repository regression cases to `apps/worker/test/release-admin-security.test.ts`: five unavailable statuses, three deterministic rejection mappings, and two actual browser-action handler cases asserting that a failed policy fence is reported as 503 and dispatches no Registry mutation.

Status: applied through MCP edit; these new repository cases have not run on oci0 in this review.

## RVW03 — deployed Job lookup is not accepted by source tests alone

The install/audit Job `job-d81cf426-55c9-40ed-ba02-6dfb8cab2507` appeared as succeeded in the live Runner Job list. The connected MCP `job.get` path returned Registry `not_found` for that same identifier. The candidate source already has history-independent lookup and clearer missing-history semantics, but those source changes are not proof of acceptance by the installed Worker/Runner/hosted tool schema.

No live credential rotation, service restart, stable asset replacement or production deployment was performed. Installed component provenance and Job lookup require a separate non-destructive acceptance test after the appropriate development deployment.

## Baseline verification actually executed

Full gate Job: `job-13f3b0d3-94e2-47a3-a728-dd141b215e10`, completed with exit code 1. The checkout-local gate log ran from `2026-09-17T16:14:15+08:00` to `2026-09-17T16:18:22+08:00`.

**25 of 26 baseline gates passed. The unit gate failed; it was not skipped or reclassified.**

Passed gate identifiers: toolchain, install, dependencies, production_dependencies, docs, ci_policy, runbooks, versions, format, architecture, inventory, promotion, whitespace, types, security, tooling, licenses, build, worker_default, worker_dev, worker_prod, release_contract, package_smoke, transport, installed_transport.

| Evidence | Actual baseline result |
| --- | --- |
| npm audit JSON | 0 reported vulnerabilities, across all reported severity levels. |
| Domain tests | 41 passed. |
| Contract tests | 48 passed. |
| Protocol tests | 43 passed. |
| Runner unit tests | 330 passed, 51 failed, 5 skipped; 5 failed files and 27 passed files. |
| Worker unit tests | 889 passed across 57 files. |
| Security-owned suites | 90 distinct cases passed: 59 administrator, 11 filesystem/Git boundary, 6 MCP security, 14 reauthorization budget. These overlap other lanes and must not be double-counted. |
| Release tooling | 363 passed, 0 failed, 5 skipped. |
| Source transport | Gate passed. |
| Local installed package E2E | 34 passed, 0 failed, 1 skipped. |

The local package evidence binds the clean starting commit/tree and artifact SHA-256 `cc58e57b2539e04a6e0f3939af07112af2186f7bca66449566459e0285cb64a7` (813106 bytes). It explicitly says signed=false and published=false. Signed release, production, account quotas and host catalog acceptance are not_run. This local archive is not the immutable public stable archive.

Primary evidence paths relative to this checkout:

- `.verification/review-logs/gates.log`
- `.verification/review-logs/unit.log`
- `.verification/review-logs/npm-audit.json`
- `.verification/review-logs/tooling.log`
- `ci-results/security-regressions.json`
- `ci-results/package-e2e.json`

Browser, native Windows/macOS and the full supported Node LTS matrix were not independently rerun in this review. The baseline unit command also did not reach its trailing root UI tests after the workspace test failure.

## Limited checks after repair

Independent checks in the assistant's disposable Linux container, not oci0, passed 72 assertions for fixture modes under simulated umasks 0000, 0002, 0022 and 0077, including deliberately writable and symlink negative cases. This does not claim that the repository's 51 failed cases were rerun.

A separate helper check passed 46 assertions for the exact repaired `adminUpstreamError` source. Its complete source file was matched to the MCP after-hash `8d8ef65e6dfc377714df20823d07a51729b056c25153b7fd6e14c1fa057edcd2`; only TypeScript annotations were removed and the HTML renderer was stubbed. The container used Node v22.16.0. These are not Cloudflare integration or supported-platform CI results.

## Remaining release gates and handoff

Two subsequent host Shell requests were blocked by the platform before execution. The already-started gate loop was allowed to finish and its results were read. MCP file edits remained available, but no alternate host execution path was used to bypass the block. This review did not create a Git commit, push a branch or trigger a deployment.

Before accepting the modified checkout, rerun type checking, formatting, architecture and documentation checks, the complete unit lane under ordinary and group-permissive umasks, the security lane including the ten new cases, and the complete verification/build/package/browser matrix. Generate fresh candidate-bound evidence; do not copy the clean baseline's ci-results as post-repair evidence.

Reconcile any concurrent dev changes before committing. Preserve the repository identity `aloneio <git@aloneio.aleeas.com>` and English commit messages. Do not force push or push directly to main; promotion must follow the existing dev-to-main process. Verify the exact resulting candidate on both configured forges and finish signed/public asset and installed deployment acceptance before approving a new stable release.
