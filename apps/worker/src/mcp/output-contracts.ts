import { z } from "zod";
import { BytePageMetadataSchema, BoundFileCursorSchema, BoundLogCursorSchema, ContextStorageReportSchema, ContextPruneReportSchema, RunnerCapabilityReportSchema } from "@aloneio/runmesh-protocol";

// These schemas describe the already-redacted public boundary, never internal
// Registry rows or Runner records. Optional legacy observations stay optional;
// required action evidence is checked separately by validateToolOutput.
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const count = z.number().int().nonnegative().safe();
const positive = count.min(1);
const text = (max: number) => z.string().max(max);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const oid = z.string().regex(/^[a-f0-9]{7,64}$/iu);
const path = text(4096).refine(value => !value.includes("\0") && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/u.test(value) && !value.split(/[\\/]/u).includes(".."));
const cursor = z.string().max(128).regex(/^(?:\d+|s1:[a-f0-9]{16}:\d+)$/u);
const fileCursor = z.union([cursor, BoundFileCursorSchema]);
const logCursor = z.union([cursor, BoundLogCursorSchema]);
const status = z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"]);
const exit = z.number().int().min(-(2 ** 31)).max(2 ** 31).nullable();
const permissions = z.object({ read: z.boolean(), edit: z.boolean(), shell: z.boolean(), job_control: z.boolean() }).strict();
const runnerContext = z.object({ runner_id: id.optional(), state: z.enum(["online", "offline", "stale", "unavailable"]).optional(), available: z.boolean().optional(), updated_at_ms: count.nullable().optional(), automatic_selection: z.boolean().optional() }).strict();

// The bounded truncation envelope is an explicit compatibility alternative,
// not permission to insert arbitrary new fields into a successful result.
const common = {
  runner_context: runnerContext.optional(), correlation_id: z.string().max(160).regex(/^call-[A-Za-z0-9-]+$/u).optional(),
  audit_status: z.enum(["recorded", "degraded", "unknown", "disabled"]).optional(),
  truncated: z.boolean().optional(), data: text(65_536).optional(), recovery_hint: text(4096).optional(),
};
export const PUBLIC_RESULT_METADATA = Object.freeze(common);
const snapshot = { source: z.enum(["registry_snapshot", "runner_live"]).optional(), runner_state: z.literal("offline").optional() };
const page = {
  ...BytePageMetadataSchema.partial().shape,
  page_protocol: z.union([z.literal(1), z.literal(2)]).optional(), snapshot_id: hash.nullable().optional(),
  cursor_expires_at_ms: count.optional(),
};

export const JobMetadataOutputSchema = z.object({
  job_id: id.optional(), workspace_id: id.optional(), created_by_client_id: id.optional(), request_id: id.optional(), status: status.optional(),
  created_at_ms: count.optional(), started_at_ms: count.nullable().optional(), updated_at_ms: count.optional(), completed_at_ms: count.nullable().optional(),
  exit_code: exit.optional(), signal: z.string().max(32).regex(/^(?:SIG[A-Z0-9]+|[A-Z][A-Z0-9_]{0,31})$/u).nullable().optional(),
  output_truncated: z.boolean().optional(), cancellation_delivered_at_ms: count.nullable().optional(),
}).strict();
export const LogOutputSchema = z.object({
  job_id: id.optional(), stream: z.enum(["stdout", "stderr"]).optional(), data: text(65_536).optional(), offset: count.optional(),
  next_cursor: logCursor.nullable().optional(), truncated: z.boolean().optional(), size: count.optional(), source_truncated: z.boolean().optional(),
  available: z.literal(false).optional(), error: z.object({ code: z.literal("log_unavailable") }).strict().optional(),
  ...page, consistency: z.literal("append").optional(), resume_cursor: BoundLogCursorSchema.optional(),
}).strict();
const shell = {
  ...JobMetadataOutputSchema.shape, completed: z.boolean().optional(), wait_cap_ms: count.optional(),
  queue: z.object({ waiting: count.max(1000).optional(), limit: count.max(1000).optional(), per_client_limit: count.max(1000).optional(), running: count.max(1000).optional(), max_concurrent_jobs: positive.max(64).optional(), available_slots: count.max(64).optional() }).strict().optional(),
  stdout: LogOutputSchema.optional(), stderr: LogOutputSchema.optional(),
};
export const RunnerListOutputSchema = z.object({ ...common, runners: z.array(z.object({ runner_id: id, display_name: text(256), state: z.enum(["online", "offline", "stale", "unavailable"]), available: z.boolean(), updated_at_ms: count.nullable() }).strict()).optional() }).strict();
export const RunnerCurrentOutputSchema = z.object({ ...common, active_runner_id: id.nullable().optional(), active_runner_updated_at_ms: count.nullable().optional(), active_runner: runnerContext.nullable().optional() }).strict();
export const RunnerSelectOutputSchema = RunnerCurrentOutputSchema.extend({ changed: z.boolean().optional() });
export const WorkspaceListOutputSchema = z.object({ ...common, ...snapshot, runner_id: id.optional(), revision: count.optional(), checksum: hash.optional(), workspaces: z.array(z.object({ workspace_id: id, enabled: z.boolean(), permissions }).strict()).optional() }).strict();
export const ReadOutputSchema = z.object({
  ...common, workspace_id: id.optional(), path: path.optional(), encoding: z.literal("utf-8").optional(),
  offset: count.optional(), next_cursor: fileCursor.nullable().optional(), size: count.optional(), ...page,
  consistency: z.literal("snapshot").optional(), resume_cursor: BoundFileCursorSchema.optional(),
}).strict();
export const ShellOutputSchema = z.object({ ...common, ...shell }).strict();
export const JobOutputSchema = z.object({ ...common, ...snapshot, ...shell, ...LogOutputSchema.shape, runner_id: id.optional(), jobs: z.array(JobMetadataOutputSchema).optional(), accepted: count.optional(), eof: z.boolean().optional() }).strict();

