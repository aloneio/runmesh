# Runner descriptor-boundary audit - 2026-09-18

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

## Scope and preserved state

This independent oci0 audit starts at clean candidate `5117a569794d567742df1602fc32ff8f2f0d38dc`, retaining its earlier release-tool input repair. At the initial remote observation, dev still pointed to `3c18b5e96485c1d33f0c024f4018fec65f94d074`. The original dev checkout contains existing changes and is not reset, merged, rebased or overwritten. The audit uses an independent detached repository and an isolated npm cache. Its baseline passed all 26 declared local CI gates; those results are not acceptance evidence for later modifications.

The connected Host shell executes as root. These local checks therefore do not establish least-privilege service behavior or native Windows/macOS acceptance. Tests use disposable synthetic fixtures; no installed service, production credential, account, live policy or system installation is altered. Per-command Git trust was limited to explicitly named existing repositories rather than changing global trust.

## SEC18: remaining metadata and directory opens can wait before validation

Four readers checked a pathname with lstat, then opened it in blocking read mode before validating the descriptor: isolated Git metadata, the Runner profile, persisted policy, and uninstall metadata inspection. Replacing the previously regular file with a FIFO between those two operations can wait for a pipe peer before the type/identity/size guards execute. Git metadata is read from the inspected repository; profile, policy and uninstall paths require local ability to alter the corresponding files. This finding is an availability boundary issue, not evidence of unauthenticated remote credential access.

The patch and policy directory durability helpers also used a generic blocking read open. A replaced directory could therefore block a flush despite the caller having finished its earlier path checks. A best-effort error handler does not bound an open that never completes.

Repair commit `841286465e2db4811542f119563faa03a9cd7532` adds supported nonblocking flags to the four readers without removing their existing no-follow, permission, identity or byte checks. Uninstall metadata also explicitly rechecks descriptor type and size. Directory flushes require directory-only/nonblocking opens where supported and verify the opened descriptor before fsync. Directory resolution and the existing strict-policy versus best-effort-patch durability semantics remain unchanged.

Nonblocking FIFO handling is not a timeout guarantee for regular-file I/O, network filesystems or every device type. It also does not make the Host shell an operating-system sandbox.

## Reproductions and mandatory regression coverage

Six Linux regressions interpose only at the native open boundary and replace disposable real files/directories with real FIFOs. Against the old source all six failed while the existing 18 tests in the same file passed. The pre-repair fixture refuses to issue a blocking syscall, so it cannot strand the Runner's filesystem thread pool. These are deterministic race reproductions, not six timed-out production calls.

After the repair, all 24 test cases in that file passed with no skips. Each repaired file reader actually opens a FIFO without a writer, rejects the descriptor and closes it exactly once. Directory-only opens reject FIFO replacement without waiting. Type checking and formatting also passed before the repair commit.

SEC18 is an explicit mandatory finding in the release-readiness contract and references the repair commit as an ancestor. The existing security regression file remains in the executable security lane. Evidence tests reject removal or replacement of SEC18 and still reject stale candidate identities, skipped tests, fabricated assertion counts and missing suites. Fixture generation uses the declared required IDs, while explicit SEC17/SEC18 assertions preserve the tracked boundary requirements.

## Candidate and deployed acceptance remain separate

Final verification must identify the exact clean follow-up candidate and rerun all 26 local gates, including dependency audits, security, packaging and both transport paths. Real browser E2E is an additional check. An explicitly selected system Chromium is local runtime evidence, not proof that the lockfile-bound browser or provider matrix ran. Full logs and final source identity are retained in the companion evidence directory.

During this audit, a Host shell receipt's Job ID could not be retrieved through the connected job tool. The host schema rejected workspace-bound get arguments and exposed no context tool, while the candidate source supports both. A stale host tool catalog and deployed Worker/Runner provenance must be verified independently; source tests cannot close those live acceptance gaps.

No automatic main promotion, force push, stable publication, production deployment, installed Runner restart or old-worktree deletion is part of this repair. Immutable v0.1.3 assets remain unchanged. Later dev changes still require a new stable version, exact-source provider verification and separate installed-component acceptance.
