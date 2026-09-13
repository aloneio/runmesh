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
- Search output reports column/match/context, engine, scan counters and a specific truncation reason. The existing numeric `next_cursor` stays compatible; `next_snapshot_cursor` is an opt-in snapshot-bound cursor that fails with `search_snapshot_changed` if the bounded result snapshot changes.
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

- Search now emits `snapshot_id`, the compatible numeric `next_cursor`, opt-in `next_snapshot_cursor`, `truncated`, `truncated_reason`, `returned_bytes` and explicit scan budgets; UTF-8-safe MCP projection remains bounded.
- Existing file and Job pagination keep their stable numeric cursor contracts; this change deliberately does not force an incompatible cursor format onto those append/offset resources.
- Cross-tool follow-up remains to migrate shared field generation into protocol helpers without changing existing response shapes.

## P10 — Job launch receipt and bounded deduplication

Status: implemented on 2026-09-13.

- `shell` accepts an optional bounded `request_id`; the Runner binds it locally to the current principal, workspace and normalized launch input with a SHA-256 fingerprint.
- A repeated `request_id` with identical input returns the original persisted `job_id`, even when the normal concurrency slot is occupied; conflicting reuse fails with `request_id_conflict`.
- The receipt is persisted with Job metadata and survives Runner recovery. Authorization and policy generation are still checked before a receipt is reused, so an old key never becomes an authorization cache.
- Cancellation and stdin input are deliberately outside this retry path, and the implementation does not claim exactly-once process creation across every host crash boundary.
- Verification: `apps/runner/test/runtime.test.ts` covers identical retry, conflict rejection and the existing admission/cancellation behavior.

## P02 — layered diagnostics and permission explanation

Status: implemented on 2026-09-13.

- `inspect action=diagnostics` returns one bounded, timestamped view of MCP revalidation, sticky Runner state, the real effective workspace permission intersection, desired/applied/reported policy revisions, and a live no-side-effect `env.info` RPC probe.
- Checks use `pass|fail|unknown` plus stable codes and evidence sources. Offline, unavailable Registry state, and stale policy remain distinguishable instead of being collapsed into a generic authentication failure.
- The probe never runs shell commands, changes policy, creates a Job, or returns workspace roots, credentials, environment values, or raw control-plane errors.

## P04 — single-source MCP tool catalog

Status: implemented on 2026-09-13.

- Public tool name, scope, description, annotations and input Schema now live together in `apps/worker/src/mcp/catalog.ts`; registration consumes the Schema from the same `ToolSpec` instead of accepting a second parallel Schema argument.
- `mcp-catalog.test.ts` freezes the stable public tool surface and verifies strict/action-specific parsing so duplicate or drifting contract definitions fail CI.

## P05 — capability extraction from the Worker MCP module

Status: first safe structural slice implemented on 2026-09-13.

- Tool catalog/Schema/annotation concerns moved out of `mcp/server.ts` into a dedicated module without changing public tool names or authorization order.
- The extraction deliberately leaves stateful authorization and final-send sequencing in the existing server until each domain has equivalent regression coverage; this follows the plan's incremental refactor boundary instead of mixing a large file rewrite with feature changes.

## P15 — MCP call / Job result correlation

Status: implemented on 2026-09-13.

- Runner-backed tool results now include a safe `correlation_id` tied to the metadata-only MCP audit record and, where applicable, its `job_id`.
- Results separately report `audit_status=recorded|degraded|unknown`. Registry audit storage failure or temporary audit disablement does not rewrite the execution result, masquerade as authentication failure, or cause an operation to be sent again.
- Audit persistence remains metadata-only and retains the existing bounded retention/pruning policy.

## P19 — least-privilege workspace presets

Status: implemented on 2026-09-13.

- The administrator UI now distinguishes `Read Only`, `Workspace Edit`, and `Controlled Execution`: edit-only grants read/edit without Host shell or Job control; controlled execution explicitly enables the full workspace execution set.
- The old `coding` form value remains accepted as a compatibility alias for controlled execution, while the rendered form uses the clearer least-privilege profiles.
- Presets only populate the existing permission model; the Runner continues to enforce the live permission intersection and cannot gain authority from a UI label.

## P11 — optional workspace context handoff

Status: implementation slice completed on 2026-09-13; release validation pending.

