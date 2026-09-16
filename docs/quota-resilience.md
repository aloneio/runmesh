# Quota isolation and optional cloud Job history

## Implemented boundary

RegistryDO remains the strongly consistent authority for sessions, MCP credentials, enrollment, policy generations, replay fences and final dispatch authorization. Optional MCP audit history can use an independent D1 binding. This is not an authentication fallback or stale-permission cache. No paid-plan change is performed.

Cloudflare documents the same free storage allowance for both products: 5 million rows read and 100,000 rows written per day. D1 provides an independent history budget, not a larger or unlimited core-authentication allowance. Moving optional history away from Registry reduces competition with critical operations. Hard exhaustion of the remaining DO budget still prevents operations requiring current DO authority. Public health and fixed signed distribution remain independent.

References: [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Wrangler provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## Storage paths

Core credentials, enrollment and policy stay in RegistryDO SQLite. New audit metadata uses D1 when `RUNMESH_AUDIT_BACKEND=d1` and `HISTORY_DB` is bound. A missing/failing D1 binding reports degraded history and never silently falls back to DO writes. Production Job snapshots use bounded packed D1 rows when `RUNMESH_JOB_HISTORY_BACKEND=d1`; the SQLite path remains for compatibility. Per-client recording preferences still apply. See [batched Job history](batched-job-history.md). Full commands, output, file bodies, diffs and credentials remain excluded from cloud audit.

D1 partitions by Registry namespace, Runner lifecycle and Runner ID. Delayed writes cannot become history for a deleted/recreated Runner. Reads recheck lifecycle after awaiting D1. Receipts distinguish `audit_status=recorded`, `degraded`, `disabled`, and `unknown` from the execution outcome.

## Cloud Job no-record mode

In **Admin > MCP Clients > client detail > Cloud Job history**, select **Do not record new jobs** and save. Existing administrator session, same-origin and CSRF checks protect this setting. Existing clients default to recording; deployment does not silently change preferences.

The setting suppresses new cloud Job snapshots and that client's `exec.*` / `job.*` tool-audit entries. It does not delete existing cloud history, local Runner metadata/logs, user-created files, client transcripts, provider access logs, or necessary security/replay state. It is not anonymous or zero-disk execution.

Re-enabling starts a new capture window and does not backfill previously unrecorded jobs. Re-saving the same preference is idempotent. Existing recorded jobs may continue lifecycle updates so retained history does not remain falsely running.

For live `job get/logs/cancel/input`, supply the workspace:

```json
{"action":"get","workspace_id":"workspace","job_id":"job-..."}
```

A workspace-scoped `job list` queries the online Runner directly. Calls without a workspace retain their compatible cloud-snapshot path. Unrecorded jobs have no offline cloud history. History-independent operations require Runner 0.1.1+: Registry rechecks current scope, selected Runner, policy and workspace permission, and Runner verifies the actual Job workspace before acting. The supplied workspace is an expectation, not an authorization grant. Older peers fail closed with `runner_upgrade_required`. This Worker rollout does not upgrade or restart installed Runners.

## Cost and retention

Previously, terminal-Job retention read every retained Job after events/syncs, while audit retention scanned an OFFSET prefix. Additive SQLite triggers now maintain transactional counters with indexes for bounded oldest-record deletion. Overwrites do not increment counts, and rollback/deletion update counts atomically. Active jobs are never pruned by terminal retention.

The local Cloudflare SQLite regression with 1,000 terminal jobs and one active job measured **2,002 rows read on the prior terminal-retention query versus 1 row on the new no-overflow check**. This is a microbenchmark, not a measured reduction in production total daily usage. Triggers/indexes add writes; both metrics still need monitoring.

An attempted `PRAGMA schema_version` cache was rejected by the supported SQLite runtime and removed. Structural validation still rejects incompatible schemas; credential and permission checks are never cached.

Each store has a 1,000-entry audit cap per Runner (D1 also partitions by lifecycle). Seven-day-old entries are excluded on read. Old DO history is not copied or deleted during transition; the read path merges it with D1, so both stores can temporarily retain their individual windows. D1 removes at most 100 expired rows per append or cron turn. A 15-minute cron does not instantiate core DOs. Cleanup backlog or quota failure can extend physical retention beyond the visibility window; this is not a strict seven-day physical-deletion guarantee.

## Failure handling

D1 failures open a per-instance circuit without storing failure records in D1 or core DO. Explicit daily-row-quota errors delay retries until the next UTC day plus a recovery interval; other errors use a bounded cooldown. Cold construction can probe again: this is not a global persistent quota meter. During a hot-instance cooldown, repeated calls make no further D1 requests. Cron probes have their own bounded cadence.

Failed history reads return unavailable, not a fake empty list. Audit failure never replays the user command. Skipping an optional Job write no longer clears the circuit accidentally. MCP infrastructure failures return 503, not a revoked-secret 404; genuine invalid credentials still return 404. Enrollment/client/policy SQL failures reach a sanitized availability response rather than masquerading as conflicts.

## Deployment and rollback

Production uses `HISTORY_DB`, database name `runmesh-audit-history`, and `RUNMESH_AUDIT_BACKEND=d1`. Development/test use the compatible SQLite mode; test D1 stays local. Wrangler auto-provisioning resolves/creates resources through the existing Cloudflare build connection. Missing build authorization must block deployment, not reset Registry or introduce a token in source.

Verify and merge into GitHub `dev`. After the mandatory GitHub CI aggregate succeeds, the repository automation fast-forwards that exact commit to GitLab `dev`, which triggers Cloudflare Workers Builds. Ordinary GitLab CI is intentionally skipped for mirrored `dev` pushes because the exact SHA has already passed the GitHub aggregate; merge requests, main pushes and explicit web/scheduled GitLab verification remain available. Divergence fails closed instead of being force-pushed. Check `/health` backend/binding indicators, then an authenticated audit canary. Binding presence alone does not prove D1 writes or establish the deployed SHA.

Rollback preserves the existing DO namespace and additive data. Returning to `sqlite` is explicit operator action, never automatic D1-failure fallback, and restores consumption of core quota. Do not delete databases, rotate credentials, purge Jobs or replace immutable Runner releases for this Worker-only rollout.

## Tests

Coverage includes actual local D1 writes, allow-listed metadata, retention/counts, namespace/lifecycle isolation, expiry, quota recovery, 1,000 suppressed retries, and cron independence. Worker tests exercise successful execution with degraded D1 audit, live Job operations without cloud rows, old-peer rejection, workspace isolation, no-backfill/idempotent settings, genuine credential rejection versus infrastructure errors, public distribution under DO failure, mutation failures and transactional retention rollback.

## Batched history amendment

The [batched Job contract](batched-job-history.md) adds packed D1 Job snapshots, manual newest-only reads and configurable cloud/local retention. Full stdout/stderr remains local. Source-side batching and local retention are shipped in the new immutable v0.1.2 release, not retroactively added to v0.1.1.

## Source-reporting amendment (development)

[Reporting protocol 2](demand-job-history.md) excludes newly admitted no-record Jobs at the Runner, binds that observation to the existing final authorization and queue digest, and replaces acknowledged-idle history polling with change-driven scheduling. Empty eligible updates return before opening D1. A log read never changes recording. Old peers and records without the new local hint retain cloud-filtered compatibility; the currently installed signed Runner is not changed by this source amendment. Existing heartbeat and authorization costs remain separate.
