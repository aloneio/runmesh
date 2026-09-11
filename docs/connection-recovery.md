# Connection recovery and idle maintenance

## Failure semantics

Registry storage failure is not evidence of invalid Runner credentials. `recordHeartbeat` returns false only when its validated identity cannot match the stored session. Storage exceptions propagate to the Registry HTTP boundary, which returns a sanitized 503 with `Retry-After` and `Cache-Control: no-store`. Nonce replay remains rejected; nonce storage errors also propagate rather than masquerading as replay.

RunnerDO preserves availability failures during initial authentication, hello, heartbeat, lifecycle events, sync and session probes. A failed session probe never authorizes work or releases an RPC result. Explicit credential/session rejection keeps close code 4001. Storage, transport and overload failures use retryable close code 1013; an unavailable authentication dependency returns 429/503, not a fabricated 401. Policy and transport identity fences remain in force.

Runner classification uses explicit HTTP/close codes and typed errors, not arbitrary words such as authentication in an infrastructure error. An older Worker handshake rejection using 1008 and exact stale-credential wording remains supported. Real 401/403, 4001, and protocol rejection 1002 do not enter ordinary network recovery.

## Recovery budget

Ordinary network loss retains the existing jittered backoff capped at 30 seconds. Service outages start at 30 seconds, increase exponentially with jitter, and cap at five minutes. A valid Retry-After can extend the cooldown up to fifteen minutes. A brief welcome does not reset retry escalation; a connection stable for at least one minute resets it. Stop interrupts the default cooldown timer immediately.

Runner connection logs report the failure class and planned delay without printing credentials. Newly rendered systemd service manifests include RestartSec=30s. This source change does not modify already installed service units; inspect the effective service settings before assuming the new delay is active.

## Idle storage work

Business heartbeats remain every 30 seconds and the stale threshold remains 45 seconds. Liveness checks and exact MCP audit expiration keep their existing deadlines. Feature-health, administrator-session, internal-nonce and old-enrollment cleanup share a durable fifteen-minute sweep deadline, so every liveness alarm no longer probes all four tables. Authorization expiration remains checked on use; delaying physical cleanup does not extend permission or credential validity.

Nonce consumption uses one atomic uniqueness-checked statement instead of scanning/deleting all expired nonces for every signed mutation. A uniqueness conflict means replay; other SQL exceptions remain availability failures. The SQL rowsWritten check accounts for index writes.

A failed maintenance turn attempts to schedule a fifteen-minute cooldown. If even alarm persistence fails, the exception is allowed to reach the platform's bounded retry mechanism. With no online Runner or audit records, maintenance does not leave a perpetual recurring alarm.

These changes do not remove Durable Objects or claim to identify the dominant production billing category. Production request/read/write/alarm metrics must still be correlated with connection logs to quantify savings.

## Job snapshots

Jobs are shell command executions, not every MCP call. The console retains on-demand job and log reads without automatic polling. Failed job queries display unavailable rather than empty history or zero counts. Snapshot pages include an explicit UTC last-loaded timestamp. Runner-side logs are fetched only when a stream is selected, bounded to 16 KiB per request with policy/workspace checks.

## Verification and rollout

Focused regressions cover SQL failures and recovery, real credential rejection, 429/5xx transport failures, failed RPC session verification, real local WebSocket failures, retry bounds, stop cancellation, history sweep cadence and job UI errors. The ordinary unit, release-tool, Worker dry-run and local MCP-to-Worker-to-Runner end-to-end gates must remain passing.

Deploy the reviewed Worker change before upgrading to a newly verified Runner artifact. Older Runners can treat 1013 as ordinary network loss but do not implement the new extended cooldown. Do not replace a live Runner with an unverified workspace build or assume a source edit is already deployed.
