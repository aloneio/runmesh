# Recover Job and Context operations

After an interruption, use the original Job or Context identifiers to inspect what happened. A transport timeout can occur after execution has started. This page describes the current candidate behavior; use the installed Runner's capabilities when diagnosing an older release.

## Check a Job outcome

The Runner checks current workspace policy before creating a process. Queued Jobs also need fresh control-plane authorization. Cancelling a waiting Job prevents its launch; cancelling a running Job attempts to terminate the verified process identity.

Check the returned Job state to confirm cancellation. When identity or signal delivery is uncertain, query the Job again. File changes and external effects produced before cancellation remain in place and may need separate recovery.

Final publication follows durable terminal metadata. A nonzero exit retains its exit code. A persistence failure leaves the result uncertain until recovery can establish and save the outcome. After a Runner restart, live recovered processes may be `unknown`, and unstarted queued Jobs are marked interrupted. Unobserved exit codes remain unavailable.

An uncertain launch should be followed with the original `job_id` and `workspace_id`. **Do not launch another command simply to obtain a receipt.** See [MCP call recovery](mcp-agent-call-contract.md).

## Retrieve logs

Log queries read bounded pages from an existing Job. `log_unavailable` can mean its log is awaiting creation, has been removed or cannot be safely read. An empty regular file produces a successful empty page.

If inline log retrieval fails after a command ends, keep its actual identity, status and exit code, then retry only the log query. See [byte pagination](byte-pagination.md) and [snapshot/append cursors](bound-cursors.md).

## Recover a Context checkpoint

A checkpoint saves an intent, an immutable revision and a derived index, then clears the intent. An interruption can leave a pending checkpoint. Use the explicit `context` rebuild action to validate existing records and reconstruct the index; ordinary reads leave this recovery decision to you.

Rebuild can reject corrupt, unsafe or oversized state. Preserve that state for operator inspection. Recovering deleted revisions requires a separate backup; index rebuild works only with revisions still present.

## Resume retention after partial deletion

Prune requires a preview followed by explicit apply with the returned plan hash. Before each deletion, the Runner checks authorization, file identities, selected revisions and the protected latest revision.

Deletion proceeds one revision at a time. On `context_prune_partial`, inspect storage and create a fresh preview; earlier deletions remain effective. The latest revision and index are retained. Manage backups and secure-erasure requirements separately from ordinary file deletion. See [Context storage and retention](context-storage.md).

## Prepare the host and backups

Keep each private state directory under one Runner owner. In-process coordination assumes independent programs and host administrators leave that state untouched. Shell commands use the Runner's OS identity; choose host permissions and VM/container isolation appropriate to those commands.

Job metadata/logs have count and byte limits, and optional day-based retention can remove terminal data. Cloud history is a bounded recent snapshot. Keep independent backups for anything you must preserve. See [history settings](batched-job-history.md) and the [security model](security.md).

Source-level module responsibilities are described in [modular architecture](architecture-remediation.md).
