# Operate optional history through quota or service failures

Runmesh separates current authorization in RegistryDO from optional D1 audit and Job history. This reduces competition for core storage operations while keeping every host operation subject to current permissions.

## Check the configured storage

Production defaults to D1 history using `HISTORY_DB`. Development/test uses SQLite when no D1 binding is present; explicit backend overrides take precedence. When D1 is selected but unavailable, history reports degraded/unavailable and stays on the selected backend.

D1 data is partitioned by Registry namespace, Runner ID and lifecycle. Reads and writes check that lifecycle so an old Runner instance's delayed history stays separate from a recreated Runner. Audit receipts expose `audit_status=recorded`, `degraded`, `disabled` or `unknown` alongside the operation result.

Both D1 and Durable Objects have metered limits. Exhausting Registry's allowance can still block operations requiring current authorization. Public health and fixed stable-release distribution use independent paths; development prerelease discovery uses its own cache. Consult [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Disable new cloud Job recording

In **Admin > MCP Clients > client detail > Cloud Job history**, select **Do not record new jobs** and save. Existing clients retain their chosen preference across deployment.

The preference suppresses new cloud Job snapshots and that client's `exec.*`/`job.*` audit entries. Existing cloud records, local metadata/logs, workspace files, client transcripts and provider logs retain their own lifetimes. Security and replay state remains available for authorization. Re-enabling begins a new capture window; already unrecorded Jobs stay excluded, while previously recorded Jobs can continue state updates.

For current Job access, use its original workspace:

```json
{"action":"get","workspace_id":"workspace","job_id":"job-..."}
```

Workspace-bound `get/logs/cancel/input` can operate independently of cloud Job history on Runner **0.1.1+**. The Registry checks current scope, selection and policy; the Runner verifies the actual Job workspace. Older peers return `runner_upgrade_required`.

A workspace-scoped list queries an online Runner directly. Without a workspace, or while offline, it uses retained cloud metadata. Jobs that were never recorded require live access. See [Job history](batched-job-history.md).

## Retention

Terminal-Job cleanup removes bounded batches while preserving active Jobs. Audit stores each cap metadata at **1,000 records per Runner**, with D1 also partitioned by lifecycle; reads exclude entries older than seven days.

During a backend transition, the read path can merge retained SQLite and D1 audit windows. D1 deletes at most **100 expired audit rows** per append or cron turn. The fifteen-minute D1 cleanup runs independently of core DO instantiation. Backlog or quota failures can extend physical retention; backups and point-in-time recovery have separate lifetimes.

## Respond to failures

D1 failures start a cooldown for the affected running instance. Daily row-quota errors delay retries until the next UTC day plus a recovery interval; other errors use a bounded cooldown. New instances may probe again, and cron has its own cadence. The cooldown avoids repeated calls to the failing backend in that instance.

| Observation | Next step |
| --- | --- |
| History unavailable or degraded audit receipt | Keep the execution receipt and retry the history query after recovery. Audit failure does not replay the command. |
| MCP `503` infrastructure failure | Check current control-plane/provider availability. |
| Initial MCP URL `404` | Check the credential; invalid, rotated and revoked URL credentials use this response. |
| Core authorization unavailable | Wait for recovery before host operations; current permission is required. |

Enrollment, client and policy storage failures return sanitized availability errors. Preserve existing credentials and data while diagnosing provider failures.

## Verify or change a deployment

The repository binds production `HISTORY_DB` to `runmesh-audit-history`. Resolve provisioning authorization through the Cloudflare build connection. See [Wrangler provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

Check `/health` for the backend/binding and deployed commit, then verify an authenticated history query or audit receipt to confirm actual access. The [deployment guide](deployment.md) describes the GitHub/GitLab build flow.

Switching to `sqlite` is an explicit operator change and moves history usage back to core storage. Preserve namespaces and existing data during that change.

**0.1.4** implements [reporting protocol 2](demand-job-history.md), which filters new no-record Jobs at a compatible Runner and uses change-driven uploads. Deploy the compatible Worker and install the verified Runner as separate steps. Authorization and heartbeat remain part of normal connection resource use.
