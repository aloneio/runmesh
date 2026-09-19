# Cumulative release-candidate audit — 2026-09-17

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

## Scope and acceptance boundary

This audit continues from `ed2967a6157eadff8e08d3121bfe96e11a26cdd7` and retains the uncommitted repairs described in the [earlier follow-up](release-followup-20260917.md). Work takes place in a separate detached checkout; the original development checkout is not overwritten. Existing stable v0.1.3 assets, main, production services and the installed Runner are not changed by these source repairs.

**This is not stable-release approval.** A clean candidate must independently pass the ordinary CI contract and the expanded security manifest. Native operating-system and supported Node lanes, exact-source provider results, protected dev-to-main promotion, signing, public-asset verification and deployed Worker/Runner acceptance remain separate requirements.

## Cumulative corrections

The inherited fixes require a confirmed logout receipt, prevent a Git object-to-FIFO race from blocking its open, and bound empty authentication-response chunks. This audit adds:

| Boundary | Confirmed defect | Correction |
| --- | --- | --- |
| Login | Any successful HTTP status caused cookies to be issued, even when the Registry had not confirmed session creation. | Require the Registry's completed `204` receipt. Unexpected receipts return `503`, do not issue cookies and do not retry the mutation. |
| Password change | An unexpected successful status acknowledged a password change and cleared cookies without a confirmed mutation. | Require `204`; retain the browser session on an unconfirmed result and cancel the discarded response body. |
| Administrative authentication observation | An expired non-200 response could be treated as a fresh denial before the timeout callback ran. | Check the observation deadline before interpreting status and before returning decoded JSON. |
| MCP reauthorization | A late fetch, data chunk or final end-of-stream receipt could produce an authorization decision before the timer callback ran. | Recheck elapsed time after fetch, after every read and before projecting the parsed result; clean up the request-local abort signal. |

HTTP success is not used as a substitute for an application-specific completion receipt. The observation deadlines use the runtime-provided clock and retain byte/fragment budgets; they are not a CPU-preemption mechanism or an operating-system sandbox.

## Reproduction and local verification

The repository's actual Cloudflare/Vitest Worker tests were used, with isolated Durable Objects and synthetic credentials. No production principal or credential was used by these fixtures. The new cases deliberately control the observation clock to exercise timer-callback ordering without sleeps or busy loops.

Before the four new corrections, the two focused suites produced **19 failures and 54 passes**. They exposed false login/password success, late authorization grants and late-denial classification. After the corrections, all 73 cases passed as part of the ordinary unit run. The added coverage comprises 36 cases in this iteration, in addition to the 15 inherited follow-up cases.

Pre-commit local results on the candidate's modified source were:

| Verification | Observed result |
| --- | --- |
| Independent-cache dependency installation | Exit code 0; the shared cache was not modified. |
| Ordinary unit command | 1,413 passed, 5 skipped, no failures. |
| Release/tooling tests | 361 passed, 5 skipped, no failures. |
| Static/dependency/toolchain gate batch | 15 of 15 gate commands exited 0. |
| Build, three Worker configurations, release contract and package smoke | All six gate commands exited 0. |
| Source Worker/Runner transport | 34 passed, 1 skipped. |
| Installed-package Worker/Runner transport | 34 passed, 1 skipped. |
| Real local Chromium transport/browser lane | 35 passed, no skips. |

These pre-commit observations are not substituted for clean-commit evidence. Security evidence is generated separately from the exact clean candidate by `npm run test:security`; every owned security case must pass without skips. Any later clean-candidate results must identify their own commit. Skipped cases in ordinary lanes are not claimed as executed native-platform coverage.

The expanded security manifest binds the follow-up corrections to source commit `177ce76de39cd83ecb90e21c3b9f37a394311afb`. SEC11 owns the reauthorization deadline suite. The execution collector and closure verifier share the mandatory finding IDs, and regression tests reject deleting or substituting SEC11 even when report counts still match.

The initial shared-cache installation failed with `EACCES`. An independent cache subsequently installed successfully. Some host execution requests were rejected by the tool platform; rejected requests are not recorded as executed checks. The installed MCP host catalog still exposed nine tools and its Job `get` schema rejected `workspace_id`; a newly created Job was visible through the live workspace Job list but its history-based `get` returned `not_found`. This requires fresh source/server/host catalog comparison and installed-component acceptance, not speculative source edits or a claim of deployment success.

Raw command logs remain in the separate audit evidence directory on oci0. The canonical CI and security report generators produce their own bounded evidence. No cleanup, production deployment, stable publication or installed-Runner restart is part of this audit.