- Added a local Runner `ContextStore` with read-only `bootstrap`, targeted `read`, bounded `search`, explicit `checkpoint`, and explicit `rebuild` operations.
- Read-only bootstrap does not create directories, indexes, records, or Jobs. Context bodies remain Runner-local and workspace-bound; raw chat, system prompts, hidden reasoning, host roots, environment values, and credentials are not captured by the API.
- MCP exposes context as one optional mixed tool. Read actions require `coding:read`; checkpoint/rebuild require `coding:write` and the live workspace edit permission.

## P12 — checkpoint deduplication and cross-record protection

Status: implementation slice completed on 2026-09-13; release validation pending.

- Checkpoints use a server-side `context_id`, caller-supplied bounded `turn_id`, optional `expected_revision`, immutable revision files, and a content fingerprint for retry deduplication.
- A context cannot be continued under a different `turn_id`; stale revisions fail with a structured conflict instead of overwriting another writer.
- The derived index is replaceable and rebuildable; immutable record files are not rewritten during index repair.

## P13 — bounded local context search

Status: implementation slice completed on 2026-09-13; release validation pending.

- Search operates on a bounded derived local index instead of opening every context body for each query. Results contain only handoff metadata and references; full records are fetched by targeted read.
- Index rebuild has explicit file and byte budgets and rejects unsafe/symlinked state paths. Missing indexes are reported as missing rather than being silently created by a read.
- External embeddings and cross-workspace global memory are not introduced.

## P14 — evidence-aware handoff state

Status: first implementation slice completed on 2026-09-13; baseline-staleness automation remains follow-up work.

- Checkpoints distinguish caller `claimed` evidence from Runner-observed Job evidence. Job evidence is resolved by the Runner, must belong to the same workspace, and records observed status/exit information at checkpoint time.
- `review_state` is `incomplete` while checks remain, `evidence_backed` only when observed evidence is present, and otherwise `claimed`; a single exit code is never promoted to proof that the whole requirement is complete.
- Automatic comparison of a stored `base_commit` against the current repository HEAD is intentionally not yet marked complete and remains part of the P14 follow-up.

## P27 — shareable diagnostics allow-list

Status: first implementation slice completed on 2026-09-13; optional system-keyring backends remain a separate evaluation.

- `runmesh doctor --shareable` projects the existing diagnostic result through a strict allow-list instead of trying to redact an arbitrary full report after the fact.
- The shareable form contains the Runner version, timestamp, aggregate configuration state, stable check names/statuses, and service mode/privilege state. It deliberately omits service manifest paths, profile fields, server URLs, tokens, environment values, native service identity, check details, and workspace identifiers.
- Workspace-specific doctor checks are collapsed to the generic `workspace` check name so a support paste does not disclose stable workspace IDs.

## P22 — CI parity gate

Status: parity gate implemented on 2026-09-13; fault-injection coverage remains an ongoing per-feature requirement.

- Added `check:ci-parity`, which fails when either GitHub or GitLab drops one of the shared release-relevant checks such as typechecking, unit/E2E tests, release validation, license checks, Worker dry-runs, or package smoke tests.
- The parity check also verifies pull/merge-request coverage and the `dev` push gate. GitHub retains its additional native Linux/macOS/Windows and supported-Node matrix; the check does not pretend GitLab currently has equivalent native runners.
- Both hosted CI definitions execute the parity gate themselves, making future one-sided CI edits fail before release evidence can be treated as equivalent.

## P16 — on-demand operations timeline

Status: existing implementation verified on 2026-09-13.

- The administrator Job detail view reads saved Registry metadata on page load and does not contact the Runner for log bodies until an operator explicitly selects stdout or stderr.
- Log reads remain bounded to 16 KiB, pagination is explicit, offline/stale/revoked Runners retain saved metadata, and the page states that there is no automatic polling.
- `apps/worker/test/admin-jobs.test.ts` verifies no implicit log fetch, one bounded selected-stream read, escaped log output, and metadata preservation during live-log failures; the targeted suite passed 20/20 on the oci0 implementation host.

## P20 — versioned runbook catalog

Status: first read-only documentation slice implemented on 2026-09-13.

- Added a bounded versioned catalog for connection recovery, permission-denial investigation, and release preflight. Runbooks state applicability, required permissions, procedure, and explicit exit conditions; they are documentation only and do not execute commands automatically.
- `check:runbooks` validates catalog IDs, versions, bounded sizes, safe relative file names, and required document sections in both hosted CI systems.
- Importable packages, remote Skills, background installation, and any execution engine remain intentionally out of scope for this slice.
