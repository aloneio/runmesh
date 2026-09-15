# Context storage budgets and reviewed retention

Development slice of **R08 / original P13**, based on `036af27aaec40f0bc879578af57e5191626a87c3`. This is source implementation and isolated verification, not a production deployment or replacement for immutable v0.1.3.

## Storage is not the index

The former 256-entry index cap did not bound stored revision files: older revisions remained, and adding another context could silently hide an older context from the index. New checkpoints now refuse admission rather than evicting index entries. Rebuild also refuses to publish an incomplete index when more than 256 distinct contexts would be hidden.

Each workspace defaults to **32 MiB of logical revision-file bytes**, **4,096 revision files**, and **256 context directories**. The existing index has a separate 2 MiB bound; checkpoint intent and temporary index files add bounded overhead. These are not filesystem allocated blocks, disk-free guarantees, or a global per-host quota. Multiple workspaces and other Runner data remain separate. An embedded ContextStore may lower these limits, not raise or disable them. No new deployment variable or dependency is required.

Admission scans bounded metadata before recording a new intent. An unchanged retry returns its existing receipt first, so a full store does not break a valid deduplicated retry. Existing over-limit data is not automatically removed or rewritten; reading the latest record remains possible. Externally created/unrecognized files, links and unsafe directories stop inventory/admission rather than being ignored or deleted.

## Read-only inventory

Call `context` with `action=storage` and `workspace_id`. It requires current `coding:read` and workspace read permission. The response reports record count/bytes, context count, separate metadata bytes, effective limits, over-limit status and pending-checkpoint presence. It contains no local paths, record bodies or environment values.

Inventory walks at most two context levels, with hard limits of 16,384 entries, 8,192 records, 1,024 directories and a checked four-second scan budget. These higher inspection limits allow some over-quota existing stores to be diagnosed. Exhaustion is `context_scan_budget`, not a complete-looking partial total. Only metadata is read; bootstrap/read/search retain their existing targeted reads. No read operation creates a directory or updates the index. Normal filesystem atime behavior is outside the API's no-write guarantee.

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

## Safety, audit and compatibility

The two new protected RPCs (`context.storage`, `context.prune`) share the authoritative operation table. Public tool count stays 10; the protected RPC table is now 27 and the Runner-backed action map 26. Inventory rechecks the policy generation after reading. Prune checks current policy/permission before every mutation and binds that generation into the preview. Read-only users cannot perform retention even by constructing calls manually.

Worker input schemas require explicit bounded settings and confirm/apply agreement. Output reports are whitelist-projected and checked for inconsistent totals, false completion and wrong workspace/operation bindings. Invalid mutation receipts remain unknown; they are not treated as success, empty storage or rollback. Secrets and local paths in underlying errors are not forwarded.

Calls use the existing RPC and metadata audit path. No extra diagnostic RPC, storage binding, schedule, heartbeat or permanent timer is added. Context calls retain normal metadata auditing; disabling Job recording does not mean all Context calls become audit-free. Record text stays local.

Stored v1/v2 records and the v1 index remain unchanged. Old Runners do not support the new methods; a compatible Worker must report unsupported methods, not simulate an empty inventory. New limits and retention are not retroactively present in an already published v0.1.3 archive. A future separately verified release is needed for installed users.

## Remaining R08 work

This slice does **not** delete entire contexts or the latest revision, persist automatic retention settings, impose a global disk quota, migrate unknown formats, or synchronize deletion into third-party backups. Reaching the context-count limit therefore requires a separately reviewed complete-context archival/deletion procedure; pruning older revisions only frees record-count and byte budgets. State-version evolution and deletion tombstones remain separate designs.

Verification includes admission and deduplication at capacity, UTF-8 byte accounting, stale plans, permission denial, links, unrecognized files, interrupted deletion in a real subprocess, rebuild after pruning, actual MCP calls and native-platform CI. Local tests do not establish production usage or Cloudflare billing results.
