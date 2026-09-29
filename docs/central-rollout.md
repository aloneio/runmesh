# Central capability rollout and acceptance ledger

Baseline fetched on 2026-09-25: GitHub dev ab95550 (W06), GitHub/GitLab main
77e82a1. GitLab dev was f25486b at the initial fetch and subsequently synchronized
to the W07-W09 candidate 47a8eeb. Work continues in an isolated checkout; the
original main working tree's eight staged release/document changes are preserved.
Development continues directly on dev in the isolated working tree, as requested.
This ledger distinguishes implementation, local verification and external
acceptance. It is not a production release sign-off.

| Package | Implementation | Acceptance still requiring external evidence |
| --- | --- | --- |
| W00 | Current remote baseline isolated; old edits retained | Original real-host Job/workspace catalog and host Git diagnosis |
| W01-W06 | Inherited architecture, identity, profiles, reviewed catalog, HTTP MCP and OAuth/session baseline | Real supplier OAuth and deployment network boundary |
| W07 | Shared active Skill lifecycle, immutable versions, paginated tools/resources | Real host resource behavior; general YAML/archive import remains unsupported |
| W08 | Guided shared library, retired assignment APIs, direct and bounded discovery catalogs | Two actual AI host versions, cache refresh and Job recovery evidence |
| W09 | Optional durable call budgets, cooldown, metadata receipts | Account-level quota and cost measurements; distributed rate limiting is not promised |
| W10 | Local domain/SQLite/HTTP/SDK/compatibility regression fixtures | Public DNS/SSRF, actual host matrix, measured CPU/peak memory/p50/p95 under production-like load |
| W11 | Independent opt-ins, retained tables/versions, rollout and disable instructions | Canary deployment, dev-to-main promotion, published CI/release evidence |

## Required canary sequence

The development follow-up adds CAPABILITIES / CapabilitiesDOv1 with the independent
central-dev-v1 SQLite migration and enables Skills, direct tools and governance
in the development environment. The 0.1.6 candidate now includes the same central binding and feature flags in both production configurations, using a declarative CapabilitiesDOv1 export. Existing Registry/Runner identities, tombstones and D1 bindings remain intact. These source changes have not activated the candidate in production. Remote endpoints, OAuth policies and
vault keys are not provisioned by this change. The existing GitLab dev connection
triggers Cloudflare Workers Builds; local Cloudflare account access is not needed
to trigger that path. Verify the exact candidate on GitHub, fast-forward GitLab
dev, then compare the live health commit/tag and authenticated central page. A
successful push alone is not evidence that the build or deployment succeeded.

1. Review the fixed candidate commit and CI results. Keep the native catalog and
   Worker-Runner wire baseline unchanged. Do not force-push main or disable checks.
2. Use a separate approved deployment with the existing optional Capabilities
   SQLite DO binding/migration and independent vault keyring. Retain public-only
   egress and exact HTTPS endpoint policies. Do not modify the old namespaces.
3. Verify the source-configured CENTRAL_SKILLS_ENABLED, CENTRAL_DIRECT_TOOLS_ENABLED and CENTRAL_GOVERNANCE_ENABLED flags. The 0.1.6 candidate enables all three; initialize the independent vault through setup:secrets for the selected environment.
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
也不等于 W11 灰度或发布。0.1.6 候选源码已包含生产绑定和功能开关，线上生产启用仍需完成签名验证与激活。上述外部门禁未取得证据前，整体
计划不得标为已验收完成；使用独立部署按步骤验收后，再通过既有 dev→main 门禁。
