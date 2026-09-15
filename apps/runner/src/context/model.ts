import { createHash } from "node:crypto";
import { RpcRuntimeError } from "../errors.js";

/** Record validation and deterministic transformations; no filesystem or process access. */
export const CONTEXT_SCHEMA_VERSION = 2;

export const INDEX_SCHEMA_VERSION = 1;

export const MAX_RECORD_BYTES = 64 * 1024;

export const MAX_INDEX_BYTES = 2 * 1024 * 1024;

export const MAX_CONTEXTS = 256;

export const MAX_REBUILD_FILES = 4_096;

export const MAX_REBUILD_BYTES = 32 * 1024 * 1024;

export const MAX_REBUILD_ENTRIES = 8_192;

export const MAX_REBUILD_DURATION_MS = 4_000;

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const SAFE_COMMIT = /^[0-9a-fA-F]{7,64}$/u;

export type ContextEvidence = {
  readonly kind: "job" | "test" | "commit" | "note";
  readonly status: "claimed" | "observed";
  readonly job_id?: string;
  readonly job_status?: string;
  readonly exit_code?: number | null;
  readonly ref?: string;
  readonly summary?: string;
  readonly observed_at_ms?: number;
};

export type ContextRecord = {
  readonly schema_version: 1 | 2;
  readonly context_id: string;
  readonly workspace_id: string;
  readonly revision: number;
  readonly supersedes_revision: number | null;
  readonly turn_id: string;
  readonly fingerprint: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly policy_generation: number | null;
  readonly base_commit: string | null;
  readonly base_commit_status: "claimed" | "observed" | null;
  readonly base_worktree_state: "clean" | "dirty" | "unknown";
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly evidence: readonly ContextEvidence[];
  readonly open_risks: readonly string[];
  readonly missing_checks: readonly string[];
  readonly next_actions: readonly string[];
  readonly review_state: "incomplete" | "claimed" | "evidence_backed";
};

export type ContextIndexEntry = {
  readonly context_id: string;
  readonly revision: number;
  readonly turn_id: string;
  readonly fingerprint: string;
  readonly updated_at_ms: number;
  readonly base_commit: string | null;
  readonly goal: string;
  readonly review_state: ContextRecord["review_state"];
  readonly search_text: string;
};

export type ContextIndex = {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly rebuilt_at_ms: number | null;
  readonly records: readonly ContextIndexEntry[];
};

export type CheckpointIntent = {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly context_id: string;
  readonly revision: number;
  readonly fingerprint: string;
};

export type NormalizedCheckpoint = {
  readonly contextId: string | null;
  readonly turnId: string;
  readonly expectedRevision: number | null;
  readonly policyGeneration: number | null;
  readonly baseCommit: string | null;
  readonly baseCommitStatus: "claimed" | "observed" | null;
  readonly baseWorktreeState: "clean" | "dirty" | "unknown";
  readonly goal: string;
  readonly decisions: readonly string[];
  readonly evidence: readonly ContextEvidence[];
  readonly openRisks: readonly string[];
  readonly missingChecks: readonly string[];
  readonly nextActions: readonly string[];
};

export function normalizeCheckpoint(params: Record<string, unknown>, workspaceId: string): NormalizedCheckpoint {
  if (params.workspace_id !== workspaceId) throw new RpcRuntimeError("invalid_params", "workspace_id changed while normalizing checkpoint");
  const contextId = params.context_id === undefined ? null : safeId(params.context_id, "context_id");
  const turnId = safeId(params.turn_id, "turn_id");
  const expectedRevision = params.expected_revision === undefined ? null : boundedInteger(params.expected_revision, 0, Number.MAX_SAFE_INTEGER, "expected_revision");
  const policyGeneration = params.policy_generation === undefined ? null : boundedInteger(params.policy_generation, 0, Number.MAX_SAFE_INTEGER, "policy_generation");
  const baseCommit = params.base_commit === undefined || params.base_commit === null ? null : boundedString(params.base_commit, "base_commit", 7, 64);
  if (baseCommit !== null && !SAFE_COMMIT.test(baseCommit)) throw new RpcRuntimeError("invalid_params", "base_commit is invalid");
  const baseCommitStatus = baseCommit === null ? null : params.base_commit_status === "observed" ? "observed" : "claimed";
  return {
    contextId,
    turnId,
    expectedRevision,
    policyGeneration,
    baseCommit,
    baseCommitStatus,
    baseWorktreeState: params.base_worktree_state === "clean" || params.base_worktree_state === "dirty" ? params.base_worktree_state : "unknown",
    goal: boundedString(params.goal, "goal", 1, 4_096),
    decisions: stringList(params.decisions, "decisions", 64, 2_048),
    evidence: evidenceList(params.evidence),
    openRisks: stringList(params.open_risks, "open_risks", 64, 2_048),
    missingChecks: stringList(params.missing_checks, "missing_checks", 64, 2_048),
    nextActions: stringList(params.next_actions, "next_actions", 64, 2_048),
  };
}

