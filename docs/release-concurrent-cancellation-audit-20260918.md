# Concurrent cancellation audit - 2026-09-18

## Decision and scope

The initial review performed repository reconnaissance, focused source review and one repair; it did not complete comprehensive pre-release verification. At the end of that review, the source changes and regression tests were uncommitted in an isolated detached worktree. The follow-up validation section below records subsequent observations separately; formal publication still requires the complete acceptance chain.

The observed clean main working directory was `/home/xwzy/runmesh`, on dev at `6a2e9dc6d053667eed4f76d56996a3d7616dee04`. GitHub dev matched that commit when checked. Local main remained `b330f1dcb4334c1d36cf7c5858adf0de692e5b97`; the observed named local branches were only dev and main. The configured Git identity was `aloneio <git@aloneio.aleeas.com>`. Later branch changes by other actors were not rechecked.

Repair worktree: `/home/xwzy/runmesh-release-audit-20260918-0923`.
Evidence directory: `/home/xwzy/runmesh-release-evidence-20260918-0923`.

## Finding: a completed delivery can be repeated by a concurrent caller

`JobManager.cancelRecoveredUnknown` checked the cancellation delivery marker at entry and shared an in-flight termination promise. Neither mechanism covered a caller suspended in one of the two identity inspections after another caller had completed delivery and removed its shared promise.

A slow caller can resume after a fast caller has persisted `cancellation_delivered_at_ms`, republish a recovered snapshot or pass the final signal gate, and create a second platform termination request. This violates cancellation idempotency. It is not evidence that an unrelated PID was killed: the process identity and native termination protections remain separate boundaries.

The repair rechecks the delivery marker after the first identity probe, before publishing a new cancelling snapshot, and after the final identity probe, immediately before selecting a termination attempt. A completed delivery returns the existing record instead of signalling again.

Two regressions were added to the existing `apps/runner/test/job-cancellation.test.ts` suite. They suspend one request before publication or before signalling, allow a concurrent request to finish delivery, then resume the first request. They require exactly one termination call, retention of the delivery record and admission slot, and no false completion event. The fixtures use the existing public dependency ports, a synthetic ChildProcess and temporary metadata files; they do not start an OS child or signal a host PID.

## Verification evidence and limits

The MCP transactional edit succeeded and both modified files were read back. The source hash changed from `6e4a642c08d57d69332761b933ee1da3b0fd54ce2a58a2649cf38d70ca934025` to `074b24565f912efea1524c2591cbacaad7577846fcd495578953e8e608a4d518`. The test hash changed from `7bbce95718e3842aa9f7db588a9a64803436d51bef1af8ec59295da1588b2300` to `d9f96d1f3869c41483549327ee8ece73f8a39f1fe479b2588aa22c70fe61486c`.

An extracted-method diagnostic ran in the assistant's local sandbox using Node v22.16.0, with in-memory persistence and process-delivery adapters. It reproduced two termination calls for each unmodified interleaving and one call for each repaired interleaving. The repaired scenarios preserved the delivery marker and did not emit completion. This is diagnostic support for the concurrency repair, NOT a run of the repository tests, native process termination, durable filesystem integration, or oci0 acceptance. Its result is recorded separately in `concurrent-cancellation-diagnostic.json` in the evidence directory.

The oci0 aggregate verification command and the independent typecheck command were blocked by the tool platform. They have no successful execution result. The two new repository regressions, full unit/security suites, packaging, transport, browser checks, cross-platform checks and candidate-bound release gates have not been run for this patch. Earlier audit results cannot be relabelled as evidence for this change.

The initial detached-worktree setup and dependency-installation call returned a running receipt (`job-9012788e-be1c-42ea-b38e-f23fdbead8c3`); this session did not obtain a verified completion result for that installation. Do not interpret the existence of the worktree as installation success.

## Other reviewed boundaries

Source review covered Job admission, cancellation, recovery and persistence; the shared protected RPC operation table and Runner dispatch authorization; the ordinary CI workflow; and the stable release workflow. The reviewed Runner dispatch checks the stored Job workspace and operation permission, and revalidates policy generations for read-only operations. The CI source declares native platform, Node LTS, browser, package and transport checks. The stable workflow contains exact-main-source checks, security evidence, signing and independent archive verification. These observations describe source wiring only; they are not current remote CI or production pass results.

## Outstanding operational acceptance blockers

The connected MCP catalog exposes nine tools and no context tool. A successful shell receipt (`job-7dfbc24d-aae8-4537-a3fc-c879f56577b2`) could not be retrieved with `job.get`: the unqualified call returned Registry `not_found`, `failure_class=unknown`, and a runner-discovery recovery hint. Adding `workspace_id` was rejected by the exposed schema. The current source contains workspace-bound Job lookup; the connected tool/Worker/Runner chain still requires end-to-end reconciliation. The observations do not identify which installed component is stale.

Native MCP Git inspection returned `git_unavailable`. The initial root shell also encountered Git's dubious-ownership check; repository reconnaissance then succeeded as the repository owner. No global safe-directory exception was added. Remote execution used root at entry, which is a deployment least-privilege concern to review separately, not proof of an authorization bypass.

The initial disk reading showed about 2.1 GiB available and 96 percent usage. This is an initial observation, not a post-installation capacity measurement. No old worktrees or user data were deleted.

The first patch attempt returned runner_offline with an unknown outcome. Connection and file state were rechecked; a later transactional patch succeeded. A subsequent ambiguous-hunk response explicitly reported not_started and was corrected with exact context before the successful patch. Neither failed attempt is counted as a successful edit.

## Repository and publication state

The initial review did not commit, push, promote main, deploy production, restart services, change credentials or replace immutable releases. No named branch was created. Formal release must not be approved on the local diagnostic alone.

## Follow-up validation and identity correction

On 2026-09-18, the branch-convergence follow-up successfully ran `npm run typecheck` and the actual Runner cancellation suite on oci0. All eight tests passed, including both new concurrency regressions. These results supersede the initial statement that those commands had not been executed; they do not claim a full CI pass for a later commit.

At the follow-up baseline, local, GitHub and GitLab each had only dev and main. Both remotes had dev at `6a2e9dc6d053667eed4f76d56996a3d7616dee04` and main at `b330f1dcb4334c1d36cf7c5858adf0de692e5b97`. Git configuration and the six most recent commits used `aloneio <git@aloneio.aleeas.com>`. Batch historical identity verification was blocked by the tool platform and is not recorded as passing. No protected-main update or history rewrite is part of the follow-up repair.

The stable release workflow omitted an explicit API tagger even though development publication already specified the owner identity. It now supplies `aloneio <git@aloneio.aleeas.com>` and checks the returned tagger before creating the remote reference. A release-tooling regression checks that ordering. This controls future annotated-tag metadata, not GitHub's authenticated workflow actor, and does not rewrite existing immutable releases.

The follow-up shell Job receipt was successfully retrieved with `job.get` and `job.logs`. This corrects the earlier one-off lookup failure observation for that new receipt; it does not establish full connector catalog or deployment acceptance. Final push and exact-commit CI outcomes must be checked separately from these working-tree test results.
