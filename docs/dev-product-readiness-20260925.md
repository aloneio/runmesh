# Dev product readiness audit — 2026-09-25

> Historical review. The 2026-09-26 direct connection and installation workflow supersedes the approved-endpoint selector and advanced diagnostics described below. See [current administration](central-administration.md).

Status: local product iteration and regression review complete, including the successful Linux transport follow-up on 2026-09-26. Baseline: `6d9b169`; development stays on `dev` in the existing `runmesh-central-completion` worktree. The separate `main` worktree and its staged release edits are untouched.

## Product outcome

A user connects their AI client to Runmesh once, selects approved shared MCP tools and Skills, and uses them without a Runner. A Runner is only required for machine operations. Instance administrators configure services once; routine use must not require JSON, internal IDs, revision numbers or content digests. This review treats the September 24 plan as product context, not permission to configure new external services or relax authorization.

## Baseline findings

| Priority | Observed gap | Product impact | Required outcome |
|---|---|---|---|
| P0 | Live dev `/admin/central` is an operation selector with object ID and request JSON fields | Basic connection, approval, Skill import and sharing require API knowledge | Guided forms, persisted lists, review screens and explicit actions |
| P0 | The UI asks the user to carry revision numbers and digests between operations | Easy to submit stale or wrong data; uncertain writes are hard to recover | UI captures exact reviewed revisions, handles conflicts without replaying writes |
| P1 | Skill administration has inspect/mutate entrypoints but no discoverable admin library | Users must already know an ID to find saved Skills | Bounded, authenticated Skill listing with readable metadata |
| P1 | Default navigation and copy emphasize control plane mechanics | Users cannot see the next step to start using shared tools | Explain connect → choose tools/Skills → use one client entrypoint; keep diagnostics secondary |
| P1 | Live Chinese UI still shows an untranslated initial result string | Inconsistent first-use experience | Localize both rendered HTML and dynamically inserted status/error text |

## Implemented product flow

1. The default homepage now starts with adding capabilities and connecting an AI client. Computer access is a collapsed optional section; shell-job counters and Runner setup no longer dominate the first screen. The native-only dashboard remains available when central capabilities are disabled, and the explicit `/admin?history=1` computer-activity view preserves existing bounded history loading.
2. The Services & Skills library provides saved service cards, approved endpoint selection, credential updates, tool review, Skill file/folder import, content preview, explicit publication, and per-client permission checkboxes. Raw API operations are under collapsed advanced diagnostics.
3. Instance administrators configure endpoint policy and credential storage once. The page reads sanitized readiness flags and approved endpoints; unavailable setup disables service creation and explains why. Skill import remains independent when the Skill feature is enabled. This readiness check does not claim an upstream service is reachable.
4. New AI connections default to services and Skills, without computer scopes. The once-only connection URL page links directly to that client's access page. Service-only connections neither require a Runner nor show a Runner-reset action. Their MCP discovery omits unavailable native tools.
5. The Skill library has authenticated, bounded pagination. Access selection uses published Skill metadata instead of a newer unreviewed draft. Existing pinned grants remain selected until explicitly removed.
6. Credential inputs clear on submission. The UI carries reviewed revisions and digests, blocks further writes after conflicts, unconfirmed mutations or failed library refresh, preserves the selected client on refresh, and never automatically replays a write.

## Additional defects corrected

| Finding | Correction | Evidence |
|---|---|---|
| Connection form appeared usable without an approved endpoint or vault | Disable creation and explain missing instance setup; never expose vault contents | HTTP setup and Chinese rendering tests; browser unconfigured-state check |
| No guided recovery for expired bearer credentials | Add an explicit token update action on service cards | Browser credential rotation and input-clearing check |
| Draft Skill metadata could describe an older published version in the access picker | Read and verify the published bundle when draft and active digests differ | Browser staged-draft/published-version regression |
| Failed refresh could leave old mutation controls usable | Mark the library stale before reads and refuse writes until a complete refresh | Browser failed-refresh check |
| New connection handoff required selecting the client again | Carry only the client ID in the access link and open its access tab | HTTP handoff and browser deep-link checks |
| Remote-only tool discovery advertised unusable computer tools | Disable native catalog registrations only for clients without native scopes; keep live authorization checks | Central identity and mixed native/remote integration tests |
| Homepage still looked like a runtime control plane | Replace first-screen infrastructure metrics with capability and AI-connection entry points | Browser navigation, heading, mobile-width checks; bilingual HTTP homepage tests |
| First homepage revision hid the explicit computer-activity view | Restore the existing history route behind an optional user action without background history reads | 43 homepage/authentication/Job-dashboard regression tests passed after correction |

