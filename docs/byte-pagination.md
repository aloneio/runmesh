# Byte pagination and output availability

File and Job-log reads return bounded pages. This page describes the richer page and output-availability metadata implemented in the **0.1.4 candidate**. Older Runners may omit that metadata; deploying a Worker does not upgrade them.

This page describes the retained version-1/live behavior. The subsequent optional version-2 modes and their separate snapshot/generation guarantees are documented in [bound cursors](bound-cursors.md); ordinary numeric pages remain unchanged.

## Read a page and continue

File and Job-log pages use numeric byte cursors by default. Pass the returned `next_cursor` to read the next page. If the source ends with an incomplete UTF-8 character, the page reports the pending bytes and returns no continuation cursor. After more data arrives, explicitly refresh at `resume_offset`; no background polling is started.

File reads compare the opened object's identity, size and modification/change timestamps before publishing a page, with the existing path/policy checks intact. Log reads reject observed truncation, replacement and same-size mutation while permitting normal append beyond the observed window. Short OS reads are retried within the requested buffer and capped at 32 reads per buffer. An early zero read or an exhausted read budget is an error, not EOF invented from old stat data.

Missing, inaccessible, non-regular and other log-open failures produce `log_unavailable`. Missing does not prove expiration; it can also mean never created or externally removed. A queued Job may not have a log yet. An actually empty regular file is a successful empty page.

Inline stdout/stderr retrieval after `exec.run` is optional evidence. Its failure must not replace the real Job ID/status/exit code. Such a stream contains `available: false` and the stable `log_unavailable` code, with no raw exception or fabricated empty data. Direct `job logs` requests return the ordinary structured error. Neither case authorizes or recommends executing the command again.

## Additive page metadata

The Worker validates page metadata before returning it. These fields remain optional for older peers and explicit transport-truncation results. A missing field is not an observed zero or a guarantee that the full source was returned. See [MCP output contracts](mcp-output-contracts.md) for validation of other tool results.

| Field | Meaning |
| --- | --- |
| `page_protocol` | `1` for this additive byte-page contract |
| `page_state` | `more`, `end`, or `incomplete` |
| `returned_bytes` | UTF-8 byte length of the returned `data` string, not JS character count or escaped JSON length |
| `total_bytes` | Source size observed for this read; not the eventual total of a running Job |
| `resume_offset` | Source-byte position following the returned whole characters; usable for an explicit later refresh |
| `pending_bytes` | One to three trailing bytes not yet representable as a complete code point on an incomplete page |
| `truncated_reason` | `page_limit`, `response_bytes`, `incomplete_utf8`, or null |
| `snapshot_id` | Null: numeric cursors are deliberately not represented as content-bound snapshots |
| `source_truncated` | Logs only: existing Job-wide retained-output truncation flag, not a per-stream missing-byte count |

Legacy `next_cursor`, `offset`, `size`, `truncated`, and `data` remain. `next_cursor` always advances or is null. A null cursor with `page_state=incomplete` is not proof that every source byte was delivered. It stops a page loop; the caller may explicitly refresh at `resume_offset` after the source changes. Invalid UTF-8 inside a byte source still follows Node's existing replacement-decoding behavior; this change specifically avoids splitting valid code points and losing incomplete final sequences.

## Bounded resources

Normal MCP file pages remain capped at 32 KiB requested data, and Job log pages at 16 KiB. Files still read at most the requested page plus three look-ahead bytes and a seven-byte alignment probe. Job reads use the same bounded alignment/look-ahead approach. Each buffer tolerates at most 32 short-read attempts. No whole-file hashing, index scan, new persisted receipt, credential, cloud binding, required variable, heartbeat or timer is introduced.

Serialized Runner file results remain within 48 KiB. Log fitting now reserves the same 48 KiB envelope allowance rather than filling the entire 64 KiB ceiling and losing its cursor when MCP context/audit fields are added. The actual JSON envelope is measured separately from `returned_bytes`. Read calls do additional local metadata checks; that is not a claim of zero I/O or zero account cost. Existing authorization and transport retain their cost and final checks.

## Compatibility and consistency

New Worker plus old Runner preserves legacy output and does not invent new metadata. New Runner plus old Worker retains core numeric pagination and Job status but the old projector may omit new page/availability fields. Deploy the compatible Worker before installing a future signed Runner containing this change. No released archive is overwritten.

Same-request metadata comparison is sampled observation, not an atomic filesystem transaction. Numeric cursors can cross file revisions between separate calls and are not bound to a Job stream's rotation generation. If you need pages from the same captured file or a cursor bound to an append-only log generation, use the optional [snapshot and append modes](bound-cursors.md).

Reference behavior: [Node filesystem API](https://nodejs.org/api/fs.html) and [Node Buffer UTF-8 decoding](https://nodejs.org/api/buffer.html). Filesystem reads are not transactional and Node can return fewer bytes than requested; the page layer must not equate those observations with a completed immutable snapshot.
