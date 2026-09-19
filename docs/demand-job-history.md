# Change-driven Job history

Change-driven reporting uploads recent Job metadata when recorded Jobs change, then stops the history timer once those changes are acknowledged. It is implemented in the **0.1.4 candidate** and requires a compatible Worker, Runner and D1 history configuration. Updating a Worker does not add it to an installed v0.1.3 Runner.

## Separate execution, local logs and optional cloud history

`job.logs` reads a bounded local page. It never enables recording or creates a history subscription. Foreground execution still returns its own result without waiting for the cloud archive. Local job metadata, stdout/stderr, execution receipts, cancellation and queue recovery remain available independently of cloud recording.

With `capabilities.labels.job_reporting_protocol="2"` and the authenticated `runmesh_job_reporting:2` welcome extension, the existing D1 history path supports source filtering and change-driven uploads. The existing `job_history_protocol="1"` settings remain unchanged. No public MCP parameter grants control over recording, and no new deployment variable is required.

## Choose which Jobs are recorded

In **Admin > MCP Clients > client detail > Cloud Job history**, select whether to record new Jobs. The authenticated control plane supplies this choice to a compatible Runner when it authorizes a launch. An MCP caller cannot override the recording preference by adding launch parameters.

Jobs created with recording disabled are excluded from history upload candidates and the heartbeat's active-Job ID list. Their state changes do not start a history upload timer. Normal connection heartbeat timing and local Job access remain unchanged.

A retry with the same valid request identity returns the original Job without enabling recording for it. Authorization is checked again before a queued command starts; that check may disable recording but cannot enable it for a Job created with recording disabled.

The cloud remains authoritative for current preferences and the recording start window. A preference changed after launch is not synchronously pushed to every running Job: an already-recorded launch may still be sent and filtered by the cloud, and an already-admitted archive operation may complete. Re-enabling does not backfill an originally unrecorded Job. Existing archived history is not deleted by this setting.

## Upload lifecycle

| Situation | Negotiated behavior |
| --- | --- |
| Global history off | No history bootstrap, upload timer or snapshot capture |
| Authenticated connection with history on | One bounded recovery/bootstrap capture of retained eligible metadata; empty history sends no archive frame |
| A recordable Job changes state | Mark a generation dirty and coalesce one upload opportunity; batched waits the configured interval, immediate schedules the next turn |
| Only unrecorded Jobs run, or logs are read | No history timer is created by those activities |
| Captured state is acknowledged and no newer changes exist | No periodic history scan or upload timer remains |
| Recorded/unchanged receipt | Acknowledge only its captured generation; newer changes remain pending |
| Deferred/degraded/lost receipt or capture/send failure | Keep pending history; one-shot exponential retries start at the configured interval and cap at one hour |
| Retry without newer changes | Reuse the bounded captured payload instead of repeating local snapshot scans |
| Disabled receipt | Stop that connection's history scheduler; new authenticated settings are needed to resume |
| Disconnect or stop | Cancel the old timer and discard connection-local capture/receipt state; a new connection revalidates and bootstraps |

Recovered recordable `unknown` processes have no live child exit callback. They retain a bounded reconciliation opportunity while unresolved; ordinary live children do not. Policy changes may also request a bounded new capture. These exceptions are not a full-time idle scanner or a log subscription. No-record recovered Jobs are still reconciled by existing execution admission and explicit live queries, not by optional history scheduling.

Existing limits apply: at most 500 metadata records per capture, current wire limits, bounded local retention and one captured payload per connection. This is a recent snapshot, not an exactly-once or lossless event archive. No command, stdout/stderr body, host path or queue credential is added to cloud history.

## Empty updates and cost

Registry still validates transport identity and applies current capture preferences. If every incoming Job is excluded, or the batch is empty, it returns `unchanged` before opening D1. Empty updates are not deletion requests. Cloud retention and its separately scheduled cleanup remain responsible for existing history. Core authentication reads, heartbeat handling, normal history updates and cleanup retain their costs; this is not an account-wide zero-usage claim.

## Compatibility and activation

| Pair / state | Behavior |
| --- | --- |
| New Worker + new Runner, D1 settings and reporting protocol 2 negotiated | Trusted source filtering and change-driven history |
| New Worker + old Runner | Existing history protocol and cloud filtering; empty eligible batches now avoid D1, but old Runner sampling cannot be changed remotely |
| Old Worker + new Runner | Legacy history scheduling until negotiation is available; explicit local false markers remain excluded |
| SQLite compatibility mode | Existing non-negotiated contract, not a claim of D1 reporting protocol 2 |
| Local records without the new marker | Legacy/unknown capture decision; eligible bounded metadata may still be sent, with current cloud filtering preserved |
| Binary downgrade after new local records | Older code may ignore/drop the optional marker; preserve state backups and do not claim source suppression after an unverified downgrade |

Deploy a compatible Worker, then explicitly upgrade using a verified signed Runner artifact that contains this feature. Check the negotiated behavior before relying on source-side suppression. Merging source does not upgrade the installed Runner or change recording preferences. See [Job history settings](batched-job-history.md) for intervals, retention and manual reads.
