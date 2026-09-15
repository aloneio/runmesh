# Review correctness repairs — first implementation slice

Baseline: `b330f1dcb4334c1d36cf7c5858adf0de692e5b97`, corresponding to the 2026-09-15 optimization review. This document records source behavior and compatibility, not a claim that every installed Runner contains it.

## R02: one error definition, explicit execution stage

Runner imports and re-exports the protocol failure mapping instead of maintaining a second implementation. `queue_full`, request-ID conflict, changed search snapshots and context errors have the same metadata across the Runner and Worker. Generic dependency failures and timeouts do not establish whether a mutation executed; their default outcome is unknown and the next step is inspection, not replay.

An internal caller can narrow the operation state only when its own flow establishes it. The Worker marks failed pre-dispatch authorization as not started. Failure to receive a bridge reply after dispatch remains unknown. The MCP projection preserves the bounded state without forwarding private error messages or host paths. Malformed or unsuccessful RPC success envelopes are not accepted as successful results. Stdin, cancellation and edits are never retried automatically.

## R03: complete bounded Git history

Git log uses NUL-terminated `tformat` records and retains legal empty fields. A limit-plus-one probe distinguishes reaching the requested result count from exhausting history; truncated or omitted fields remain explicitly incomplete. Serialized output has a byte budget. Blame receives the actual validated filename after `--`, not another subcommand's `:(literal)` pathspec. Show/blame explicitly disable text conversion. Existing isolated Git configuration, trusted executables, descriptor/path checks and timeouts remain.

The regression fixture covers 1, 3 and 100 commits, empty subjects, output limits, and filenames with spaces, brackets, Unicode and leading hyphens. Git operations never commit or push the user's repository.

## R04: stable checkpoint facts and recoverable derived indexes

Checkpoint deduplication compares normalized facts without the per-read observation timestamp. Evidence identity, status, exit result, observation source, policy and baseline still participate. A duplicate returns the original record, including its original observed time; a genuinely changed Job status creates another revision.

A retry of the most recent committed checkpoint may contain the parent revision used for that checkpoint. Matching facts return the stored receipt; conflicting inputs, future revisions, unrelated turns and older obsolete writes fail. This does not promise arbitrarily old request-ID receipts. New checkpoints omit context_id; updates supply the returned server ID. Unknown supplied IDs now fail rather than creating caller-selected records. This is an intentional tightening of earlier undocumented behavior, explicitly covered by the end-to-end test; callers that previously invented IDs must omit that field on first creation.

Immutable record creation is the authority; the index is derived. If an index update fails after record creation, the result explicitly says the record may already be committed. A missing or stale index is not treated as an empty database. The caller runs the authorized `context rebuild`, then retries the same input and expected revision. Recovery does not delete or rewrite prior record bodies.

A small private checkpoint intent is persisted before the immutable record. This closes the separate new-turn failure window where an older valid index could otherwise hide the committed new record and allow duplicate random IDs. While that intent is unresolved, reads and writes report `context_index_stale`, not empty history or successful recovery. The explicit rebuild checks the intent's binding and record fingerprint before clearing it; malformed or changed ownership stays blocked. This adds bounded local metadata writes only for actual new revisions, not cloud writes or writes during deduplicated retries. Process-interruption recovery is tested; it is not a universal power-loss or multi-process transaction guarantee.

Rebuild streams directory entries instead of allocating an unbounded directory listing. It retains the 4,096-file and 32 MiB input bounds and also caps entries at 8,192 with a four-second cooperative work budget. A filesystem I/O call itself is not made cancelable by that deadline. Exceeding a budget leaves the saved state in place for explicit operator recovery.

Instances in one managed Runner process serialize by state-directory/workspace. Record creation remains exclusive. This is not a distributed or multi-process writer lock; do not run multiple independent Runner processes against the same state directory. The current rollout does not add a state-directory migration.

Current policy is rechecked after evidence collection, before record writes and before an explicit rebuild publishes its index. Once the immutable record is committed, completing its derived index is housekeeping, not another execution grant. A permission change cannot retroactively undo an already committed operation.

## R05: freshness without unsupported certainty

A checkpoint records the observed HEAD plus a bounded working-tree status: clean, dirty or unknown. Observation samples HEAD, a status output capped at 32 KiB, bounded tracked-index flags and HEAD again. The subprocess probes share a 1.5-second observation budget rather than each receiving the full RPC timeout; process shutdown and safe metadata I/O may extend cleanup beyond that budget. A moving HEAD, exhausted budget, truncated status or inaccessible Git state is unknown. Index flags that hide changes, including assume-unchanged and skip-worktree, also prevent a clean claim without modifying those flags.

`commit_state` says whether the observed commit still matches. `baseline_state=current` additionally requires a recorded clean baseline and a currently clean status. A newly dirty tracked/untracked tree is stale; a checkpoint made on an already dirty tree remains unknown because this slice does not fingerprint all dirty file contents. Legacy records lacking worktree evidence are unknown, not silently upgraded to current.

The explicit scope is `git-tracked-and-untracked-status`. This is a sampled Git observation, not an atomic filesystem snapshot or proof of ignored files, installed dependencies, external services, test sufficiency or the entire software requirement. It adds bounded on-demand local Git work to context operations, not cloud history writes, polling, monitoring timers or external embeddings.

## Record compatibility and release boundary

| Data / component | Behavior |
| --- | --- |
| Existing context record v1 | Read and rebuild with the frozen v1 digest; immutable bytes stay unchanged |
| New explicit checkpoint | Writes record v2, whose digest also binds policy, observation source and worktree state |
| Index | Remains a rebuildable version-1 index; does not replace record integrity |
| Unsupported record version | Rejected, never repaired into an empty or permissive state |
| Old Runner after v2 data was created | May reject the new record; binary rollback is not a data downgrade |
| Current published v0.1.3 | Remains immutable and unchanged; this source patch is not retroactively included |

A future formal Runner release must verify the exact portable archive and this compatibility matrix before activation. Back up its private state and arrange an independent recovery channel before upgrading the maintenance Runner. No secret replacement, release-asset overwrite, implicit re-enrollment, namespace reset or service restart is included in this repair.

## Evidence and remaining work

The original six review counterexamples were added as failing regression tests before the fixes. Runner and Worker tests now include actual MCP error projection, post-dispatch reply loss, pre-dispatch dependency failure, malformed RPC replies, old record compatibility, v2 integrity, simultaneous same-process stores, missing/stale index recovery, dirty trees and permission changes during evidence collection.

Additional failing probes identified new-turn orphan duplication beside an existing index, false-empty reads after a committed checkpoint, hidden tracked-index changes and repeated timeout budgets. Coverage now includes actual process exit before index publication, 100 identical retries with zero record/index writes, and end-to-end Git history and observed-Job checkpoint retries through the real MCP transport. Human-readable recovery hints are checked together with machine-readable execution state; an unknown result must not suggest replay just because the error code can ordinarily mean busy.

R01 remains a deployment/client verification track: code, signed archive, live process and host tool directory are separate facts. The existing MCP connection can still expose an older tool schema even after its Runner updates. No cloud deployment or host cache refresh is inferred from source tests. R06 still requires authorized provider usage exports; local microbenchmarks do not prove the account's full quota usage.

The first slice deliberately excludes R07–R10's complete contract generation, physical Context retention, large domain refactoring and installation orchestration. Each requires its own tests and release evidence; none is marked complete by this document.