export function evidenceList(value: unknown): readonly ContextEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new RpcRuntimeError("invalid_params", "evidence must be a bounded array");
  return value.map((item) => {
    const source = object(item);
    if (!["job", "test", "commit", "note"].includes(String(source.kind))) throw new RpcRuntimeError("invalid_params", "evidence kind is invalid");
    if (source.status !== "claimed" && source.status !== "observed") throw new RpcRuntimeError("invalid_params", "evidence status is invalid");
    const evidence: Record<string, unknown> = { kind: source.kind, status: source.status };
    if (source.job_id !== undefined) evidence.job_id = safeId(source.job_id, "evidence.job_id");
    if (source.job_status !== undefined) evidence.job_status = boundedString(source.job_status, "evidence.job_status", 1, 64);
    if (source.exit_code === null || (typeof source.exit_code === "number" && Number.isSafeInteger(source.exit_code))) evidence.exit_code = source.exit_code;
    else if (source.exit_code !== undefined) throw new RpcRuntimeError("invalid_params", "evidence.exit_code is invalid");
    if (source.ref !== undefined) evidence.ref = boundedString(source.ref, "evidence.ref", 1, 256);
    if (source.summary !== undefined) evidence.summary = boundedString(source.summary, "evidence.summary", 1, 1_024);
    if (source.observed_at_ms !== undefined) evidence.observed_at_ms = boundedInteger(source.observed_at_ms, 0, Number.MAX_SAFE_INTEGER, "evidence.observed_at_ms");
    return evidence as ContextEvidence;
  });
}

