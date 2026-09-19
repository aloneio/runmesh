# Configure Job history, manual reads and retention

Cloud Job history keeps recent metadata for later viewing. Retained stdout/stderr stays on the Runner and is retrieved on request, subject to its local log limits. Production defaults to D1 through `HISTORY_DB`; login, enrollment and current permissions remain in RegistryDO.

## Choose settings

Open a Runner's **Job history and retention / 任务记录与保留** page using an administrator session.

| Setting | Choices | Default |
| --- | --- | --- |
| Cloud history | Off, batched, immediate | Batched |
| Upload interval | 1, 5, 15, 60 minutes | 5 minutes |
| Cloud terminal history | 1, 3, 7, 14, 30, 90 days | 7 days |
| Local terminal Jobs/logs | Existing count/byte caps, or the same day choices | Existing caps only |
| Records per manual read | 10, 20, 50, 100 | 10 |
| Log chunk | 1, 4, 16 KiB | Last 4 KiB |

Cloud preferences apply at the next archive operation. A capable Runner receives upload interval and local-retention settings on its next authenticated connection. If D1 is unavailable during a retention change, reads use the new visibility window while physical cleanup configuration may wait for a successful upload.

**Local day-based deletion requires separate confirmation.** It removes expired terminal metadata and stdout/stderr files irreversibly. Workspace files and running, queued, cancelling or uncertain recovered Jobs are outside that cleanup. Existing count/byte caps continue to apply.

Use the client's **Cloud Job history** setting to choose whether to record new Jobs. Re-enabling starts a new capture window; earlier unrecorded Jobs stay excluded. Existing archived history follows its retention settings. An upload already admitted when a preference changes may still complete.

## Load history and logs

Choose saved Jobs, live workspace Jobs, audit or both saved views, select a count, then press **Load / Refresh**. History reads are manual. The UI distinguishes unrequested, successfully empty and unavailable history.

Within Job details, select stdout/stderr to load its last 4 KiB. You can choose 1/4/16 KiB, the beginning or another chunk. Output is escaped and bounded by UTF-8 bytes. Job/log read queries keep optional audit writes disabled while retaining current authorization checks.

Use workspace-bound live Job queries for current host state. Saved history can lag behind execution or remain unavailable during an archive outage; keep the original Job ID when switching to a live query.

## Understand upload behavior

Source-side batching, archive receipts and local day-based cleanup require history protocol 1, available from Runner **v0.1.2**. In batched mode, such Runners sample periodically and suppress lifecycle-driven uploads. Off mode disables ordinary history uploads.

The **0.1.4 candidate** adds reporting protocol 2. A compatible Worker/Runner pair filters newly created no-record Jobs before upload and coalesces state changes into scheduled uploads. An acknowledged idle snapshot leaves the history timer stopped, with bounded recovery/retry exceptions. See [change-driven history](demand-job-history.md) / [中文](demand-job-history.zh-CN.md).

`recorded` and `unchanged` receipts acknowledge a snapshot. For reporting protocol 2, `disabled` stops scheduling on that connection. Deferred, failed or missing receipts retain work for a later upload opportunity. Older peers without receipt support can keep an idle snapshot stale until activity or reconnection. Install a compatible verified Runner separately from Worker deployment.

## Capacity, cleanup and cost

Each Registry namespace / Runner / lifecycle keeps at most **500 recent metadata records** in a **768 KiB packed D1 row**. Local count/byte limits can remove terminal Jobs before an upload, and the cloud count limit can remove records before their age limit. Keep separate records if you need complete long-term execution history.

Every fifteen minutes, cloud cleanup processes at most **20 packed rows**, rewriting expired terminal metadata with revision checks. Explicitly enabled local cleanup continues through transport disconnection and stops with the Runner. Offline hosts, backlog and quota failures can delay physical deletion beyond the visible retention window.

A changing Runner on a five-minute cadence produces about `86400 / 300 = 288` ordinary archive opportunities per day. Unchanged acknowledged snapshots are suppressed, and D1 enforces an interval guard across reconnects. Initial setup, cleanup, settings, audit and authorization consume additional operations.

D1 and Durable Objects are metered separately. Explicit daily row-quota errors pause the affected archive instance until the next UTC reset plus 30 seconds. That instance stays in cooldown; new instances and scheduled cleanup can make bounded probes. Monitor actual usage against [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

For failure handling, see [history isolation](quota-resilience.md) and [call recovery](mcp-agent-call-contract.md).
