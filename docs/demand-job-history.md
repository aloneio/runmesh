# Change-driven Job history

Change-driven reporting uploads recent Job metadata when recorded Jobs change, then stops its history timer once those changes are acknowledged. It is available in **0.1.4** and requires a compatible Worker/Runner pair with D1 history.

## Enable and configure reporting

Choose the recording preference in **Admin > MCP Clients > client detail > Cloud Job history**. Set the Runner's upload mode and interval in **Job history and retention**. The control plane supplies the recording decision when authorizing a launch.

Reporting protocol 2 is active when the Runner advertises `capabilities.labels.job_reporting_protocol="2"` and receives `runmesh_job_reporting:2` in its authenticated welcome. It uses the existing `job_history_protocol="1"` settings. See [history settings](batched-job-history.md).

Jobs created with recording disabled stay excluded from upload candidates and the heartbeat's active-Job ID list. Their execution, local metadata, logs and control operations remain available through live workspace-bound queries. `job.logs` reads only the requested local page; recording preferences are changed through the administrator settings.

Retries with the same valid launch identity return the original Job and its capture decision. A queued launch receives fresh authorization, which can further restrict recording. An already unrecorded Job stays unrecorded when preferences are re-enabled.

Preference changes apply at cloud archive admission and new launches. A previously allowed Job may still send metadata for cloud filtering, and an upload already admitted may complete. Existing archived history follows its retention settings; re-enabling starts a new capture window.

## Upload behavior

| Situation | Behavior after negotiation |
| --- | --- |
| Global history off | History capture and upload scheduling are disabled |
| Authenticated connection with history on | One bounded recovery capture of eligible retained metadata; an empty capture completes locally |
| A recordable Job changes state | Coalesce pending changes; batched mode waits the configured interval, immediate mode schedules the next turn |
| Only unrecorded Jobs run or logs are read | Those activities leave history scheduling idle |
| Acknowledged state with no newer changes | Stop the history timer |
| `recorded` or `unchanged` receipt | Acknowledge the captured generation; later changes remain pending |
| Deferred/degraded/lost receipt or capture/send failure | Retain pending changes and retry with exponential delay, starting at the configured interval and capped at one hour |
| Retry with no newer changes | Reuse the bounded captured payload |
| `disabled` receipt | Stop that connection's history scheduler until a new authenticated connection supplies settings |
| Disconnect or stop | Cancel the connection's timer and capture state; reconnect authenticates and captures again |

Recovered recordable `unknown` processes retain a bounded reconciliation opportunity while their outcome is unresolved, because the restarted Runner has no child exit callback for them. Policy changes can also request a capture. Explicit live queries and execution admission reconcile unrecorded recovered Jobs.

## Capacity and cost

Each capture contains at most **500 metadata records**, subject to wire and local-retention limits. A connection retains one captured payload. Treat this as a recent snapshot: local and cloud retention can remove records, so keep independent records for a complete long-term execution history. Command text, stdout/stderr bodies, host paths and queue credentials remain outside cloud Job history.

The Registry validates transport identity and current preferences even for an empty update. If filtering leaves no Jobs, it returns `unchanged` before accessing D1. Existing cloud history is cleaned up through retention. Authorization, heartbeat, ordinary archive and cleanup operations retain their normal resource costs.

## Compatibility

| Pair or state | Behavior |
| --- | --- |
| Compatible Worker and Runner with D1/protocol 2 negotiated | Source filtering and change-driven history |
| Compatible Worker with an older Runner | Existing Runner scheduling and cloud filtering; empty eligible updates avoid D1 |
| New Runner with an older Worker | Legacy scheduling until negotiation is available; explicit local no-record markers remain excluded |
| SQLite backend | Existing compatible history behavior |
| Local records without a capture marker | Eligible bounded metadata may upload and pass current cloud filtering |
| Binary downgrade | Older code may ignore or drop the capture marker; verify behavior using a backup before relying on source filtering |

Deploy a compatible Worker, install a verified Runner release containing the feature, then check the negotiated behavior. Worker deployment and Runner installation are separate upgrade steps.
