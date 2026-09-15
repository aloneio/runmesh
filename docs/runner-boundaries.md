# Job and Context side-effect boundaries (AR07)

Historical AR07 baseline: `a9b9bb5ef1e7275285c4ccfa54db0c685a03c23e`. This separates existing Runner responsibilities; it adds no tool, execution capability, automatic retention, state migration or service upgrade.

## Ownership

| Module | Responsibility |
| --- | --- |
| `jobs.ts` | Admission, queue turns, current records/children, terminal publication, cancellation and recovery sequencing |
| `jobs/records.ts`, `values.ts` | Existing record types, validation, bounded launch input and fingerprints |
| `jobs/storage.ts` | Private-directory checks, bounded metadata reads, atomic JSON and log descriptors |
| `jobs/process.ts` | Synchronous spawn, process identity observation and native termination, not admission |
| `jobs/logs.ts` | Bounded log paging through a narrow descriptor/path-observation port |
| `jobs/recovery.ts` | Existing interruption/cancellation record projection, not PID probing or exit-code guessing |
| `context-store.ts` | Per-workspace serialization, checkpoint sequencing and public compatibility methods |
| `context/model.ts`, `storage-types.ts` | Frozen formats, validation, fingerprints and observation types |
| `context/repository.ts`, `files.ts` | Private paths, bounded record/index access and immutable/atomic writes |
| `context/retention-plan.ts` | Deterministic sorting, batch selection, plan hash and summary of validated candidates |
| `context/retention.ts`, `recovery.ts` | Existing verified deletion loop and explicit index recovery |

Ports are internal TypeScript contracts, not public RPCs, CLI settings or plugin hooks. A log reader receives only log access and scope callbacks. Context retention/recovery receive only relevant operations and serialization, not the entire store or a shared mutable service container. Constructing the new objects performs no filesystem or process operation.

JobManager deliberately retains state ownership. Moving its maps and durability reservations into independent services would split a single transition across owners. Per-job persistence chains, terminal-write reservations, finishing promises and termination-delivery evidence remain together. The facade is still substantial; lifecycle complexity has not disappeared.

## Ordering invariants

The native spawn adapter calls Node spawn synchronously. The same-turn policy check, process birth marker, active publication and listener registration remain before the next await. Final cancellation identity checks remain next to the native terminator invocation. Existing POSIX escalation and Windows taskkill deadlines remain; they are not new polling.

Terminal Job publication stays behind metadata durability. Late active snapshots cannot overwrite reserved terminal writes. Nonzero exits retain their code; failed cancellation delivery does not fabricate cancellation. Restart observations remain unknown/interrupted where no exit result is available. Persisting a receipt and spawning an OS process are not an exactly-once transaction.

Context checkpoint ordering remains intent → immutable record → derived index → clear owned intent. Reads do not automatically recover or write missing state. Rebuild is explicit and bounded, validating rather than rewriting immutable records. Existing in-process serialization remains shared across ContextStore instances owning one state directory.

The retention planner accepts already validated eligible observations. Its output is data, not an authorization grant. The executor retains index checks, inventory, bounded reads, age filtering and plan verification. Before every unlink it rechecks content, latest revision, path identity and current permission. No new await separates that last permission check from deletion. Partial deletion requires a fresh preview, never a claim of rollback or secure media erasure.

## Verification

Structure comparison permits explicit adapter-receiver substitutions and the planner extraction only. It checks 45 JobManager method bodies, two log methods, 19 Context repository/facade bodies, 99 declarations, public signatures, checkpoint/rebuild logic, original constructor ordering and the three existing timer call sites. The plan hash keeps the same property order and selected-record bindings.

Fifteen fixed native Context scenarios compare results, persisted file hashes and filesystem call order/counts against the unmodified baseline. Plan hashes include inode observations: different fixture directories legitimately differ, each executor validates its own exact preview, and that field is excluded from cross-directory receipt equality. This is not a production load or account-cost claim.

New narrow-port and planner tests cover no-I/O construction, failed atomic rename preserving the previous file, temporary cleanup, bounded metadata, empty/unavailable logs, synchronous spawn, absent cancellation identity, unknown recovery, pending-checkpoint fences and deterministic planning. Existing fast-exit, cancellation races, queue fairness, restart, partial deletion and real process-crash tests remain enabled. The packaged Runner must also pass the MCP end-to-end suite after an offline install with install scripts disabled.

Architecture CI rejects nested Job/Context modules importing their facade or service/transport entrypoints. Model/planner modules cannot load filesystem/process/timer modules or depend on concrete adapters; ports cannot depend on implementations. Log reading cannot import process or metadata-storage implementations. These are source checks, not a sandbox or analysis of arbitrary third-party code.

## Resource and deployment boundary

No new durable files, state fields, tables, cloud requests, persistent timers, mandatory settings or dependencies. Existing limits, expiry and permission/path checks remain. Pure planning makes one bounded candidate-array copy; this is not a zero-allocation claim. Function/port calls are not remote services, and existing I/O still costs resources.

Public JobManager/ContextStore signatures and exported types remain compatible. Worker, wire/catalog, Wrangler, release records and published assets are unchanged. An unsigned development test package is not a replacement for immutable v0.1.3. Promotion and signed release remain separately authorized. Production restart, enrollment and credential rotation are not part of AR07.

## Subsequent composition refinement

The current modular remediation adds trusted internal JobManager and ContextStore adapter injection while retaining production defaults and shared state ownership. Internal overloads are excluded from the standalone published declaration surface. `composition-ports.test.ts` verifies failure injection without private-member replacement. Native service adapters, CLI commands, Patch and Git modules are documented in [modular remediation](architecture-remediation.md); the earlier invariants above remain binding.
