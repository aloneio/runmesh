# Optimization implementation ledger

## AR08 — layered verification and source facts (2026-09-15)

This development change inventories every existing test without dropping legacy regressions, adds public-domain and native file-adapter contract lanes, validates registered examples against real tool/action schemas, and requires actual installed-package E2E in both Linux verification jobs. Machine reports bind the checkout, archive bytes and actual runtime while recording signing, production, account quotas and host catalog as not_run. See [verification layers](verification.md), [Chinese guide](verification.zh-CN.md), [generated source facts](current-facts.md) and [validated examples](tool-examples.md). This is verification infrastructure, not a production upgrade or proof of complete coverage. Native and per-SHA test outcomes must be taken from the matching execution report.

This ledger tracks changes made from the 2026-09-11 optimization plan. It records behavior adopted from upstream references without copying their implementation.

## R01 / R09 — build source provenance (2026-09-15)

Development implementation, not production acceptance. An ignored generated Worker module records a verified clean Git commit/tree and a main/dev branch only when observed. Provider tags are checked for agreement instead of being the only source. Dirty/unavailable/conflicting builds remain explicit; strict deployment rejects them before upload. Health is no-store and exposes bounded safe version metadata without database I/O. A one-request HTTPS observer requires the exact expected source. See [build provenance](build-provenance.md) and [中文说明](build-provenance.zh-CN.md). This is self-reported source identity, not a signed artifact attestation, host-catalog refresh or account usage measurement.

## R08 / P13 — Context storage and explicit superseded-revision retention (2026-09-15)

Development slice only: logical on-disk revision bytes/counts now gate new checkpoints; the index no longer silently evicts an older context. Existing full-store receipts remain deduplicated. Read-only metadata inventory and reviewed, hash-bound pruning of old superseded revisions use two actions within the existing Context tool. Latest records and index remain unchanged; partial unlink batches require fresh inspection, not assumed rollback. See [storage budgets](context-storage.md) and [Chinese explanation](context-storage.zh-CN.md). Whole-context deletion, saved automatic policy, host-global quotas, unknown-state migration and production activation remain open. The current catalog contains 27 protected methods and 26 Runner-backed actions; earlier counts below are historical.

## R07 / P09 — opt-in file snapshots and log generation cursors (2026-09-15)

Development slice following `6e1b0bb`: opt-in process-local file content snapshots and append-log generation cursors, bounded caches and fixed expiry, per-page authorization, strict resource-aware output checks and explicit legacy-peer rejection. Numeric live pages remain compatible. Full-log tamper attestation, production acceptance and all-tool pagination are not implied. See [bound cursors](bound-cursors.md) and [Chinese explanation](bound-cursors.zh-CN.md) for limits and compatibility.

## R07 / P09 — byte-page correctness and output availability (2026-09-15)

Development slice only: files/logs share additive byte metadata, incomplete UTF-8 tails stop non-advancing pagination without losing a later append, unavailable logs are distinct from empty logs, and inline log failures preserve actual Job exits. File reads recheck sampled metadata; short reads and serialized response budgets are bounded. The read catalog now describes optional typed page fields. Existing numeric cursors remain non-snapshot cursors; cross-page binding, full output schemas and other tools' pagination remain open. See [byte pagination](byte-pagination.md) and [Chinese explanation](byte-pagination.zh-CN.md). No production or released Runner update is implied.

## R01 / R07 — capability and operation-contract alignment (2026-09-15)

Development implementation slice, not production acceptance: the 25 protected RPC operations share one immutable definition across wire method validation, Registry requirements, Runner advertisement and read-completion generation checks. Twenty-four Runner action bindings and a canonical catalog fingerprint are shared with on-demand diagnostics. The public surface remains 10 tools. Missing old-peer reports are unknown; neither implementation claims nor directory metadata authorize execution.

