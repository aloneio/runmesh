# Quota isolation and optional cloud Job history

## Authentication and optional history

RegistryDO checks sessions, MCP credentials, enrollment, current policy and final dispatch authorization. Optional MCP audit history can use an independent D1 database. A history outage does not authorize calls from cached permissions; operations still require current authorization.

D1 and Durable Objects have independently metered storage usage. Keeping optional history in D1 reduces its competition with core authorization operations, but it does not increase the Durable Objects allowance. If that core allowance is exhausted, operations requiring current Registry authority can still fail. Public health and fixed stable-release distribution do not require a Registry read; development prerelease discovery has a separate cache path. Consult Cloudflare's current plan limits rather than treating history isolation as a zero-cost guarantee.

References: [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Wrangler provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## Storage paths

Core credentials, enrollment and policy stay in RegistryDO SQLite. Production defaults to D1 for audit metadata and Job history using `HISTORY_DB`. Development/test defaults to SQLite when no D1 binding is present. Explicit backend overrides remain available. If D1 is selected and its binding is missing or unavailable, history reports degraded/unavailable rather than silently falling back to core DO writes. Per-client recording preferences still apply. See [batched Job history](batched-job-history.md). Full commands, output, file bodies, diffs and credentials remain excluded from cloud audit.

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

Terminal-Job retention deletes a bounded number of old records when limits are exceeded. It does not prune active Jobs. Indexes and retention bookkeeping also consume storage operations; monitor actual D1 and Durable Objects usage for your account.

Each store has a 1,000-entry audit cap per Runner (D1 also partitions by lifecycle). Seven-day-old entries are excluded on read. Old DO history is not copied or deleted during transition; the read path merges it with D1, so both stores can temporarily retain their individual windows. D1 removes at most 100 expired rows per append or cron turn. A 15-minute cron does not instantiate core DOs. Cleanup backlog or quota failure can extend physical retention beyond the visibility window; this is not a strict seven-day physical-deletion guarantee.

## Failure handling

D1 failures open a per-instance circuit without storing failure records in D1 or core DO. Explicit daily-row-quota errors delay retries until the next UTC day plus a recovery interval; other errors use a bounded cooldown. Cold construction can probe again: this is not a global persistent quota meter. During a hot-instance cooldown, repeated calls make no further D1 requests. Cron probes have their own bounded cadence.

Failed history reads return unavailable, not a fake empty list. Audit failure never replays the user command. Skipping an optional Job write no longer clears the circuit accidentally. MCP infrastructure failures return 503, not a revoked-secret 404; genuine invalid credentials still return 404. Enrollment/client/policy SQL failures reach a sanitized availability response rather than masquerading as conflicts.

## Check a deployment or change the backend

The repository's production configuration binds `HISTORY_DB` to `runmesh-audit-history`. Wrangler provisioning uses the Cloudflare build connection; missing authorization must be resolved through that connection. Do not reset Registry or put deployment tokens in source to repair a history binding.

Check `/health` for the reported backend and binding, then make an authenticated history query or verify an audit receipt. A binding indicator alone does not prove that writes work. Check the deployment commit separately. See [deployment](deployment.md) for the GitHub/GitLab build flow.

Changing back to `sqlite` is an explicit operator action and moves history consumption back to core storage. Preserve existing namespaces and data when changing the backend. There is no automatic D1-failure fallback.

## Runner compatibility

[Batched history](batched-job-history.md) provides manual recent-history reads and cloud/local retention settings. Source-side batching and optional day-based local cleanup require history protocol 1, available from Runner v0.1.2.

The **0.1.4 candidate** implements [reporting protocol 2](demand-job-history.md): compatible Runner/Worker pairs filter newly admitted no-record Jobs before upload and use change-driven scheduling. Empty eligible updates avoid D1. A log read never changes the recording preference. Older peers and records without the capture marker keep their documented cloud-filtered behavior. Updating Worker code does not upgrade the installed Runner, and connection heartbeat and authorization costs remain separate.
