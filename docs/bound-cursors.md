# Opt-in content snapshots and append-log cursors

Choose snapshot mode when successive file pages must come from one captured buffer, or append mode when following a Job log across explicit reads. These optional modes are implemented in the **0.1.4 candidate** and require a compatible Worker and Runner. The default numeric-cursor mode remains available.

## File snapshots

Start an authorized file read with `consistency: "snapshot"`. Files up to 1 MiB are read once into a bounded, process-local immutable buffer. Its SHA-256 is returned as `snapshot_id`. Every continuation uses the same bytes, not a new page read from a potentially different version. Pass the returned opaque `next_cursor` to continue; do not replace it with a numeric offset.

```json
{"workspace_id":"workspace","path":"src/example.ts","consistency":"snapshot","limit":4096}
```

The cursor binds the local reader instance, workspace, resolved path, workspace-root identity, policy generation and snapshot entry. Each continuation still resolves and opens the current path, checks OS access and path policy, and compares file identity, size and change metadata. Observable replacement or modification fails with `file_changed`. The cached buffer is not an authorization grant. Revocation still blocks reads.

Capture is not an operating-system atomic snapshot: an external writer can race a capture, and metadata cannot attest to every action of a privileged host process. The content hash identifies exactly the captured bytes; successfully continued pages remain from that one buffer. It is not a signed build or a guarantee about the current live file after the response.

Files larger than 1 MiB fail with `snapshot_too_large` before content capture. The caller can deliberately start fresh in `live` mode, which retains the existing bounded page reads but does not promise cross-page consistency. There is no automatic downgrade.

## Append-only logs

Use `job action=logs` with `consistency: "append"`. The opaque log cursor binds the Runner-local Job manager, Job, workspace, stream, current policy generation and a file-generation observation. Normal append does not invalidate it. The returned `snapshot_id` is an opaque generation identifier, **not a full-log content hash**.

```json
{"action":"logs","workspace_id":"workspace","job_id":"job-example","stream":"stdout","consistency":"append","limit":4096}
```

Generation checks cover file identity replacement, observed shrinking, same-size changed metadata, and SHA-256 anchors of the first 256 bytes and up to 256 bytes at the previously observed boundary. These anchors also detect common copy-truncate-and-regrow cases without hashing all prior output on every read. Concurrent reads keep a monotonic successful size observation.

**This assumes normal Runner append-only log writing.** A privileged/external writer can alter unsampled interior bytes while preserving the checked boundaries and growing the same inode. A truncation and regrowth that restores every checked byte before any observation cannot always be distinguished either. Use host access controls to protect logs; these cursors are not tamper attestation and do not start a watcher or periodic scan.

At the observed end, `next_cursor` is null. `resume_cursor` retains the generation and byte position for a later **explicit** refresh. A final incomplete UTF-8 character keeps its initial byte offset, so appending its missing bytes can complete it without dropping data. Expiry or rotation is an error, not an empty log; it never requires repeating the command that produced the Job.

## Version-2 page contract and compatibility

Bound results use `page_protocol: 2`, `consistency`, non-null `snapshot_id`, `resume_cursor` and `cursor_expires_at_ms`, alongside the existing page state and byte counts. The shared schema validates syntax; the Worker also checks cross-field consistency, resource echoes and continuation identity. It projects only known fields.

| Combination | Behavior |
| --- | --- |
| Ordinary read, no new options | Legacy numeric cursors and protocol 1 remain unchanged |
| New Worker, old Runner, explicit bound request | Reject missing bound-page evidence with `runner_upgrade_required`; never accept live output as a snapshot |
| Old Worker, new bound input | Old strict input schema may reject it; upgrade the compatible Worker first |
| New Worker and new Runner | Opt-in snapshot/append modes, without an extra negotiation RPC |

Bound file and log cursors cannot be interchanged. A bound cursor cannot be combined with `offset`, `tail=true` or `consistency=live`; new bound reads cannot start from a legacy numeric cursor. A valid-looking but expired, evicted or prior-process cursor returns `cursor_expired`. Wrong resource/policy or inconsistent peer output returns `cursor_mismatch`. Neither is an authentication failure.

## Resource and privacy budgets

File cache: at most 16 entries and 8 MiB of retained content per process. Initial capture has at most four concurrent buffers of at most 1 MiB, 64 read attempts, and a two-second deadline checked between local I/O completions. This is not a hard timeout of an individual OS syscall. Objects, page serialization and in-flight buffers use additional bounded memory; 8 MiB is not the entire process RSS.

Log cache: at most 256 entries and 256 KiB of accounted metadata (including scope strings), without stored log bodies. A bound continuation adds at most 2 KiB of anchor reads to its requested page plus the existing UTF-8 boundary probe. No whole-log scan is introduced.

Both caches expire five minutes after creation; hits do not extend the lifetime. Eviction and expiry are checked lazily on cache access, not by timers. Expired buffers may remain allocated until a later access or process exit, but cannot grow beyond the cache bounds. Runner restart discards all entries. No persistent cursor key, secret, database table, runtime variable, log upload, subscription or background refresh is added.

Files and log pages retain existing transport budgets. Cursor metadata counts toward the response size. File reads retain metadata auditing; the Job no-record preference continues to suppress that client's optional Job history and `exec.*`/`job.*` audit entries. Binding a cursor adds no separate audit entry or RPC. Authorization and transport requests still consume resources.

## Upgrading

Deploy a compatible Worker before installing a verified Runner release containing these modes. Refresh your MCP connector if its cached input schema rejects `consistency`. Updating the Worker or refreshing a connector does not upgrade the installed Runner. See [capability diagnostics](capability-contracts.md).
