# Central capability rollout and acceptance ledger

## Historical baseline: 2026-09-25

The following baseline records implementation and open acceptance items on that date. Later acceptance records are appended separately.

Baseline fetched on 2026-09-25: GitHub dev ab95550 (W06), GitHub/GitLab main
77e82a1. GitLab dev was f25486b at the initial fetch and subsequently synchronized
to the W07-W09 candidate 47a8eeb. Work continues in an isolated checkout; the
original main working tree's eight staged release/document changes are preserved.
Development continues directly on dev in the isolated working tree, as requested.
This ledger distinguishes implementation, local verification and external
acceptance. It is not a production release sign-off.

| Package | Implementation | Acceptance awaiting evidence at this baseline |
| --- | --- | --- |
| W00 | Current remote baseline isolated; old edits retained | Original real-host Job/workspace catalog and host Git diagnosis |
| W01-W06 | Inherited architecture, identity, profiles, reviewed catalog, HTTP MCP and OAuth/session baseline | Real supplier OAuth and deployment network boundary |
| W07 | Shared active Skill lifecycle, immutable versions, paginated tools/resources | Real host resource behavior; general YAML/archive import remains unsupported |
| W08 | Guided shared library, retired assignment APIs, direct and bounded discovery catalogs | Two actual AI host versions, cache refresh and Job recovery evidence |
| W09 | Optional durable call budgets, cooldown, metadata receipts | Account-level quota and cost measurements; distributed rate limiting is not promised |
| W10 | Local domain/SQLite/HTTP/SDK/compatibility regression fixtures | Public DNS/SSRF, actual host matrix, measured CPU/peak memory/p50/p95 under production-like load |
| W11 | Independent opt-ins, retained tables/versions, rollout and disable instructions | Canary deployment, dev-to-main promotion, published CI/release evidence |

## Required canary sequence

Runmesh 0.1.6 configures CAPABILITIES / CapabilitiesDOv1 in development with the
central-dev-v1 SQLite migration and enables Skills, direct tools and governance.
Both production source configurations use a declarative CapabilitiesDOv1 export and enable the same features. Existing Registry/Runner identities, tombstones and D1 bindings remain intact. The [release and deployment guide](release-readiness.md) describes signed publication, production activation and live verification as separate steps. Remote endpoints are connected through the control panel; OAuth encryption uses the existing deployment secret. The existing GitLab dev connection
triggers Cloudflare Workers Builds; local Cloudflare account access is not needed
to trigger that path. Verify the exact candidate on GitHub, fast-forward GitLab
dev, then compare the live health commit/tag and authenticated central page. A
successful push alone is not evidence that the build or deployment succeeded.

1. Review the fixed candidate commit and CI results. Keep the native catalog and
   Worker-Runner wire baseline unchanged. Do not force-push main or disable checks.
2. Use a separate approved deployment with the existing optional Capabilities
   SQLite DO binding/migration and existing control secret. Retain public-only
   egress and exact HTTPS endpoint policies. Do not modify the old namespaces.
3. Verify the source-configured CENTRAL_SKILLS_ENABLED, CENTRAL_DIRECT_TOOLS_ENABLED and CENTRAL_GOVERNANCE_ENABLED flags. Runmesh 0.1.6 enables all three; OAuth requires no additional secret beyond the existing control secret.
   Control-panel connections persist exact endpoint admission; no provider environment configuration is supported.
4. With no Runner, configure two approved public MCP suppliers and one text Skill;
   connect two independently credentialed real clients to the shared publications,
   without creating grant rows.
   Record product/version/date, tools/resources support, schemas and cache refresh.
5. Add a Runner without reconfiguring those central capabilities. Verify native
   read/write policy, offline selected Runner behavior, original Job ID plus
   workspace_id recovery, and no unknown-operation replay.
6. Revoke a client credential after caching the directory. Disable a connector. Simulate
   central storage and receipt failures. Verify denied new calls and unaffected
   native calls. Measure bytes, CPU, memory and p50/p95, including a slow supplier.
