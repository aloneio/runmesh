# Context storage and retention

Use `context` to inspect a workspace's Context usage and remove selected old revisions. The `storage` and `prune` actions are part of the **0.1.4 candidate** and require a compatible Worker and Runner. For an installed v0.1.3 Runner, upgrade to a verified release containing these actions before using them.

## Check usage

Call `context` with `action=storage` and `workspace_id`. This requires `coding:read` and workspace read permission. The response includes revision count/bytes, Context count, metadata bytes, limits, over-limit status and pending-checkpoint state. The inventory contains metadata only; Context text is available through the separate read action.

Each workspace defaults to **32 MiB of logical revision-file bytes**, **4,096 revision files** and **256 Context directories**. The index has a separate **2 MiB** limit, plus bounded intent/temporary-file overhead. Account for other workspaces, Runner data and filesystem allocation separately when sizing the host. Embedded ContextStore users can lower these limits.

A checkpoint that would exceed a limit is rejected and existing data is preserved. A valid duplicate request can still return its earlier receipt at capacity. Existing over-limit stores remain available for targeted reads; unknown files, links or unsafe directories require operator inspection before another write or inventory.

Inventory scans two levels, up to 16,384 entries, 8,192 revision files and 1,024 directories. It checks a four-second budget between I/O operations. Exceeding a limit returns `context_scan_budget`; a single OS I/O call can run beyond the checked deadline. Inventory and preview leave records and the index unchanged, apart from normal filesystem access-time updates.

## Preview retention

Both preview and application require `coding:write` and workspace edit permission. Start with:

```json
{"action":"prune","workspace_id":"workspace","keep_days":30,"keep_revisions":2}
```

A revision is eligible when its stored `updated_at_ms` is older than `keep_days` **and** it falls outside the newest `keep_revisions` existing revisions of that Context. The latest revision is always retained. Options apply to this request only.

The preview returns `plan_hash`, eligible/candidate counts and bytes, preserved Context count and inspection totals. It validates revision fingerprints, filenames and the index's latest-version references. Resolve corrupt or pending-checkpoint state before continuing.

## Apply the reviewed plan

Send the same options with `apply=true` and `expected_plan_hash` set to the preview's `plan_hash`. Each application removes at most 128 revisions; use `max_delete` for a smaller batch. When `has_more` is true, create and review a fresh preview for the next batch.

The plan binds the workspace, policy generation, options and observed files. Apply recalculates the plan and checks current authorization, file identities and the protected latest revision before each deletion. A changed file, new checkpoint or policy update requires a fresh preview.

Prune frees revision-count and byte capacity while retaining every Context and its latest revision. If the Context-count limit is reached, preserve the data and arrange a separate operator-managed archival/removal procedure.

## Recover from an interruption

Deletion proceeds one revision at a time. `context_prune_partial` means some selected files may already have been removed: inspect storage, then review a new plan. Already deleted revisions cannot be rolled back or restored by rebuilding the index. Backups and snapshots require their own retention procedures; this operation performs ordinary file deletion, not secure media erasure.

Use one Runner owner for a private state directory. Its in-process coordination assumes other processes and host administrators are not concurrently modifying that state.

## Compatibility and audit

The Worker checks the current authenticated connection for support of each requested `context.storage` or `context.prune` method. Missing support returns `runner_upgrade_required` with `operation_state=not_started`; the old connection remains usable. Install a verified compatible Runner and reconnect. Stored v1/v2 records and the v1 index remain compatible.

Context calls retain metadata auditing independently of the Job recording preference. Storage/prune responses contain usage and operation metadata. An invalid mutation receipt has an unknown outcome; inspect it before retrying. See [call recovery](mcp-agent-call-contract.md).
