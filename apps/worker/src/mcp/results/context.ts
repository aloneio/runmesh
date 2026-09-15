import { copyContextText } from "./primitives.js";
import { copySafeInteger } from "./primitives.js";
import { copySafeWorkspaceId } from "./primitives.js";
import { hasControlCharacters } from "./primitives.js";
import { isRecord } from "./primitives.js";
import { isSafeExitCode } from "./primitives.js";
import { isSafeNonnegativeInteger } from "./primitives.js";
import { isSafePositiveInteger } from "./primitives.js";
import { safeContextStorageReport } from "@aloneio/runmesh-protocol";
import { safeJobIdentifier } from "./primitives.js";
import { safeJobStatus } from "./primitives.js";

export function safeContextResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.storage_schema !== undefined || value.retention_schema !== undefined) return safeContextStorageReport(value) ?? {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  if (value.state === "missing" || value.state === "ready") output.state = value.state;
  if (typeof value.deduplicated === "boolean") output.deduplicated = value.deduplicated;
  if (typeof value.rebuilt === "boolean") output.rebuilt = value.rebuilt;
  for (const key of ["records", "scanned_files", "scanned_bytes", "rebuilt_at_ms", "scanned_records"] as const) copySafeInteger(value, output, key);
  if (typeof value.query === "string" && value.query.length <= 512 && !hasControlCharacters(value.query)) output.query = value.query;
  if (value.next_cursor === null || (typeof value.next_cursor === "string" && /^\d+$/u.test(value.next_cursor))) output.next_cursor = value.next_cursor;
  if (value.context === null) output.context = null;
  else if (isRecord(value.context)) output.context = safeContextRecord(value.context);
  if (Array.isArray(value.results)) output.results = value.results.slice(0, 50).flatMap((entry) => isRecord(entry) ? [safeContextIndexEntry(entry)] : []);
  return output;
}

function safeContextRecord(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (value.schema_version === 1 || value.schema_version === 2) output.schema_version = value.schema_version;
  const contextId = safeJobIdentifier(value.context_id); if (contextId !== undefined) output.context_id = contextId;
  const workspaceId = safeJobIdentifier(value.workspace_id); if (workspaceId !== undefined) output.workspace_id = workspaceId;
  const turnId = safeJobIdentifier(value.turn_id); if (turnId !== undefined) output.turn_id = turnId;
  for (const key of ["revision", "supersedes_revision", "created_at_ms", "updated_at_ms", "policy_generation"] as const) {
    const item = value[key];
    if (item === null) output[key] = null;
    else if (isSafeNonnegativeInteger(item)) output[key] = item;
  }
  if (typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(value.fingerprint)) output.fingerprint = value.fingerprint;
  if (value.base_commit === null) output.base_commit = null;
  else if (typeof value.base_commit === "string" && /^[0-9a-fA-F]{7,64}$/u.test(value.base_commit)) output.base_commit = value.base_commit;
  if (value.base_commit_status === null || value.base_commit_status === "claimed" || value.base_commit_status === "observed") output.base_commit_status = value.base_commit_status;
  for (const key of ["base_worktree_state", "working_tree_state"] as const) if (value[key] === "clean" || value[key] === "dirty" || value[key] === "unknown") output[key] = value[key];
  if (value.commit_state === "current" || value.commit_state === "stale" || value.commit_state === "unknown") output.commit_state = value.commit_state;
  if (value.baseline_scope === "git-tracked-and-untracked-status") output.baseline_scope = value.baseline_scope;
  if (value.baseline_state === "current" || value.baseline_state === "stale" || value.baseline_state === "unknown") output.baseline_state = value.baseline_state;
  if (value.current_commit === null) output.current_commit = null;
  else if (typeof value.current_commit === "string" && /^[0-9a-fA-F]{40,64}$/u.test(value.current_commit)) output.current_commit = value.current_commit;
  if (value.review_state === "incomplete" || value.review_state === "claimed" || value.review_state === "evidence_backed") output.review_state = value.review_state;
  copyContextText(value, output, "goal", 4_096);
  for (const key of ["decisions", "open_risks", "missing_checks", "next_actions"] as const) {
    if (Array.isArray(value[key])) output[key] = value[key].slice(0, 64).flatMap((item) => typeof item === "string" && item.length <= 2_048 && !hasControlCharacters(item) ? [item] : []);
  }
  if (Array.isArray(value.evidence)) output.evidence = value.evidence.slice(0, 64).flatMap((item) => isRecord(item) ? [safeContextEvidence(item)] : []);
  return output;
}

function safeContextIndexEntry(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const contextId = safeJobIdentifier(value.context_id); if (contextId !== undefined) output.context_id = contextId;
  const turnId = safeJobIdentifier(value.turn_id); if (turnId !== undefined) output.turn_id = turnId;
  if (isSafePositiveInteger(value.revision)) output.revision = value.revision;
  if (isSafeNonnegativeInteger(value.updated_at_ms)) output.updated_at_ms = value.updated_at_ms;
  if (value.base_commit === null) output.base_commit = null;
  else if (typeof value.base_commit === "string" && /^[0-9a-fA-F]{7,64}$/u.test(value.base_commit)) output.base_commit = value.base_commit;
  if (value.review_state === "incomplete" || value.review_state === "claimed" || value.review_state === "evidence_backed") output.review_state = value.review_state;
  copyContextText(value, output, "goal", 4_096);
  return output;
}

function safeContextEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (value.kind === "job" || value.kind === "test" || value.kind === "commit" || value.kind === "note") output.kind = value.kind;
  if (value.status === "claimed" || value.status === "observed") output.status = value.status;
  const jobId = safeJobIdentifier(value.job_id); if (jobId !== undefined) output.job_id = jobId;
  if (typeof value.job_status === "string") output.job_status = safeJobStatus(value.job_status);
  if (value.exit_code === null || isSafeExitCode(value.exit_code)) output.exit_code = value.exit_code;
  copyContextText(value, output, "ref", 256);
  copyContextText(value, output, "summary", 1_024);
  if (isSafeNonnegativeInteger(value.observed_at_ms)) output.observed_at_ms = value.observed_at_ms;
  return output;
}