const line = z.object({ line: positive, text: text(4096) }).strict();
const directoryEntry = z.object({ name: text(4096), type: z.enum(["file", "directory", "other"]) }).strict();
const gitEntry = z.object({ path, original_path: path.optional(), index_status: text(8).optional(), worktree_status: text(8).optional(), untracked: z.boolean().optional(), ignored: z.boolean().optional() }).strict();
const searchEntry = z.object({ path, line: positive, text: text(4096), column: positive.optional(), match: text(1024).optional(), context_before: z.array(line).max(8).optional(), context_after: z.array(line).max(8).optional() }).strict();
const catalogSummary = z.object({ schema_version: z.literal(1), sha256: hash, tool_names: z.array(id).max(128), tool_count: count, action_count: count, operation_contract_sha256: hash }).strict();
const capabilities = z.object({
  schema_version: z.literal(1), source: z.enum(["unavailable", "live_env_info"]), report_state: z.enum(["not_reported", "invalid", "reported"]),
  evidence_scope: z.literal("implementation_only"), runner: RunnerCapabilityReportSchema.nullable(), contract_match: z.boolean().nullable(),
  worker_catalog: catalogSummary, host_catalog_state: z.literal("not_observed"),
  actions: z.array(z.object({ tool: id, action: text(64), method: text(128), required_scope: z.enum(["coding:read", "coding:write", "coding:exec"]), required_permission: z.enum(["read", "edit", "shell", "job_control"]), runner_support: z.enum(["unknown", "supported", "unsupported"]), permission_snapshot: z.enum(["unknown", "denied", "permitted"]), requires_job_check: z.boolean(), requires_final_authorization: z.literal(true) }).strict()).max(128),
}).strict();
export const InspectOutputSchema = z.object({
  ...common, workspace_id: id.optional(), path: path.optional(),
  type: z.enum(["file", "directory", "other"]).optional(), size: count.optional(), modified_at_ms: count.optional(), encoding: z.enum(["utf-8", "binary"]).optional(), binary: z.boolean().optional(),
  entries: z.union([z.array(directoryEntry).max(256), z.array(gitEntry).max(1000)]).optional(),
  next_cursor: cursor.nullable().optional(), query: text(512).optional(), mode: z.enum(["literal", "filename"]).optional(), case_sensitive: z.boolean().optional(),
  engine: z.enum(["builtin_literal", "builtin_filename"]).optional(), snapshot_id: z.string().regex(/^[a-f0-9]{16}$/u).optional(), results: z.array(searchEntry).max(256).optional(),
  next_snapshot_cursor: z.string().regex(/^s1:[a-f0-9]{16}:\d+$/u).nullable().optional(),
  truncated_reason: z.enum(["time_budget", "byte_budget", "directory_budget", "entry_budget", "file_budget", "result_budget", "response_bytes"]).optional(),
  scanned: z.object({ bytes: count.optional(), files: count.optional(), directories: count.optional(), entries: count.optional() }).strict().optional(), returned_bytes: count.optional(),
  branch: z.object({ oid: text(512).optional(), head: text(512).optional(), upstream: text(512).optional() }).strict().optional(), ahead: count.optional(), behind: count.optional(), output_bytes: count.optional(),
  commits: z.array(z.object({ oid: z.string().regex(/^[a-f0-9]{40,64}$/iu), author: text(512), date: text(64), subject: text(4096) }).strict()).max(100).optional(), limit: count.optional(),
  revision: text(65_536).optional(), start_line: count.optional(), end_line: count.optional(), output: text(65_536).optional(), bytes: count.optional(), staged: z.boolean().optional(), diff: text(65_536).optional(),
  observed_at_ms: count.optional(), permissions: permissions.nullable().optional(), capabilities: capabilities.optional(),
  job_scheduler: z.object({ waiting: count.max(1000), limit: count.max(1000), per_client_limit: count.max(1000), running: count.max(1000), max_concurrent_jobs: positive.max(64), available_slots: count.max(64) }).strict().optional(),
  checks: z.array(z.object({ name: text(128), state: z.enum(["pass", "fail", "unknown"]), code: text(128).nullable().optional(), evidence_source: text(128), observed_at_ms: count, desired_revision: positive.nullable().optional(), applied_revision: positive.nullable().optional(), runner_reported_revision: positive.nullable().optional() }).strict()).max(32).optional(),
  shell: z.object({ available: z.boolean(), kind: z.enum(["bash", "powershell"]).optional() }).strict().optional(),
}).strict();

