# Byte pagination and output availability

Development slice of **R07 / original P09**, based on `daa7800c256c0143432f5ca105fdd07a3183d179`. This is not a production deployment or a replacement for the immutable v0.1.3 Runner.

This page describes the retained version-1/live behavior. The subsequent optional version-2 modes and their separate snapshot/generation guarantees are documented in [bound cursors](bound-cursors.md); ordinary numeric pages remain unchanged.

## Correctness changes

File and Job-log pages retain numeric byte cursors. An incomplete final UTF-8 code point no longer yields a non-advancing file cursor or consumes a log prefix that could become decodable after a later append. A final incomplete page returns no continuation cursor and explicitly reports the pending bytes. No polling is added.

File reads compare the opened object's identity, size and modification/change timestamps before publishing a page, with the existing path/policy checks intact. Log reads reject observed truncation, replacement and same-size mutation while permitting normal append beyond the observed window. Short OS reads are retried within the requested buffer and capped at 32 reads per buffer. An early zero read or an exhausted read budget is an error, not EOF invented from old stat data.

All log-open failures previously looked like successful empty logs. Missing, inaccessible, non-regular and other I/O failures now produce `log_unavailable` with a bounded local reason. Missing does not prove expiration; it can also mean never created or externally removed. A queued Job may not have a log yet. An actually empty regular file is still a successful empty page.

Inline stdout/stderr retrieval after `exec.run` is optional evidence. Its failure must not replace the real Job ID/status/exit code. Such a stream contains `available: false` and the stable `log_unavailable` code, with no raw exception or fabricated empty data. Direct `job logs` requests return the ordinary structured error. Neither case authorizes or recommends executing the command again.

## Additive page metadata

`packages/protocol/src/pagination.ts` is the shared source. The Worker accepts only complete, type-valid, internally consistent metadata and never copies arbitrary peer fields. The `read` output schema is now described by the catalog; fields remain optional for old peers and explicit transport truncation envelopes. Other tool outputs are not declared fully typed by this slice.

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

## Compatibility and remaining work

New Worker plus old Runner preserves legacy output and does not invent new metadata. New Runner plus old Worker retains core numeric pagination and Job status but the old projector may omit new page/availability fields. Deploy the compatible Worker before installing a future signed Runner containing this change. No released archive is overwritten.

Same-request metadata comparison is sampled observation, not an atomic filesystem transaction. There is no full-file content hash, retained filesystem snapshot or general cross-page generation guarantee. Numeric cursors can still cross revisions between separate calls, and are not bound to a Job stream/rotation generation. Full content-bound file cursors, append-safe generation-bound log cursors, all-tool output schemas and unified search/history pagination remain R07 work. Do not call this the completion of P09.

Regression sources: `apps/runner/test/byte-pagination.test.ts`, `packages/protocol/test/pagination.test.ts`, `apps/worker/test/byte-pagination.test.ts`, the no-record transport tests and real MCP end-to-end tests. They cover partial tails, later append, changed observations, unavailable versus empty logs, real nonzero exits, escaped JSON budgets, short reads, old peers and malformed metadata. Native platform CI and packaged Runner E2E remain independent gates.

Reference behavior: [Node filesystem API](https://nodejs.org/api/fs.html) and [Node Buffer UTF-8 decoding](https://nodejs.org/api/buffer.html). Filesystem reads are not transactional and Node can return fewer bytes than requested; the page layer must not equate those observations with a completed immutable snapshot.