Tests cover real tools/list schema comparison, malformed/absent reports, independent scopes, post-read revocation and no extra persistence. See [capability contracts](capability-contracts.md) and [Chinese explanation](capability-contracts.zh-CN.md). Production provenance, host-side refresh, complete output schemas, capability switches and pagination remain open. Older implemented labels below do not establish five-layer completion.

> Status correction (2026-09-15): the dated entries below are historical implementation notes, not complete acceptance. The optimization review found concrete R02/R03/R04/R05 counterexamples despite earlier CI success. See [first correctness repair slice](review-correctness-20260915.md) for the regression-backed corrections, record compatibility, installed-version limits and remaining R01/R06 verification. Current source changes are not automatically present in an older signed Runner archive.

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

Status: implementation completed on 2026-09-13 for the planned local Context scope; release validation pending.

- Checkpoints distinguish caller `claimed` evidence from Runner-observed Job evidence. Job evidence is resolved by the Runner, must belong to the same workspace, and records observed status/exit information at checkpoint time.
- `review_state` is `incomplete` while checks remain, `evidence_backed` only when observed evidence is present, and otherwise `claimed`; a single exit code is never promoted to proof that the whole requirement is complete.
- Checkpoint replaces a caller-provided Git claim with the Runner-observed isolated `HEAD` when safe Git inspection is available and marks that baseline `observed`. Read/bootstrap compare the stored observed baseline with current `HEAD` and return `baseline_state=current|stale|unknown`, so evidence cannot keep presenting itself as current after the source baseline changes.
- The v1 record fingerprint remains compatible with records written before `base_commit_status=observed`; observation status is an additive annotation rather than a silent v1 integrity-algorithm migration.

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


## AR06 — Registry domain extraction (development)

Based on `ca511cf0fa9411b85a52ba78547aeab7e4b27dec`: Auth, Policy, Runner Lifecycle and local History now own their existing operations behind a stable Registry facade. Narrow typed ports and one native synchronous SQL/transaction adapter replace access to the whole Registry object. Existing HTTP routing, schema bootstrap, maintenance and external-D1 coordination remain in the facade. No namespace, table, wire catalog, runtime variable, Runner package or production deployment changes.

Forty baseline characterization scenarios compare exact ordered SQL/argument hashes, native transaction events, rows read/written and receipts. Cross-domain policy-write failure rolls back Runner creation and its ledgers. Separate construction/adapter tests and architecture guards cover no-I/O construction and forbidden concrete dependencies. These local equivalence checks do not constitute production load or account-quota acceptance. See [Registry domains](registry-domains.md) and [中文说明](registry-domains.zh-CN.md). Remaining HTTP/schema/maintenance extraction and finer data ownership are independent future refactors, not silently included in this entry.

## AR07 Job/Context side-effect boundaries

Development implementation based on `a9b9bb5ef1e7275285c4ccfa54db0c685a03c23e`: native Job storage/process ports, bounded log reader, Context record/file/recovery boundaries and pure retention planning. The ordered Job state owner and checkpoint serialization remain. Public signatures, persisted formats, limits and existing timer sites are unchanged. See [Runner boundaries](runner-boundaries.md) and [中文说明](runner-boundaries.zh-CN.md). Source, packaged Runner, hosted CI and production are separate verification levels; this entry is not production activation.

## Job reporting audit follow-up (development source)

- Base `ab3ad6d66fc54792e3a4c77e4e1a298d16612358`: negotiated source-side capture hints, immutable opt-out across retries/recovery, one-shot dirty-history scheduling, receipt-generation fencing and cached retry payloads.
- Empty/fully filtered batches skip D1; current cloud preference/time-window filtering remains authoritative. Read-only log calls do not start reporting. Heartbeat timing, execution authorization and local logs are preserved.
- Verification includes native local Jobs, actual loopback frames, final Worker bridge decisions, queue-time restriction, restart/idle/immediate-mode races and source/installed-package E2E. Execution evidence lives in the corresponding CI and delivery report; this entry does not assert production activation.
- Compatibility and residual legacy/recovered-process behavior: `docs/demand-job-history.md` and `docs/demand-job-history.zh-CN.md`.
