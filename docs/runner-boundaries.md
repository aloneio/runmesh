# Job and Context recovery boundaries

Use the original Job or Context identifiers to inspect an interrupted operation before attempting it again. A transport timeout does not prove that nothing happened on the Runner. This page describes the current candidate behavior; use the capabilities of your installed Runner when diagnosing an older release.

## Starting and cancelling Jobs

The Runner checks current workspace policy before starting a process. Queued Jobs also need fresh control-plane authorization before launch. Cancellation while a Job is waiting prevents it from starting; cancellation of a running Job attempts to terminate the observed process identity.

A cancellation request is not proof that the process stopped. If termination could not be delivered or the process identity is uncertain, inspect the Job again. An already committed file change or an external effect of the command is not undone by cancellation.

The Runner saves terminal Job metadata before publishing a final result. A nonzero exit retains its exit code. If terminal metadata cannot be saved, the result remains uncertain until recovery can establish and persist the outcome; it is not reported as a successful exit. A Runner restart cannot reconstruct an exit code it never observed. Recovered processes may therefore remain `unknown`, and unstarted queued Jobs are marked interrupted rather than automatically launched.

Persisting a receipt and starting an operating-system process are separate operations. For an uncertain launch result, query the original `job_id` and `workspace_id`; do not launch a second command merely to obtain a receipt. See [MCP call recovery](mcp-agent-call-contract.md).

## Reading logs

Log queries read bounded pages and do not start, cancel or modify the Job. Empty output differs from unavailable output. `log_unavailable` can mean the file was not created, was removed, or cannot be safely read; it does not prove that the Job never ran.

If inline stdout/stderr retrieval fails after a command ends, preserve its actual Job identity, status and exit code. Retry only the log query. See [byte pagination](byte-pagination.md) for incomplete UTF-8 tails and [bound cursors](bound-cursors.md) for snapshot/append consistency.

## Context checkpoints and recovery

A checkpoint writes an intent, an immutable revision, the derived index, and then clears its intent. An interruption can leave a pending checkpoint. Ordinary reads do not silently repair or write missing state. Use the explicit `context` rebuild action when recovery is required; it validates existing records rather than rewriting their contents.

Rebuild is bounded and may refuse corrupt, unsafe or oversized state. Preserve that state for operator inspection instead of deleting unknown files. Rebuild cannot restore revisions already removed by retention.

## Removing old Context revisions

Prune requires a preview followed by an explicit apply using the returned plan hash. The Runner checks the selected revisions, latest retained revisions, file identities and current permissions before deletion. A plan hash does not replace authorization.

Deletion proceeds one revision at a time. If it stops partway through, already deleted revisions are not rolled back. On `context_prune_partial`, inspect storage and request a fresh preview before another apply. The latest revision and index are retained. Removal is ordinary file deletion; it does not erase backups or securely wipe storage media. See [Context storage and retention](context-storage.md).

## Host and storage assumptions

Use one Runner owner for a state directory and keep that directory private. In-process serialization coordinates operations within that Runner; it is not a lock shared with independent processes or protection against a hostile host administrator. Workspace shell execution uses the Runner's OS identity and is not an operating-system sandbox.

Job metadata and logs have count/byte limits, and optional day-based retention can remove terminal data. Cloud history is a bounded recent snapshot, not a complete backup. Keep independent backups for data you must preserve. See [Job history and retention](batched-job-history.md) and the [security model](security.md).

For source-level module responsibilities, see [modular architecture](architecture-remediation.md).
