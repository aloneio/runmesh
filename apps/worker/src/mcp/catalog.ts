import { TOOL_OUTPUT_SCHEMAS } from "./output-contracts.js";
import { publishActionInput, boundInputJson, JOB_INPUT_REQUIREMENT, EDIT_PREVIEW_REQUIREMENT, CONTEXT_PRUNE_REQUIREMENT } from "./input-publication.js";
import { ContextPruneOptionsSchema } from "@aloneio/runmesh-protocol";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS, BoundFileCursorSchema, BoundLogCursorSchema, isBoundCursor } from "@aloneio/runmesh-protocol";
import { z } from "zod";

import { NATIVE_SCOPES } from "../contracts/identity.js";
export const SUPPORTED_SCOPES = NATIVE_SCOPES;
export type CodingScope = (typeof SUPPORTED_SCOPES)[number];

export type ToolSpec<Input extends z.ZodType = z.ZodType> = {
  readonly scope?: CodingScope;
  readonly description: string;
  readonly inputSchema: Input;
  readonly outputSchema: z.ZodType;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
};

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const execAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const mixedAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export const RunnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe runner identifier");
export const WorkspaceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe workspace identifier").describe("Opaque ID returned by workspace_list or the original Job receipt; not a host directory.");
export const RelativePathSchema = z.string().min(1).max(4096).regex(/^(?![\\/]|[A-Za-z]:)(?![\s\S]*\u0000)(?!\.\.(?:[\\/]|$))(?![\s\S]*[\\/]\.\.(?:[\\/]|$))[\s\S]+$/, "must be a workspace-relative path without traversal").describe("Path relative to the selected workspace, never an absolute host path or a path containing .. segments.");
export const CursorSchema = z.string().max(128).regex(/^\d+$/, "must be a numeric cursor").optional();
export const FileCursorSchema = z.union([CursorSchema.unwrap(), BoundFileCursorSchema]).optional();
export const LogCursorSchema = z.union([CursorSchema.unwrap(), BoundLogCursorSchema]).optional();
function checkBoundInput(value: { cursor?: string | undefined; offset?: number | undefined; tail?: boolean | undefined; consistency?: string | undefined }, context: z.RefinementCtx, kind: "file" | "log"): void {
  const mode = kind === "file" ? "snapshot" : "append";
  if (isBoundCursor(value.cursor, kind) && (value.offset !== undefined || value.tail === true || value.consistency === "live")) context.addIssue({ code: "custom", message: "bound cursors cannot be combined with offset, tail or live consistency" });
  if (value.consistency === mode && value.cursor !== undefined && !isBoundCursor(value.cursor, kind)) context.addIssue({ code: "custom", message: "start a bound read without a legacy numeric cursor" });
}
export const InspectCursorSchema = z.string().max(128).regex(/^(?:\d+|s1:[a-f0-9]{16}:\d+)$/, "must be a numeric or search snapshot cursor").optional();
export const SearchGlobSchema = z.string().min(1).max(256).regex(/^[^\u0000]*$/, "glob must not contain NUL");
export const BoundedLimitSchema = z.number().int().min(1).max(65_536).optional();
export const JobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe job identifier").describe("Exact Job ID from the original shell receipt on the same selected Runner; pair it with that receipt's workspace_id.");
export const JobStatusSchema = z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"]);

