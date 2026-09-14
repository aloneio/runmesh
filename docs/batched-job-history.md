# Batched Job history, manual reads and retention

## Implementation and rollout boundary

Production selects `RUNMESH_JOB_HISTORY_BACKEND=d1` using the existing `HISTORY_DB`. Optional Job history is packed metadata, not one SQL row per Job and not full stdout/stderr uploads. Core login, enrollment, current permissions and transport identity remain in RegistryDO. A failed archive cannot revoke credentials or replay a command.

Worker-side write throttling and manual UI support the existing Runner. Source-side event suppression, archive receipts and local day-based cleanup require `capabilities.labels.job_history_protocol=1`. These capabilities are shipped in the signed immutable **v0.1.2** artifact and are not retroactively added to v0.1.1. Publication neither replaces old assets nor restarts or upgrades installed Runners. Unsupported peers receive no new welcome settings.

## Settings

In Runner detail, use **Job history and retention / 任务记录与保留**. The form requires an administrator session, same-origin checks and CSRF.

| Setting | Choices | Default |
|---|---|---|
| Cloud history | Off, batched, immediate | Batched |
| Upload interval | 1, 5, 15, 60 minutes | 5 minutes |
| Cloud terminal history | 1, 3, 7, 14, 30, 90 days | 7 days |
| Local terminal Jobs/logs | Existing count/byte caps only, or the same day choices | Existing caps only |
| Records per manual read | 10, 20, 50, 100 | 10 |
| Log chunk | 1, 4, 16 KiB | Last 4 KiB |

Local day-based deletion requires a separate confirmation. It irreversibly removes expired terminal metadata and stdout/stderr files, never workspace files. Running, queued, cancelling and uncertain recovered processes are excluded. Local day-based cleanup is not enabled merely by deployment. Existing count/size caps apply independently.

Cloud settings apply at the next archive operation. A capable Runner receives interval/local-retention settings on its next authenticated connection; this does not force a restart. If D1 is unavailable when retention changes, visibility uses the new setting but physical cleanup configuration may await another successful upload.

## Metered cost

Moving each INSERT to an asynchronous task does not reduce SQL row writes. D1 transactions and batches still count affected rows. This implementation coalesces state transitions and updates **one bounded JSON row** holding multiple Job metadata records. Revision checks prevent concurrent uploads/cleanup from overwriting newer data. The packed path avoids per-Job indexes and full-history OFFSET scans.

A real local D1 regression measured **one row written for a single-Job update and one for a 100-Job update** to an existing snapshot. Initial schema creation, initial indexed insertion, cleanup, settings, audit and core authorization are separate costs. These are microbenchmarks, not production-wide savings.

A continuously changing Runner at a five-minute cadence has approximately `86400 / 300 = 288` ordinary archive updates per day, excluding those other costs. Unchanged acknowledged snapshots do not upload again. A durable D1 interval guard also constrains reconnects and legacy event-plus-snapshot uploads.

D1 and DO have equal-sized free daily row allowances with independent accounting. Explicit daily row-quota errors suspend that archive instance until the next UTC reset plus 30 seconds; hot-instance reads and cleanup do not keep probing during the cooldown. Cold instances and independently scheduled cleanup may still make bounded probes. R2 Standard bills bytes and object operations: a future explicit full-log archive could combine logs in compressed objects. R2 is not unlimited free storage. This change does not activate R2 or upload full private logs merely to use a different quota.

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Bounds and reliability

Each Registry namespace / Runner / lifecycle has at most **500 recent Job metadata records** in a **768 KiB packed row**. The UI returns the selected recent count; storage reads one bounded snapshot instead of traversing all Job history. Log bodies are not fetched for listing.

This is a recent snapshot, not a lossless event archive. Local count/size caps can prune terminal jobs before a long upload interval, and records can leave the cloud 500-item cap before their retention period. Reaching a metadata cap never kills a local process.

A capable Runner suppresses lifecycle-driven uploads in batched/off mode. It marks a snapshot delivered only on a recorded/unchanged/disabled receipt. Deferred/failed uploads or missing receipts are retried at a later scheduled opportunity without restarting commands. Old released peers cannot consume these receipts; their final idle snapshot may remain stale until activity or reconnection. Workspace-bound live queries remain authoritative.

Client no-record preferences still filter new snapshots; re-enabling does not backfill previously unrecorded jobs. A preference change is not a cross-database transaction: an already admitted upload may finish afterward. Turning recording off does not silently delete prior history.

## Manual reads and cleanup

Dashboard/Runner details do not read Job or audit history by default. Select saved Jobs, live workspace Jobs, audit, or both saved views; choose a count and press Load / Refresh. There is no background polling. Unavailable history differs from unrequested or successfully empty history.

Opening Job details does not read output. Select stdout/stderr to load the last 4 KiB, or explicitly choose 1/4/16 KiB, the beginning, or another chunk. Output is HTML-escaped and UTF-8-byte bounded. Read-only MCP Job/log queries do not create optional audit writes. Pure authorization-query endpoints retain timestamp/HMAC verification and current permission checks, but no longer persist replay nonces solely for returning a decision; actual mutations keep their nonce fences.

Every fifteen minutes, cloud cleanup processes at most 20 packed rows with an indexed keyset cursor and only rewrites expired terminal metadata, using revision checks. Local cleanup timers exist only when explicitly enabled, continue through ordinary transport disconnection, and stop with the Runner. Physical deletion may lag because of backlog, offline hosts or quota failures; day-based retention is not an exact-minute erasure promise.

## Tests

Coverage includes real D1 row counts, interval persistence, concurrent updates, lifecycle isolation, no-record preferences, archive failure without Runner lockout, no core Job writes, bounded cleanup and active-job preservation. UI tests verify no default history reads, selected counts, no unrelated audit requests, bounded tails, malformed-query rejection, CSRF and explicit local-deletion confirmation.
