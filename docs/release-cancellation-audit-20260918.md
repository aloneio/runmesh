# Cancellation observation audit - 2026-09-18

## Scope and baseline

The independent oci0 audit started from clean dev `d8366941b48e060b274ebfb9416a552d5f668ecd`, synchronized to GitHub and GitLab. An isolated detached worktree and a fresh lockfile installation were used. Commands and commits use the repository owner, not the root identity of the installed Runner. The existing npm cache contains root-owned entries; this audit uses a separate owner-writable cache instead of changing unrelated host ownership.

All 26 ordinary CI gates passed on that unmodified baseline, including source unit/security tests, release tooling, all Worker dry runs, archive smoke checks, local transport and installed-package transport. GitHub CI `35292426602` passed its Linux/Windows/macOS, Node LTS and browser jobs. GitLab's matching external Cloudflare build `0131a8ed-dcc8-4b7d-8a55-f9da8d348870` in pipeline `2859921915` succeeded. The baseline Dev Runner Prerelease workflow only passed its cadence check; its build and publish jobs were skipped. None of these observations is verification of a later repair or proof that installed components were upgraded.

## Reproduced defect

A cancellation could observe a live process with a verified start fingerprint, persist `cancelling`, and then fail to read the fingerprint before sending the signal. Both local-child and restart-recovered paths treated that unknown observation as terminal interruption. The local path also discarded its original ChildProcess handle and fabricated a dead/mismatched liveness observation. A similar local path existed after a process-tree terminator returned false.

Two independent public-port reproductions failed on the original built Runner. Both returned `interrupted`, set a completion timestamp, emitted a completion event and released the only concurrency slot, even though the process adapter still reported alive and no cancellation signal had been sent. This can lose supervision/log capture and admit another command beside the still-running process. It is a release-blocking process-accounting and cancellation-outcome defect, not evidence that a PID was actually killed.

The fixtures use synthetic ChildProcess objects and real temporary metadata storage through public dependency ports. They do not launch an operating-system child, send signals to host PIDs, access production Job files or replace private manager fields.

## Repair and executable coverage

Local termination checks now distinguish unverified identity from proven PID reuse. An unavailable identity refuses cancellation while preserving the original process handle, the running state and its admission slot. A recovered live process with an unreadable fingerprint remains unknown, or cancelling when delivery evidence already exists; it is not terminalized. Proven reuse and confirmed process exit retain their previous fail-closed behavior. Liveness metadata for proven reuse records that the observed PID is alive but mismatched instead of claiming it is dead.

Both original reproductions passed after the repair. The focused `apps/runner/test/job-cancellation.test.ts` suite adds six passing Linux regressions: observation failure before signalling, failure after an undelivered signal attempt, recovery-time observation failure, local and recovered proven PID reuse, and a confirmed recovered process exit. The uncertainty cases also verify persisted state, no completion event, no extra spawn, retained concurrency and successful later cancellation when identity observation recovers. Linux-only local fingerprint cases are conditionally excluded on platforms without /proc; the recovered cases also execute in native platform CI.

The new suite is registered in the verification inventory. SEC20 closure and mandatory candidate-bound execution are recorded separately using the actual repair commit, avoiding a self-referential source hash. A repaired clean candidate must run its own complete gate set; passing baseline results must not be relabelled as repaired-candidate evidence.

## Operational acceptance limits

The connected MCP host still exposed nine tools and an unqualified `job.get` after a successful shell receipt returned Registry `not_found` with a runner-discovery recovery hint. Current source has a different history-unavailable contract and workspace-bound Job lookup. The discrepancy is an installed-component/connector acceptance gap until freshly verified; it does not justify guessing which component is stale.

Service-configuration inspection was blocked by the tool platform and was not retried through an alternative access route. No service restart, production deployment, main promotion, credential change or immutable release replacement is part of this repair. Cloudflare build success alone is not a live health or installed Runner acceptance record. A new stable version, clean exact-source gates and the Worker/Runner/connector acceptance chain remain prerequisites for formal publication.