7. Turn off all new flags and the remote configuration before rolling Worker
   code back. Retain new tables, ciphertext and immutable bundles. Old code cannot
   interpret newer central identities/OAuth; use the previously documented native
   compatibility matrix, never reset identity or Runner registration.
8. Promote only through the existing dev-to-main policy after the external gates
   are recorded. Do not overwrite immutable Runner releases or infer approval
   from passing local fixtures.

## Evidence discipline

Local results are stored under ignored .verification/ with command, exit status
and logs. The final development report records actual counts and skipped checks.
No real upstream secrets, production deployment, public-host acceptance or
published release is fabricated by this implementation.

中文说明：代码实现与本地测试不等于完成 W00/W10 的真实双宿主、公网网络和性能验收，
也不等于 W11 灰度或发布。0.1.6 源码已包含生产绑定和功能开关；[发行与部署说明](release-readiness.md)分别列出签名发行、生产激活和部署验证的步骤。上述外部门禁未取得证据前，整体
计划不得标为已验收完成；使用独立部署按步骤验收后，再通过既有 dev→main 门禁。

## Acceptance observations: 2026-10-04

**Actual AI clients.** Two independent Codex CLI/app-server 0.160.0 instances used separate credentials, threads and caches. On `676276ef57f95aab15336f665eb43c788e66a468`, both registered the five MCP/Skill tools and read Skill versions v2 and v3 in persistent sessions. Both credentials also completed real-model public documentation searches; A's search came from an earlier A process. The original revoked-client call timed out after 30 seconds. After request-associated error responses were added in `43214bc7d9e7025dd195e02addd6eef8fa57ba37`, a fresh A2/B2 pair kept its sessions throughout the follow-up: revoked A2 received an explicit JSON-RPC rejection in 930 ms, while the original B2 process continued listing Skills. Both tested clients were instances of the same product.

**Protocol load and lifecycle checks.** On dev `676276ef57f95aab15336f665eb43c788e66a468`, scripted checks covered 1,032 Linux Runner samples and 982 MCP/Skill samples, including six public upstream calls. The first sustained attempt stopped after 264 samples: 260 passed and four Runner reads/Jobs timed out. A separate same-load run completed 1,200/1,200 samples with unchanged transport and timeout behavior. The first four timeouts remain recorded; their root cause is unresolved. These protocol samples are separate from the actual-model calls above and overlap in coverage, so they are reported as individual suites.

**CI and targeted diagnostics.** For `85d5ea419c65d03ebc9d79c9b2e7f2491c6b256b`, GitHub dev CI run 37194315084 passed all eight checks; native GitLab browser job 16920451376 passed 37/37 cases with zero skips. A frozen diagnostic overlay on `c0f8c13` passed nine diagnostic tests and 21 real Worker SDK registration tests, followed by 30 rejection-to-paging groups and 120 MCP requests. The later predecessor-chain overlay on base `85d5ea4` passed ten disconnect/reconnect, background-Job, rejection and paging groups: 40 selected cases, 120 operations and 126 state polls, with zero operation retries. Its first two preparation attempts are retained separately: missing generated provenance, then a diagnostic startup-request cap; neither reached a business MCP call.

**Retained intermittent failure.** Earlier GitLab browser job 16920211719 returned HTTP 500 during R07. The subsequent passing runs did not reproduce it; its root cause remains unresolved. The candidate adds bounded per-request diagnostics for a recurrence. No transport retry or timeout increase was used to turn that historical failure into a pass.

These observations cover the identified development deployments, actual-client sessions and local diagnostic overlays. Package publication, production activation and live production checks are recorded by the release operator as separate observations.

Evidence records: `release112-real-host-report.md`, `audit111-report.md`, `release115-validation-report.md`, and `release116-linux-chain-run3/report.md` in the local operator evidence archive. Each retains source identities and the preceding failures.
