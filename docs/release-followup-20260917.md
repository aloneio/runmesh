# Pre-release follow-up audit — 2026-09-17

This document records the earlier iteration. The [cumulative candidate audit](release-final-audit-20260917.md) records subsequent repository execution and additional repairs without rewriting the evidence boundary below.

## Acceptance status

**Source repairs applied; exact-candidate acceptance is pending. Do not treat this report as release approval.**

The observed starting checkout was clean `dev` at `ed2967a6157eadff8e08d3121bfe96e11a26cdd7`. Both GitHub and GitLab exposed only `dev` and `main`, with matching tips. GitHub CI run `35190683885` and Dev Runner Prerelease run `35190684080` were successful for that baseline. Those results predate this follow-up and do not verify its changes.

The initial oci0 observation showed about 9.1 GiB available on the root filesystem. No cleanup was required or performed. The installed Runner and production deployment were not restarted, upgraded or replaced. No main promotion or release publication was performed.

After the initial reads, the host-shell execution channel was blocked by the tool platform. A separate earlier worktree creation attempt had also failed on filesystem ownership. Neither attempt produced the requested follow-up checkout. No alternative host execution route was used. Authorized, context-checked MCP file edits remained available and were used for the changes below. The changes are not accompanied by a new verified commit or remote CI result in this audit.

## Confirmed source defects and corrections

| Area | Finding | Correction |
| --- | --- | --- |
| Administrator logout | The browser handler discarded the revocation response and returned a success redirect even when Registry could not revoke the session. | Require the documented completed `204` receipt before clearing cookies and redirecting. Unexpected receipts and unavailable dependencies return `503`, retain the browser session and do not retry the mutation. |
| Git object snapshot | A regular object can become a FIFO between metadata inspection and opening. A read-only blocking open can wait for a writer before the descriptor checks run. | Add `O_NONBLOCK` where available, retaining no-follow and regular-file/device/inode checks. Reject the changed object instead of waiting for a FIFO writer. This does not make general filesystem I/O preemptible or create an OS sandbox. |
| Bounded authentication JSON | Empty stream chunks consume no byte budget and can accumulate while immediately resolved reads delay the timeout callback. | Do not retain empty chunks; allow at most 1,024 per observation. Also recheck the monotonic deadline after reads. Excessive fragmentation cancels the observation and does not grant authority. |

The existing owned security suites now contain 15 additional cases: 14 Worker cases and one Linux Runner race case. They cover unexpected logout receipts, a transport exception, successful server-side revocation, empty-chunk limits, fragmented UTF-8 and a real FIFO substitution. The FIFO regression refuses to perform a blocking open when testing a regression, so a failing assertion cannot strand the test filesystem worker.

## Evidence boundaries

The copied standalone helpers and exact logout-branch logic were tested in a separate Linux container using Node `v22.16.0`: 31 focused checks passed, with no skips. Separate before/after probes observed the original FIFO open remaining pending and the repaired open rejecting the changed object; they also observed the original reader accepting 4,096 empty chunks and the repaired reader cancelling at its new bound. All fixtures were disposable and local to that container.

This is **not** execution of the repository's Vitest/Cloudflare suites, a native-platform matrix, packaged Worker/Runner E2E, an installed Runner check or a deployed Worker test. The host's observed configured Node was `v22.23.2`. The 15 added repository cases and the full candidate checks remain unexecuted in this follow-up because the host execution channel was unavailable.

The current chat connector exposed nine callable tools, while the checkout catalog documents ten, including `context`. This establishes a host/source catalog mismatch, not proof that the live server still exposes the older catalog. Source, server and host catalogs require separate fresh captures and comparison.

## Required before stable promotion

Run the complete ordinary CI contract and the expanded security suites on the exact clean candidate, including native platforms, supported Node versions, browser tests, source transport and installed-package transport. Preserve `aloneio <git@aloneio.aleeas.com>`, English commit messages and the dev/main-only branch policy when committing and synchronizing the repairs.

Then verify fresh source/server/host MCP catalogs, the actual deployed Worker and installed Runner. A subsequent stable candidate still needs its own version, protected dev-to-main promotion, exact-source provider checks, signing, independent public-asset verification and upgrade acceptance. Existing v0.1.3 assets must remain immutable.
