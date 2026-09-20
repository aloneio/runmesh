# Use file snapshots and append-log cursors

Choose `consistency:"snapshot"` to read file pages from one captured buffer, or `consistency:"append"` to follow a Job log across explicit reads. These modes are available in **0.1.4** and require a compatible Worker and Runner. Ordinary numeric-cursor reads remain the default.

## Read a file snapshot

```json
{"workspace_id":"workspace","path":"src/example.ts","consistency":"snapshot","limit":4096}
```

The Runner captures a file of up to **1 MiB** into an immutable process-local buffer and returns its SHA-256 as `snapshot_id`. Continue with the opaque `next_cursor` exactly as returned. Successful pages use that same buffer.

Every continuation checks current permission, workspace/root identity, the resolved path, OS access and the file's identity, size and change metadata. A detected modification or replacement returns `file_changed`. The cursor also binds the reader instance and policy generation.

`snapshot_id` identifies the captured bytes. An external writer can race the initial capture because filesystem reads are not an atomic OS snapshot. Protect the host and source file when stronger guarantees are required. Files larger than 1 MiB return `snapshot_too_large`; deliberately start a new `live` read if ordinary page consistency is sufficient.

## Follow an append-only log

```json
{"action":"logs","workspace_id":"workspace","job_id":"job-example","stream":"stdout","consistency":"append","limit":4096}
```

The cursor binds the Runner-local Job manager, Job, workspace, stream, policy generation and observed file generation. Normal append remains valid. Here `snapshot_id` is a generation identifier, rather than a hash of the entire log.

Checks cover file replacement, observed shrinking, same-size metadata changes, and SHA-256 anchors of the first 256 bytes and up to 256 bytes at the previous observed boundary. This detects ordinary rotation and common copy-truncate-and-regrow behavior with bounded reads.

Use this mode with Runner-managed append-only logs. External writers can modify unsampled interior bytes or restore checked bytes between observations; host access controls are required to protect against such tampering.

At the observed end, `next_cursor` is null and `resume_cursor` preserves the generation and position for a later explicit refresh. An incomplete UTF-8 character retains its starting offset so later appended bytes can complete it.

## Continue or recover a read

Bound results use `page_protocol:2`, `consistency`, `snapshot_id`, `resume_cursor` and `cursor_expires_at_ms`, alongside byte counts and page state. The Worker validates these fields and their resource bindings.

Use each cursor for its original resource and consistency mode. Bound continuations exclude explicit `offset`, `tail:true` and `consistency:live`. Start a new snapshot/append read with no cursor, then use its returned opaque cursor.

| Result | Next step |
| --- | --- |
| `cursor_expired` | Start a fresh read; the entry expired, was evicted or belonged to a previous Runner process |
| `cursor_mismatch` | Check the resource, stream, workspace and policy; create a new read with matching parameters |
| `file_changed` or log rotation | Start a fresh read of the current source |
| `runner_upgrade_required` | Install a compatible verified Runner release; the reply lacked the requested bound-page evidence |

These failures concern reading an existing resource. For Job logs, retain the original Job ID; recovering a cursor does not require re-executing its command.

## Resource limits

| Resource | Limit |
| --- | --- |
| File cache | 16 entries and 8 MiB retained content per process |
| Initial captures | Four concurrent buffers, each at most 1 MiB; 64 reads and a two-second deadline checked between I/O completions |
| Log cache | 256 entries and 256 KiB accounted metadata, with no additional stored log bodies |
| Extra log checks | At most 2 KiB anchor reads per continuation, plus the existing page and UTF-8 probe |
| Cursor lifetime | Five minutes from creation; access keeps the original expiry |

The capture deadline is cooperative: an individual OS call may take longer. In-flight buffers, objects and serialization use memory in addition to the retained-content budget. Caches clean up lazily on access and are discarded on Runner exit; expired entries can remain allocated until cleanup while staying within the cache bounds.

Page metadata counts toward the response budget. File reads retain metadata auditing; Job recording preferences apply to their optional history and `exec.*`/`job.*` audit entries. See [history settings](batched-job-history.md).

Deploy a compatible Worker, install the verified Runner release, then refresh the affected MCP connector if its input schema is stale. See [capability diagnostics](capability-contracts.md).