export const ReadInputSchema = z.object({ workspace_id: WorkspaceIdSchema, path: RelativePathSchema, cursor: FileCursorSchema, offset: z.number().int().min(0).safe().optional(), consistency: z.enum(["live", "snapshot"]).optional(), limit: z.number().int().min(1).max(262_144).optional() }).strict().superRefine((value, context) => checkBoundInput(value, context, "file")).meta(boundInputJson("file"));
// Structural branches survive both SDK and catalog JSON Schema conversion;
// superRefine-only action rules are invisible to tools/list consumers.
// Keep the historically accepted common numeric cursor/limit inputs, even on
// actions that ignore them. This change aligns the contract, not RPC behavior.
const InspectCommonInputSchema = z.object({
  workspace_id: WorkspaceIdSchema,
  path: RelativePathSchema.optional(),
  max_results: z.number().int().min(1).max(256).optional(),
  cursor: CursorSchema,
}).strict();
export const InspectInputSchema = publishActionInput(z.discriminatedUnion("action", [
  InspectCommonInputSchema.extend({ action: z.literal("list") }),
  InspectCommonInputSchema.extend({
    action: z.literal("search"), query: z.string().min(1).max(512), cursor: InspectCursorSchema,
    mode: z.enum(["literal", "filename"]).optional(), case_sensitive: z.boolean().optional(),
    include_globs: z.array(SearchGlobSchema).max(32).optional(), exclude_globs: z.array(SearchGlobSchema).max(32).optional(),
    context_before: z.number().int().min(0).max(8).optional(), context_after: z.number().int().min(0).max(8).optional(),
  }),
  InspectCommonInputSchema.extend({ action: z.literal("stat"), path: RelativePathSchema }),
  InspectCommonInputSchema.extend({ action: z.literal("git_status") }),
  InspectCommonInputSchema.extend({ action: z.literal("git_diff") }),
  InspectCommonInputSchema.extend({ action: z.literal("git_log"), path: RelativePathSchema }),
  InspectCommonInputSchema.extend({ action: z.literal("git_show"), path: RelativePathSchema,
    revision: z.string().regex(/^[0-9a-fA-F]{7,64}(?:\^\{0,1\})?$/).describe("Commit identifier; required and accepted only for git_show."),
  }),
  InspectCommonInputSchema.extend({ action: z.literal("git_blame"), path: RelativePathSchema,
    start_line: z.number().int().min(1).max(1_000_000).optional(), end_line: z.number().int().min(1).max(1_000_000).optional(),
  }),
  InspectCommonInputSchema.extend({ action: z.literal("diagnostics") }),
]));
export const EditInputSchema = z.object({ workspace_id: WorkspaceIdSchema, patch: z.string().min(1).max(1_048_576), preview: z.boolean().optional(), preview_id: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_hashes: z.record(z.string().min(1).max(4096), z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional() }).strict().superRefine((value, context) => {
  if (value.preview === true && value.preview_id !== undefined) context.addIssue({ code: "custom", message: "preview_id is only valid when applying a patch" });
}).meta(EDIT_PREVIEW_REQUIREMENT);
export const ShellInputSchema = z.object({ workspace_id: WorkspaceIdSchema, command: z.string().min(1).max(8_192), request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(), wait_ms: z.number().int().min(1).max(LOCAL_RUNNER_OPERATION_TIMEOUT_MS).optional(), background: z.boolean().optional(), queue: z.boolean().optional() }).strict();
export const JobInputSchema = publishActionInput(z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspace_id: WorkspaceIdSchema.optional(), status: JobStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("get"), job_id: JobIdSchema, workspace_id: WorkspaceIdSchema.optional() }).strict(),
  z.object({ action: z.literal("logs"), job_id: JobIdSchema, workspace_id: WorkspaceIdSchema.optional(), stream: z.enum(["stdout", "stderr"]).optional(), cursor: LogCursorSchema, offset: z.number().int().min(0).safe().optional(), consistency: z.enum(["live", "append"]).optional(), limit: BoundedLimitSchema, tail: z.boolean().optional() }).strict().superRefine((value, context) => checkBoundInput(value, context, "log")).meta(boundInputJson("log")),
  z.object({ action: z.literal("cancel"), job_id: JobIdSchema, workspace_id: WorkspaceIdSchema.optional() }).strict(),
  z.object({ action: z.literal("input"), job_id: JobIdSchema, workspace_id: WorkspaceIdSchema.optional(), data: z.string().max(65_536).optional(), close_stdin: z.boolean().optional() }).strict().refine((value) => value.data !== undefined || value.close_stdin === true, "data or close_stdin is required").meta(JOB_INPUT_REQUIREMENT),
]));
const ContextTextSchema = z.string().min(1).max(2_048);
const ContextEvidenceBase = z.object({
  ref: z.string().min(1).max(256).optional(),
  summary: z.string().min(1).max(1_024).optional(),
}).strict();
const ContextEvidenceSchema = z.discriminatedUnion("kind", [
  ContextEvidenceBase.extend({ kind: z.literal("job"), job_id: JobIdSchema }),
  ContextEvidenceBase.extend({ kind: z.literal("test") }),
  ContextEvidenceBase.extend({ kind: z.literal("commit") }),
  ContextEvidenceBase.extend({ kind: z.literal("note") }),
]);
export const ContextInputSchema = publishActionInput(z.discriminatedUnion("action", [
  z.object({ action: z.literal("bootstrap"), workspace_id: WorkspaceIdSchema }).strict(),
  z.object({ action: z.literal("read"), workspace_id: WorkspaceIdSchema, context_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), revision: z.number().int().positive().safe().optional() }).strict(),
  z.object({ action: z.literal("search"), workspace_id: WorkspaceIdSchema, query: z.string().min(1).max(512), limit: z.number().int().min(1).max(50).optional(), cursor: CursorSchema }).strict(),
  z.object({ action: z.literal("checkpoint"), workspace_id: WorkspaceIdSchema, context_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(), turn_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), expected_revision: z.number().int().min(0).safe().optional(), base_commit: z.string().regex(/^[0-9a-fA-F]{7,64}$/).optional(), goal: z.string().min(1).max(4_096), decisions: z.array(ContextTextSchema).max(64).optional(), evidence: z.array(ContextEvidenceSchema).max(64).optional(), open_risks: z.array(ContextTextSchema).max(64).optional(), missing_checks: z.array(ContextTextSchema).max(64).optional(), next_actions: z.array(ContextTextSchema).max(64).optional() }).strict(),
  z.object({ action: z.literal("rebuild"), workspace_id: WorkspaceIdSchema }).strict(),
  z.object({ action: z.literal("storage"), workspace_id: WorkspaceIdSchema }).strict(),
  ContextPruneOptionsSchema.extend({ action: z.literal("prune"), workspace_id: WorkspaceIdSchema }).strict().refine(
    value => (value.apply === true) === (value.expected_plan_hash !== undefined),
    "Apply requires expected_plan_hash from a fresh preview; previews must omit it").meta(CONTEXT_PRUNE_REQUIREMENT),
]));

