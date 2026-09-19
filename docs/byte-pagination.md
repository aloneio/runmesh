# Read file and log pages

File and Job-log reads return bounded pages. The **0.1.4 candidate** adds page-state and output-availability metadata; older Runners may return only the legacy fields. For pages tied to one captured file or log generation, use the optional [snapshot and append modes](bound-cursors.md).

## Continue a read

Ordinary reads use numeric byte cursors. Pass the returned `next_cursor` to request the next page. A cursor either advances or is null. If a page ends with an incomplete UTF-8 character, it reports the pending bytes and stops pagination. Once the source grows, explicitly refresh at `resume_offset` to complete that character.

The Runner checks file identity, size and modification/change timestamps during each read. Log reads allow normal append while detecting observed truncation, replacement and same-size mutation. A changed observation requires a fresh read. Numeric cursors describe byte positions, so separate calls can observe different file revisions; choose snapshot mode when cross-page consistency matters.

## Interpret page metadata

| Field | Meaning |
| --- | --- |
| `page_protocol` | `1` for the numeric byte-page contract |
| `page_state` | `more`, `end`, or `incomplete` |
| `returned_bytes` | UTF-8 byte length of returned `data` |
| `total_bytes` | Source size observed for this read |
| `resume_offset` | Source-byte position after the returned complete characters |
| `pending_bytes` | One to three trailing bytes awaiting completion on an incomplete page |
| `truncated_reason` | `page_limit`, `response_bytes`, `incomplete_utf8`, or null |
| `snapshot_id` | Null for numeric-cursor reads |
| `source_truncated` | Logs only: the Job-wide retained-output truncation flag |

Legacy `next_cursor`, `offset`, `size`, `truncated` and `data` remain available. For `page_state=incomplete`, a null `next_cursor` means the page loop should stop while trailing bytes remain pending. `source_truncated` applies to the Job as a whole; it gives no per-stream count of missing bytes.

Invalid UTF-8 inside a source uses Node's replacement decoding. Complete code points at page boundaries are preserved. The Worker validates metadata and returns allowed fields; treat missing optional fields as unavailable observations. See [MCP output contracts](mcp-output-contracts.md).

## Handle unavailable logs

`log_unavailable` covers missing, inaccessible, non-regular and other unreadable log files. A queued Job may still be waiting to create its log. An existing empty regular file returns a successful empty page.

If inline stdout/stderr retrieval fails after `shell` finishes, use the actual Job ID, status and exit code. The affected stream reports `available:false` with `log_unavailable`; retry its log query. Re-running the command would create new execution rather than recover the missing page.

## Read budgets and compatibility

MCP file pages request at most **32 KiB** of data; Job-log pages request at most **16 KiB**. Reads add up to three look-ahead bytes and a seven-byte alignment probe. Short OS reads are retried up to 32 times per buffer; an early zero read or exhausted budget returns an error.

Serialized file and log results fit within **48 KiB**, leaving room for Worker metadata. JSON escaping counts toward that response budget separately from `returned_bytes`. Authorization and metadata checks add their normal resource cost.

A current Worker accepts valid legacy results and preserves their available fields. Older Workers may omit richer page/availability metadata. Install compatible Worker and Runner versions before relying on those fields. The installed Runner's capabilities determine which consistency modes are available.
