# Context storage and retention

Use `context` to inspect workspace Context usage and preview removal of old revisions. These actions are implemented in the **0.1.4 candidate** and require a compatible Worker and Runner. The published v0.1.3 Runner does not support them; updating the Worker does not upgrade an installed Runner.

## Workspace storage limits

Checkpoints that would exceed a storage limit are refused. Existing Context entries are not evicted to make room, and index rebuild refuses to publish an incomplete index when the Context count exceeds its limit.

Each workspace defaults to **32 MiB of logical revision-file bytes**, **4,096 revision files**, and **256 context directories**. The existing index has a separate 2 MiB bound; checkpoint intent and temporary index files add bounded overhead. These are not filesystem allocated blocks, disk-free guarantees, or a global per-host quota. Multiple workspaces and other Runner data remain separate. An embedded ContextStore may lower these limits, not raise or disable them. No new deployment variable or dependency is required.

Admission scans bounded metadata before recording a new intent. An unchanged retry returns its existing receipt first, so a full store does not break a valid deduplicated retry. Existing over-limit data is not automatically removed or rewritten; reading the latest record remains possible. Externally created/unrecognized files, links and unsafe directories stop inventory/admission rather than being ignored or deleted.

## Read-only inventory

Call `context` with `action=storage` and `workspace_id`. It requires current `coding:read` and workspace read permission. The response reports record count/bytes, context count, separate metadata bytes, effective limits, over-limit status and pending-checkpoint presence. It contains no local paths, record bodies or environment values.

Inventory walks at most two context levels, with limits of 16,384 entries, 8,192 records and 1,024 directories. It checks a four-second budget between scan steps; this cannot interrupt an individual operating-system I/O call. These higher inspection limits allow some over-quota existing stores to be diagnosed. Exhaustion returns `context_scan_budget` instead of partial totals. Only metadata is read; bootstrap/read/search retain their targeted reads. No read operation creates a directory or updates the index. Normal filesystem access-time updates are outside the API's no-write guarantee.

## Explicit retention

Call the existing `context` tool:

```json
{"action":"prune","workspace_id":"workspace","keep_days":30,"keep_revisions":2}
```

This is **preview only**. Both preview and application require current `coding:write` plus workspace edit permission. A revision is eligible only when it is older than `keep_days` according to its stored `updated_at_ms` **and** is outside the newest `keep_revisions` existing revisions of its context. The latest record of every context is always kept. The settings apply to this explicit request; they are not a saved automatic retention policy.

The preview returns a plan hash, eligible/candidate counts and bytes, preserved-context count and inspection totals. Candidate records are validated against their immutable fingerprints and filenames; current index entries must match the latest record. Corrupt or unresolved checkpoint state blocks retention. No preview is implicitly applied, and no record text is returned in the plan.

After reviewing the preview, send the same options with `apply=true` and `expected_plan_hash` equal to the returned hash. At most 128 revisions may be removed in one application; `max_delete` may lower that bound. `has_more` reports additional eligible records; each further batch needs a fresh preview and explicit application. There are no automatic loops, background scans or periodic deletions.

The plan binds workspace, local policy generation, options, inventory identities and selected content hashes. Apply recomputes it. Files changing or a new checkpoint arriving invalidates it. Retention rechecks the selected revision, protected latest revision, directory chain and current authorization before each unlink. A plan hash is not authorization and does not make an OS filesystem race atomic.

## Interrupted deletion

Retention never edits the index or the latest record. Individual old revisions are removed independently, not as a multi-file transaction. If deletion fails or authorization changes after earlier deletions, `context_prune_partial` reports an uncertain/partial outcome. The operator must inspect storage and review a new plan, not assume rollback or replay the old plan automatically. Process termination after one unlink leaves a readable current index; rebuilding cannot restore deleted files.

This relies on the existing single-Runner owner model and private state directories. It does not provide cross-process coordination against another independent writer or protection against a hostile administrator racing native filesystem syscalls. Removal is ordinary file unlinking, not secure media erasure; backups, snapshots and old installation copies are not purged.

## Permissions, privacy and compatibility

Inventory rechecks the policy generation after reading. Prune checks current policy/permission before every mutation and binds that generation into the preview. Read-only users cannot perform retention even by constructing calls manually.

Worker input schemas require explicit bounded settings and confirm/apply agreement. Output reports are whitelist-projected and checked for inconsistent totals, false completion and wrong workspace/operation bindings. Invalid mutation receipts remain unknown; they are not treated as success, empty storage or rollback. Secrets and local paths in underlying errors are not forwarded.

Context calls retain metadata auditing; disabling Job recording does not disable Context auditing. Stored records stay on the Runner, and storage/prune responses contain no record text. Reading a Context can return its text to the authorized client.

Stored v1/v2 records and the v1 index remain compatible. Before forwarding `context.storage` or `context.prune`, the Worker checks whether the current Runner connection advertises that exact method. Missing support returns `runner_upgrade_required` with `operation_state=not_started`; it does not send the unsupported method or disconnect an otherwise usable old Runner. Upgrade using a verified Runner release that contains these capabilities, then reconnect. A version label alone does not establish support.

## Limits of retention

Prune does **not** delete entire Contexts or their latest revision, save automatic retention settings, impose a global disk quota, migrate unknown formats, or remove third-party backups. Pruning only frees revision-count and byte budgets. If you reach the Context-count limit, this action cannot free a Context slot; preserve the data and plan a separate operator-managed archival or removal procedure.
