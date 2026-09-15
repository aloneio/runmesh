# Change-driven Job history

Implementation baseline: `ab3ad6d66fc54792e3a4c77e4e1a298d16612358`. This describes development source, not a deployed Worker or a replacement for the immutable v0.1.3 Runner.

## Separate execution, local logs and optional cloud history

`job.logs` reads a bounded local page. It never enables recording or creates a history subscription. Foreground execution still returns its own result without waiting for the cloud archive. Local job metadata, stdout/stderr, execution receipts, cancellation and queue recovery remain available independently of cloud recording.

With `capabilities.labels.job_reporting_protocol="2"` and the authenticated `runmesh_job_reporting:2` welcome extension, the existing D1 history path supports source filtering and change-driven uploads. The existing `job_history_protocol="1"` settings remain unchanged. No public MCP parameter grants control over recording, and no new deployment variable is required.

## Trusted capture decision

The existing final Registry authorization can return an internal `record_history` observation for an execution request. It reuses the client record already read for that authorization; it is not a second remote lookup or an authorization cache. RunnerDO discards supplied capture/queue-grant fields, inserts the verified decision only for a negotiated peer, and binds it into the existing queue launch digest. The final local policy fence remains directly before dispatch with no new asynchronous boundary.

The Runner persists this optional local-only boolean with a new Job. Explicit false excludes that Job **before** sorting and limiting upload candidates, suppresses lifecycle-triggered history scheduling, and excludes its ID from the independent heartbeat's active-job list. Heartbeat timing and lease checks do not change. The flag is not sent in cloud Job metadata or added to public tool output.

An idempotent retry returns the original Job without enabling an originally unrecorded task. A fresh dequeue authorization may further restrict capture, never enable a false Job. Malformed explicit persisted markers are treated as false while keeping an otherwise recoverable process record. No existing record is rewritten merely for upgrading.

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

## Cloud empty-update fast path

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

Deploy a compatible Worker only through the separately authorized production process, then explicitly upgrade using a new verified signed Runner artifact. Merely merging development source does not change the installed v0.1.3, overwrite its assets, restart the maintenance connection or alter recording settings.

## Verification

Tests cover source exclusion before the cap, native local execution/log access, persistence/recovery, no-backfill retries, mixed clients, queue-time restrictions, signed input binding, actual final bridge denial and policy races, capability negotiation, zero D1 access for empty eligible batches, generation-aware ACKs, capped retry timing, cached retries, reconnect cancellation, and the recovered-process exception.

Loopback tests use a real Runner, subprocesses and WebSocket frames with an injected upload clock. The simulated 288 idle opportunities are not an observed production day. Source and independently installed package E2E additionally verify the administrator recording preference through the actual MCP/Worker/Runner path. Tests leave production data, service state and release assets unchanged.