export function checkpointFingerprint(value: NormalizedCheckpoint, version: 1 | 2 = CONTEXT_SCHEMA_VERSION): string {
  // The v1 layout is frozen for reads of old records. New v2 records also
  // protect observation source, policy and worktree state in their digest.
  const original = { turn_id: value.turnId, base_commit: value.baseCommit, goal: value.goal, decisions: value.decisions, evidence: value.evidence, open_risks: value.openRisks, missing_checks: value.missingChecks, next_actions: value.nextActions };
  const payload = version === 1 ? original : { ...original, policy_generation: value.policyGeneration, base_commit_status: value.baseCommitStatus, base_worktree_state: value.baseWorktreeState };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function semanticFingerprint(value: NormalizedCheckpoint): string {
  return checkpointFingerprint({ ...value, evidence: value.evidence.map(({ observed_at_ms: _observed, ...fact }) => fact) });
}

export function indexEntry(record: ContextRecord): ContextIndexEntry {
  const evidence = record.evidence.flatMap((item) => [item.summary ?? "", item.ref ?? "", item.job_id ?? ""]);
  return {
    context_id: record.context_id,
    revision: record.revision,
    turn_id: record.turn_id,
    fingerprint: record.fingerprint,
    updated_at_ms: record.updated_at_ms,
    base_commit: record.base_commit,
    goal: record.goal,
    review_state: record.review_state,
    search_text: [record.goal, ...record.decisions, ...record.open_risks, ...record.missing_checks, ...record.next_actions, ...evidence, record.base_commit ?? ""].join("\n").toLocaleLowerCase().slice(0, 32 * 1024),
  };
}

export function indexProjection(entry: ContextIndexEntry): Record<string, unknown> {
  return { context_id: entry.context_id, revision: entry.revision, turn_id: entry.turn_id, updated_at_ms: entry.updated_at_ms, base_commit: entry.base_commit, goal: entry.goal, review_state: entry.review_state };
}

export function latestForTurn(index: ContextIndex, turnId: string): ContextIndexEntry | undefined {
  return index.records.filter((entry) => entry.turn_id === turnId).sort((left, right) => right.revision - left.revision || right.updated_at_ms - left.updated_at_ms)[0];
}

export function emptyIndex(workspaceId: string): ContextIndex { return { schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: null, records: [] }; }

export function parseIndex(value: unknown, workspaceId: string): ContextIndex {
  const source = object(value);
  if (source.schema_version !== INDEX_SCHEMA_VERSION || source.workspace_id !== workspaceId || !Array.isArray(source.records) || source.records.length > MAX_CONTEXTS) throw new RpcRuntimeError("context_index_corrupt", "context index schema or workspace binding is invalid");
  const records = source.records.map((item) => {
    const entry = object(item);
    const contextId = safeId(entry.context_id, "context_id");
    const turnId = safeId(entry.turn_id, "turn_id");
    const fingerprint = boundedString(entry.fingerprint, "fingerprint", 64, 64);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new RpcRuntimeError("context_index_corrupt", "context index fingerprint is invalid");
    const baseCommit = entry.base_commit === null ? null : boundedString(entry.base_commit, "base_commit", 7, 64);
    if (baseCommit !== null && !SAFE_COMMIT.test(baseCommit)) throw new RpcRuntimeError("context_index_corrupt", "context index commit is invalid");
    if (entry.review_state !== "incomplete" && entry.review_state !== "claimed" && entry.review_state !== "evidence_backed") throw new RpcRuntimeError("context_index_corrupt", "context index review state is invalid");
    return {
      context_id: contextId,
      revision: boundedInteger(entry.revision, 1, Number.MAX_SAFE_INTEGER, "revision"),
      turn_id: turnId,
      fingerprint,
      updated_at_ms: boundedInteger(entry.updated_at_ms, 0, Number.MAX_SAFE_INTEGER, "updated_at_ms"),
      base_commit: baseCommit,
      goal: boundedString(entry.goal, "goal", 1, 4_096),
      review_state: entry.review_state,
      search_text: boundedString(entry.search_text, "search_text", 0, 32 * 1024),
    } satisfies ContextIndexEntry;
  });
  return { schema_version: INDEX_SCHEMA_VERSION, workspace_id: workspaceId, rebuilt_at_ms: source.rebuilt_at_ms === null ? null : boundedInteger(source.rebuilt_at_ms, 0, Number.MAX_SAFE_INTEGER, "rebuilt_at_ms"), records };
}

export function parseRecord(value: unknown, workspaceId: string, contextId: string): ContextRecord {
  const source = object(value);
  if ((source.schema_version !== 1 && source.schema_version !== CONTEXT_SCHEMA_VERSION) || source.workspace_id !== workspaceId || source.context_id !== contextId) throw new RpcRuntimeError("context_record_corrupt", "context record binding is invalid");
  if (source.schema_version === 2 && !["clean", "dirty", "unknown"].includes(String(source.base_worktree_state))) throw new RpcRuntimeError("context_record_corrupt", "Context worktree observation is invalid");
  const normalized = normalizeCheckpoint({
    workspace_id: workspaceId,
    context_id: contextId,
    turn_id: source.turn_id,
    expected_revision: source.revision,
    policy_generation: source.policy_generation ?? undefined,
    base_commit: source.base_commit,
    base_commit_status: source.base_commit_status,
    base_worktree_state: source.base_worktree_state,
    goal: source.goal,
    decisions: source.decisions,
    evidence: source.evidence,
    open_risks: source.open_risks,
    missing_checks: source.missing_checks,
    next_actions: source.next_actions,
  }, workspaceId);
  const fingerprint = boundedString(source.fingerprint, "fingerprint", 64, 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || checkpointFingerprint(normalized, source.schema_version as 1 | 2) !== fingerprint) throw new RpcRuntimeError("context_record_corrupt", "context record fingerprint is invalid");
  const review = source.review_state;
  if (review !== "incomplete" && review !== "claimed" && review !== "evidence_backed") throw new RpcRuntimeError("context_record_corrupt", "context review state is invalid");
  return {
    schema_version: source.schema_version as 1 | 2,
    context_id: contextId,
    workspace_id: workspaceId,
    revision: boundedInteger(source.revision, 1, Number.MAX_SAFE_INTEGER, "revision"),
    supersedes_revision: source.supersedes_revision === null ? null : boundedInteger(source.supersedes_revision, 1, Number.MAX_SAFE_INTEGER, "supersedes_revision"),
    turn_id: normalized.turnId,
    fingerprint,
    created_at_ms: boundedInteger(source.created_at_ms, 0, Number.MAX_SAFE_INTEGER, "created_at_ms"),
    updated_at_ms: boundedInteger(source.updated_at_ms, 0, Number.MAX_SAFE_INTEGER, "updated_at_ms"),
    policy_generation: normalized.policyGeneration,
    base_commit: normalized.baseCommit,
    base_commit_status: normalized.baseCommitStatus,
    base_worktree_state: normalized.baseWorktreeState,
    goal: normalized.goal,
    decisions: normalized.decisions,
    evidence: normalized.evidence,
    open_risks: normalized.openRisks,
    missing_checks: normalized.missingChecks,
    next_actions: normalized.nextActions,
    review_state: review,
  };
}

export function workspaceIdFrom(input: unknown): string { return safeId(object(input).workspace_id, "workspace_id"); }

export function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "parameters must be an object"); return value as Record<string, unknown>; }

export function safeId(value: unknown, field: string): string { if (typeof value !== "string" || !SAFE_ID.test(value)) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return value; }

export function boundedString(value: unknown, field: string, min: number, max: number): string { if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return value; }

export function boundedInteger(value: unknown, min: number, max: number, field: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return value; }

export function boundedIntegerString(value: unknown, min: number, max: number, field: string): number { if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RpcRuntimeError("invalid_params", `${field} is invalid`); return parsed; }

export function stringList(value: unknown, field: string, maxItems: number, maxLength: number): readonly string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems) throw new RpcRuntimeError("invalid_params", `${field} must be a bounded array`); return value.map((item) => boundedString(item, field, 1, maxLength)); }

export function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code; }

export function conflict(code: string, message: string, details?: Record<string, unknown>): RpcRuntimeError { return new RpcRuntimeError(code, message, details); }