const change = z.object({ path, status: z.enum(["created", "updated", "deleted"]), before_hash: hash.nullable().optional(), after_hash: hash.nullable().optional(), mode: count.max(0o7777).optional() }).strict();
export const EditOutputSchema = z.object({
  ...common, workspace_id: id.optional(), preview_id: hash.optional(), insertions: count.optional(), deletions: count.optional(), previews_truncated: z.boolean().optional(),
  changed_paths: z.array(change).max(128).optional(),
  operations: z.array(z.object({ operation: z.enum(["add", "update", "delete", "move"]), path, status: z.literal("applied"), destination: path.optional(), results: z.array(change).max(128).optional() }).strict()).max(128).optional(),
  previews: z.array(z.object({ path, diff: text(16_384), status: z.enum(["created", "updated", "deleted"]).optional(), insertions: count.optional(), deletions: count.optional(), truncated: z.boolean().optional() }).strict()).max(128).optional(),
  warnings: z.array(z.object({ path, code: z.literal("recovery_required") }).strict()).max(128).optional(),
}).strict();

const contextIndex = z.object({ context_id: id.optional(), turn_id: id.optional(), revision: positive.optional(), updated_at_ms: count.optional(), base_commit: oid.nullable().optional(), review_state: z.enum(["incomplete", "claimed", "evidence_backed"]).optional(), goal: text(4096).optional() }).strict();
const contextRecord = z.object({
  ...contextIndex.shape, schema_version: z.union([z.literal(1), z.literal(2)]).optional(), workspace_id: id.optional(),
  revision: count.nullable().optional(), supersedes_revision: count.nullable().optional(), created_at_ms: count.nullable().optional(), updated_at_ms: count.nullable().optional(), policy_generation: count.nullable().optional(),
  fingerprint: hash.optional(), base_commit_status: z.enum(["claimed", "observed"]).nullable().optional(),
  base_worktree_state: z.enum(["clean", "dirty", "unknown"]).optional(), working_tree_state: z.enum(["clean", "dirty", "unknown"]).optional(), commit_state: z.enum(["current", "stale", "unknown"]).optional(), baseline_state: z.enum(["current", "stale", "unknown"]).optional(), baseline_scope: z.literal("git-tracked-and-untracked-status").optional(), current_commit: oid.nullable().optional(),
  decisions: z.array(text(2048)).max(64).optional(), open_risks: z.array(text(2048)).max(64).optional(), missing_checks: z.array(text(2048)).max(64).optional(), next_actions: z.array(text(2048)).max(64).optional(),
  evidence: z.array(z.object({ kind: z.enum(["job", "test", "commit", "note"]).optional(), status: z.enum(["claimed", "observed"]).optional(), job_id: id.optional(), job_status: status.optional(), exit_code: exit.optional(), ref: text(256).optional(), summary: text(1024).optional(), observed_at_ms: count.optional() }).strict()).max(64).optional(),
}).strict();
export const ContextOutputSchema = z.object({
  ...common, ...ContextStorageReportSchema.partial().shape, ...ContextPruneReportSchema.partial().shape,
  workspace_id: id.optional(), state: z.enum(["missing", "ready"]).optional(), deduplicated: z.boolean().optional(), rebuilt: z.boolean().optional(),
  records: count.optional(), scanned_files: count.optional(), scanned_bytes: count.optional(), rebuilt_at_ms: count.optional(), scanned_records: count.optional(),
  query: text(512).optional(), next_cursor: cursor.nullable().optional(), context: contextRecord.nullable().optional(), results: z.array(contextIndex).max(50).optional(),
}).strict();

export const TOOL_OUTPUT_SCHEMAS = Object.freeze({ runner_list: RunnerListOutputSchema, runner_current: RunnerCurrentOutputSchema, runner_select: RunnerSelectOutputSchema, workspace_list: WorkspaceListOutputSchema, inspect: InspectOutputSchema, read: ReadOutputSchema, edit: EditOutputSchema, shell: ShellOutputSchema, job: JobOutputSchema, context: ContextOutputSchema });