const emptySchema = z.object({}).strict();
const runnerSelectSchema = z.object({ runner_id: RunnerIdSchema, confirm_switch: z.boolean().optional() }).strict();
// Kept only for source compatibility; no tool uses an untyped fallback.
export const SafeOutputSchema = z.object({}).strict();
export { ReadOutputSchema, ContextOutputSchema } from "./output-contracts.js";

export const TOOL_SPECS = {
  runner_list: { scope: "coding:read", description: "List runners this client can read, with safe IDs, display names, and last-known connection state. Credentials and workspace roots are never returned.", inputSchema: emptySchema, outputSchema: TOOL_OUTPUT_SCHEMAS.runner_list, annotations: readAnnotations },
  runner_current: { scope: "coding:read", description: "Return this MCP client's sticky runner selection, or null. An unavailable selection never falls back to another runner.", inputSchema: emptySchema, outputSchema: TOOL_OUTPUT_SCHEMAS.runner_current, annotations: readAnnotations },
  runner_select: { scope: "coding:read", description: "Select this MCP client's active runner. Initial selection is immediate; changing a selection requires confirm_switch=true.", inputSchema: runnerSelectSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.runner_select, annotations: writeAnnotations },
  workspace_list: { scope: "coding:read", description: "List readable workspace IDs on the active runner. Workspace roots are never returned.", inputSchema: emptySchema, outputSchema: TOOL_OUTPUT_SCHEMAS.workspace_list, annotations: readAnnotations },
  inspect: { scope: "coding:read", description: "Inspect a workspace with bounded list, search, stat, Git history, or layered diagnostics. This is read-only; workspace roots and host paths are never returned.", inputSchema: InspectInputSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.inspect, annotations: readAnnotations },
  read: { scope: "coding:read", description: "Read a bounded UTF-8-safe page of a workspace-relative file. Use next_cursor or offset to continue. New Runner page_state distinguishes more, end and incomplete UTF-8; resume_offset is for an explicit later refresh, not polling. Numeric cursors are live observations. Opt in with consistency=snapshot for a bounded 1 MiB content snapshot; continue using its opaque next_cursor, not offset. Expired cursors require a fresh read. Host roots and absolute paths are not accepted.", inputSchema: ReadInputSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.read, annotations: readAnnotations },
  edit: { scope: "coding:write", description: "Preview or apply a transactional, baseline-checked patch to a writable workspace. The result contains only bounded, workspace-relative change metadata.", inputSchema: EditInputSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.edit, annotations: destructiveAnnotations },
  shell: { scope: "coding:exec", description: "Run a command through the selected runner's Host shell (Bash on Linux/macOS or PowerShell on Windows). Commands have the runner user's OS permissions and are not sandboxed; the workspace controls initial cwd and policy, not the Host shell root. Use a restricted VM/container and avoid administrator/root runners for untrusted code. background=true returns a persistent job immediately; foreground waits only up to wait_ms, which is not an execution deadline. Compatible Runners accept queued Jobs when execution slots are full; queue=false requests immediate admission only. Waiting Jobs return their ID immediately. Follow queued/running Jobs with job get/logs using the original job_id and workspace_id, never a second shell launch. Foreground output is a bounded tail: offset>0 omits the prefix; use job logs with offset=0 to read it. Check status and exit_code even when the MCP call succeeds. request_id is an optional deduplication key for the same intended launch, not a reason to blindly retry uncertain outcomes.", inputSchema: ShellInputSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.shell, annotations: execAnnotations },
  job: { description: "List, inspect, or read bounded logs for persistent jobs. consistency=append opts log reads into generation-bound cursors that permit append; use resume_cursor for later explicit refresh. Rotation, truncation or expiry requires a fresh read, not command re-execution. cancel and input require coding:exec plus workspace job-control permission. Pass workspace_id with get/logs/cancel/input to operate without cloud Job history (Runner 0.1.1+). Job metadata never includes command, cwd, PID, roots, or secrets.", inputSchema: JobInputSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.job, annotations: mixedAnnotations },
  context: { description: "Read or explicitly checkpoint workspace handoff context stored locally on the selected Runner. bootstrap/read/search are read-only; checkpoint/rebuild require coding:write plus workspace edit permission. Omit context_id to create a checkpoint; use the returned ID for updates. New Runners reject unknown supplied IDs. Raw chat, system prompts, host paths, and hidden reasoning are not captured. storage reads bounded local usage without writes; prune requires coding:write, keep_days and keep_revisions, defaults to preview, and apply=true requires expected_plan_hash from that preview. Pruning only removes superseded revisions, never the latest; do not automatically apply a preview.", inputSchema: ContextInputSchema, outputSchema: TOOL_OUTPUT_SCHEMAS.context, annotations: mixedAnnotations },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_SPECS;
