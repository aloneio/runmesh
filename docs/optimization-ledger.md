# Optimization implementation ledger

This ledger tracks changes made from the 2026-09-11 optimization plan. It records behavior adopted from upstream references without copying their implementation.

## P01 — structured failure semantics

Status: implemented on 2026-09-13.

- Protocol: RpcErrorDetailsSchema accepts bounded failure_class, operation_state, retry_after_ms, and next_action fields.
- Runner: stable error-code mapping is centralized in apps/runner/src/errors.ts; RPC failures preserve unknown state when a side effect may have happened.
- Worker: MCP failures expose the same machine-readable fields while retaining bounded, redacted messages and details.
- Compatibility: all new fields are optional on the wire, so older peers continue to validate existing errors.
- Verification: apps/runner/test/error-semantics.test.ts; Runner and Worker TypeScript compilation.

## P25 — source and license traceability

The implementation uses behavior requirements and test ideas from the plan's fixed references. No source code from those repositories was copied.

| Reference | Fixed source | License | Use |
| --- | --- | --- | --- |
| AgentDock | uvwt/agentdock@5f1f85f2eea9cabd5d6246dd2e6043e52557ed18 | Apache-2.0 | Structured error categories and bounded output behavior |
| Coding Tools MCP | mybolide/coding-tools-mcp@d0b5313ec39ea108f35dcc0773a2c6ba6d147e28 | See upstream repository | Error/result separation and bounded pagination behavior |
| OneSSH | Lynricsy/OneSSH@c4939f02af072ea9d3d1b626d1c53b8ad29a92ae | GPL-3.0 | Failure observability and authorization explanation requirements; behavior reference only |

Runmesh implementation remains under the repository's PolyForm Noncommercial 1.0.0 license.

## P07 — read-only Git history inspection

Status: implemented on 2026-09-13.

- Runner exposes bounded `git.log`, `git.show`, and `git.blame` RPC methods using fixed read-only Git arguments, workspace path policy, UTF-8-safe output caps, and timeout/error classification.
- Worker `inspect` supports `git_log`, `git_show`, and `git_blame` with revision and line-range validation and redacted, bounded projections.
- Capability advertisement and authorization classify all history operations as `coding:read`.
- Verification: repository typecheck passes on Node 24; CI remains the release gate.

## P03 — Cloudflare cost baseline

Status: implemented on 2026-09-13.

- Added `docs/cost-baseline.md` defining provider-neutral counters, per-call derived rates, retention fields, and a seven-day release gate.
- The baseline records observed usage and Git SHA together, avoiding hard-coded provider prices or treating missing exports as zero.

## P06 — structured bounded code search

Status: implemented on 2026-09-13.

- `inspect search` keeps literal matching as the compatibility default and adds case sensitivity, include/exclude globs, bounded before/after context, and filename matching without granting shell access.
- The built-in traversal honors bounded nested `.gitignore` rules, including negation, while retaining the existing path-policy, descriptor and total I/O limits.
- Search output reports column/match/context, engine, scan counters, a specific truncation reason, and an opaque snapshot-bound continuation cursor. Legacy numeric cursors remain accepted; new cursors fail with `search_snapshot_changed` if the bounded result snapshot changes.
- Verification: `apps/runner/test/filesystem-security.test.ts` covers globs/context, nested ignore rules, filename mode and stale cursors.

## P08 — patch preview and review receipt

Status: implemented on 2026-09-13.

- `edit(preview=true)` runs the existing patch parser, path checks, expected hashes and staging calculation without creating temporary files or mutating the workspace.
- Preview returns bounded per-path diff excerpts and a SHA-256 `preview_id` bound to workspace, policy generation, patch and current baselines.
- Apply may include that `preview_id`; it recomputes authorization/baselines and rejects a stale review before creating temporary files. Normal apply remains compatible when no preview ID is supplied.
- Hunk conflicts include a bounded excerpt from the already-authorized target file and ambiguous candidate line numbers; no other file content or host path is exposed by MCP projection.
- Verification: `apps/runner/test/patch-git.test.ts` proves zero-write preview, reviewed apply, stale-preview rejection and bounded conflict context.

## P09 — pagination and resource-budget contract

Status: first compatibility slice implemented on 2026-09-13.

- Search now emits `snapshot_id`, opaque `next_cursor`, `truncated`, `truncated_reason`, `returned_bytes` and explicit scan budgets; UTF-8-safe MCP projection remains bounded.
- Existing file and Job pagination keep their stable numeric cursor contracts; this change deliberately does not force an incompatible cursor format onto those append/offset resources.
- Cross-tool follow-up remains to migrate shared field generation into protocol helpers without changing existing response shapes.