## Local verification

No screenshots were captured. Browser tests used an isolated headless Microsoft Edge session with synthetic fixtures and DOM assertions; they did not use a personal browser profile or external provider credentials.

| Check | Result |
|---|---|
| TypeScript build | Passed |
| Worker suite | Final run after all changes: 81 files / 1,253 tests passed, 0 failed |
| Domain suite | 16 files / 201 tests passed |
| Contract suite | 3 files / 50 tests passed |
| Protocol suite | 5 files / 43 tests passed |
| Node verification suites | 447 passed, 27 skipped, 0 failed |
| Navigation, localization, browser source baselines | 13 tests passed |
| Guided product browser flow | Passed: homepage, unready setup, explicit tool review, token rotation, Skill preview/publication, published metadata, retained pinned grants, client handoff, conflict/no-replay, failed refresh, 390px layout; screenshots: 0 |
| Architecture, formatting, docs, verification inventory, diff whitespace | Passed |
| Runner suite on Node 22.23.2 | Final serial run: 398 passed, 58 platform skips, 0 failed (35 files passed, 2 skipped). One earlier Git-baseline assertion returned unknown; isolated 7-test rerun and final full run passed without code or timeout changes |
| Real local Worker/Runner E2E on Windows, Node 22.23.2 | 33 passed, 1 failed, 1 skipped. The Git history/blame case returns git_unavailable because this host has portable Git under the user profile and no Git in the machine-wide directories admitted by the production isolation policy. The Linux Chromium check is the skipped case |
| Real local Worker/Runner E2E on Debian Linux, Node 22.23.2 (2026-09-26 follow-up) | 34 passed, 1 skipped, 0 failed, including real Git history and blame without shell permission. The isolated source copy passed a fresh npm ci, typecheck and build. Chromium was unavailable in this Linux environment; the independent Edge product regression passed again with screenshots: 0 |
| Browser gate navigation/evidence unit checks | 48 passed, 1 platform skip; stability selectors now cover the product homepage and native-only fallback |

The system Node 24.19.0 does not satisfy the Runner's existing supported-runtime contract. Its initial CLI failures are environment failures, not evidence of a product regression. Node 22.23.2 was acquired for the rerun and its executable SHA-256 was checked against the official Node checksums. The Linux follow-up used a separately checksum-verified official Node archive and the distribution's trusted Git installation. The Windows Git E2E failure remains recorded as an environment limitation; the same test passed on Linux. Neither runtime requirements, trusted executable policy nor test assertions were relaxed.

The initial GitHub CI run for `0d0a25c` found four rendering baseline mismatches. The local browser source contained 194 CRLF line endings, while `.gitattributes` commits it as LF. The reviewed fixture capture had therefore included 194 extra bytes in each full page. The browser source was restored to its identical Git-normalized bytes and both full-page and inline-script fixtures were recaptured. Runtime code and exact byte/hash assertions are unchanged; subsequent verification uses the normalized source.

## Remaining product and release boundaries

- OAuth provider onboarding and reusable toolset management still use advanced operations. Public service discovery/marketplace and guided provider registration are not implemented.
- An instance administrator still needs to approve upstream destinations and provision the vault. The product does not promise arbitrary MCP services work without configuration.
- Browser fixtures do not certify actual provider OAuth or compatibility with every AI client. Real-host authorization, refresh, and revocation acceptance remain separate release work.
- The pinned Linux Chromium browser gate and production were not run locally.
- This record is the local pre-push verification snapshot. Publication follows the repository's existing sequence: push reviewed source to GitHub dev, require GitHub Actions verify-all success on that exact commit, then fast-forward GitLab dev. A connected development deployment requires its own completion and live commit verification; local tests do not certify deployment.

These changes make the common relay/Skill workflow usable through forms and explicit review. They do not establish production readiness or certify every external provider.
