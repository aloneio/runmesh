# Batched Job history, manual reads and retention

## What is stored

The production configuration defaults to D1 Job history through `HISTORY_DB`. Optional cloud history stores recent Job metadata; full stdout/stderr remains on the Runner and is fetched only when requested. Login, enrollment and current permissions remain in RegistryDO. An archive failure does not replay a command or revoke its credentials.

Worker-side write throttling and manual UI support the existing Runner. Source-side event suppression, archive receipts and local day-based cleanup require `capabilities.labels.job_history_protocol=1`. These capabilities are shipped in the signed immutable **v0.1.2** artifact and are not retroactively added to v0.1.1. Publication neither replaces old assets nor restarts or upgrades installed Runners. Unsupported peers receive no new welcome settings.

## Change-driven reporting in the candidate

The **0.1.4 candidate** implements reporting protocol 2 on the D1 path. A compatible Runner filters newly created no-record Jobs before upload and stops its history timer once changes are acknowledged. Log reads remain on demand. Older Runners and records retain the compatibility behavior described in [change-driven history](demand-job-history.md) / [中文](demand-job-history.zh-CN.md). Updating the Worker does not add this behavior to an installed v0.1.3 Runner.

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

Each history snapshot packs multiple Job metadata records into **one bounded JSON row**. D1 still meters affected rows, and initial setup, cleanup, settings, audit and core authorization have separate costs. Batching reduces update frequency; it does not make history free or establish a fixed account-wide saving.

A continuously changing Runner at a five-minute cadence has approximately `86400 / 300 = 288` ordinary archive updates per day, excluding those other costs. Unchanged acknowledged snapshots do not upload again. A durable D1 interval guard also constrains reconnects and legacy event-plus-snapshot uploads.

D1 and Durable Objects have independently metered storage usage; consult Cloudflare's current plan limits. Explicit daily row-quota errors suspend that archive instance until the next UTC reset plus 30 seconds; reads and cleanup in the same running instance do not keep probing during the cooldown. New instances and independently scheduled cleanup may still make bounded probes. Runmesh does not use R2 for this history path or automatically upload full private logs.

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Bounds and reliability

Each Registry namespace / Runner / lifecycle has at most **500 recent Job metadata records** in a **768 KiB packed row**. The UI returns the selected recent count; storage reads one bounded snapshot instead of traversing all Job history. Log bodies are not fetched for listing.

This is a recent snapshot, not a lossless event archive. Local count/size caps can prune terminal jobs before a long upload interval, and records can leave the cloud 500-item cap before their retention period. Reaching a metadata cap never kills a local process.

A history-protocol-1 Runner suppresses lifecycle-driven uploads in batched/off mode and samples periodically. A reporting-protocol-2 pair instead coalesces state changes into one-shot uploads, with recovery checks and bounded retries described in [change-driven history](demand-job-history.md). Recorded/unchanged receipts acknowledge a snapshot; with reporting protocol 2, a disabled receipt stops history scheduling for that connection. Deferred/failed uploads or missing receipts are retried at a later opportunity without restarting commands. Peers without history-protocol-1 support cannot consume these receipts; their final idle snapshot may remain stale until activity or reconnection. Use workspace-bound live queries for the current local Job state.

Client no-record preferences still filter new snapshots; re-enabling does not backfill previously unrecorded jobs. A preference change is not a cross-database transaction: an already admitted upload may finish afterward. Turning recording off does not silently delete prior history.

## Manual reads and cleanup

Dashboard/Runner details do not read Job or audit history by default. Select saved Jobs, live workspace Jobs, audit, or both saved views; choose a count and press Load / Refresh. There is no background polling. Unavailable history differs from unrequested or successfully empty history.

Opening Job details does not read output. Select stdout/stderr to load the last 4 KiB, or explicitly choose 1/4/16 KiB, the beginning, or another chunk. Output is HTML-escaped and UTF-8-byte bounded. Read-only MCP Job/log queries do not create optional audit writes. Pure authorization-query endpoints retain timestamp/HMAC verification and current permission checks, but no longer persist replay nonces solely for returning a decision; actual mutations keep their nonce fences.

Every fifteen minutes, cloud cleanup processes at most 20 packed rows with an indexed keyset cursor and only rewrites expired terminal metadata, using revision checks. Local cleanup timers exist only when explicitly enabled, continue through ordinary transport disconnection, and stop with the Runner. Physical deletion may lag because of backlog, offline hosts or quota failures; day-based retention is not an exact-minute erasure promise.

For errors and recovery, see [quota isolation](quota-resilience.md) and [MCP call recovery](mcp-agent-call-contract.md).
