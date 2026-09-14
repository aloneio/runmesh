# Enrollment fence recovery investigation — 2026-09-14

## Observed incident

The operator reported an unavailable Runner and `Enrollment code cleanup is uncertain; Runner remains safely fenced.` Investigation used main baseline `75d9eeb7b42b3e6546d8ee1ad1f7cc4b90dadf37`, service logs and isolated tests. No production credential or service mutation was used for reproduction.

All times are Asia/Singapore. At **19:03:38** the journal records credentials revoked/rejected and process exit. Subsequent starts received HTTP **401**; by **19:03:44** systemd had hit its start-rate limit. At **19:13:40–41** the operator's service start connected successfully. Its installed 0.1.2 bundle matches the independently signature-verified release archive. Current RestartSec is 30s; the old incident's sub-second restarts do not describe the current unit configuration.

The initial 401 is a separate finding from the recovery bug. Current authentication checks the provided token against the Registry row and configured pepper. Available logs do not identify the actor/operation that caused rejection, nor prove a token rotation, pepper/namespace change or daily quota event. Cloudflare audit history and the prior credential-generation record were unavailable. Earlier generic connection closures also cannot be attributed to a specific deployment from these logs.

## Reproduced defects

The quoted page appears only after code creation succeeded, when `/cancel-policy-mutation` fails. Cleanup means releasing the temporary safety lock, not deleting the code. The old message loses the internal error code, so the incident's exact internal branch cannot be proven from that message alone.

1. A disconnected RunnerDO retains historical session/epoch fields. Cancellation treats their presence as a live connection and requires the now-offline Registry session to match. The regression creates a real enrollment row and observes **409 mutation_state_changed**, which the browser maps to the reported failure.
2. Reconstruction replaces the persisted ID of an unfinished operation with `restart-reconcile`. Its original finalizer loses ownership. The regression observes the actual mutation ID being replaced.
3. Separately, missing mutation-commitment evidence could be treated as proof that nothing committed; this must instead remain uncertain.

Cloudflare documents that hibernation discards in-memory state and reconstructs the object while connections may remain alive: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

## Repair

Preserve owned operations across reconstruction while keeping execution fenced. Skip identical conservative-state writes. Cancellation requires complete Registry evidence and the same lifecycle/credential generation. For a proven uncommitted operation without a restorable live connection, release only its ownership; retain the execution fence and arm fresh reconciliation. Never revive a stale session or grant cached permissions.

Changed credentials, new lifecycles, committed operations, missing evidence and concurrent newer owners remain fenced. Truly uncertain storage/network failures remain unavailable. No timer, polling loop, credential rotation, enrollment consumption, database reset or service restart is added.

The page now states that code creation succeeded but safety-lock release failed, with an allow-listed error code and phase headers. Raw provider messages and enrollment credentials remain hidden. The original transport test accepted either 204 or 409; the repair requires actual successful cancellation.

## Regression evidence

Coverage includes historical offline sessions, persisted reconstruction, repeated browser code generation through actual Registry/RunnerDO calls, incomplete proof, credential/lifecycle changes, already committed mutations, deleted records and delayed finalizers. Browser requests keep their normal session, CSRF and execution-mode checks. Error tests reject leakage of raw upstream messages.

Fifty reconstructions of the same owned fence produce no redundant storage.put calls. Required reads and authorization still cost resources; this is not zero account-wide usage.

## Release boundary

The repair is Worker-only. The installed immutable 0.1.2 package is not replaced. Passing tests or CI do not prove production deployment. Review through protected main and verify deployed source separately; null branch/commit fields in health cannot prove an exact source revision.
