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
