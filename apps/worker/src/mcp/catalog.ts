import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import { z } from "zod";

export const SUPPORTED_SCOPES = ["coding:read", "coding:write", "coding:exec"] as const;
export type CodingScope = (typeof SUPPORTED_SCOPES)[number];

export type ToolSpec<Input extends z.ZodType = z.ZodType> = {
  readonly scope?: CodingScope;
  readonly description: string;
  readonly inputSchema: Input;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
};

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const execAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const mixedAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

export const RunnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe runner identifier");
export const WorkspaceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe workspace identifier");
export const RelativePathSchema = z.string().min(1).max(4096).refine(isSafeRelativePath, "must be a workspace-relative path without traversal");
export const CursorSchema = z.string().max(128).regex(/^\d+$/, "must be a numeric cursor").optional();
export const InspectCursorSchema = z.string().max(128).regex(/^(?:\d+|s1:[a-f0-9]{16}:\d+)$/, "must be a numeric or search snapshot cursor").optional();
export const SearchGlobSchema = z.string().min(1).max(256).refine((value) => !value.includes("\0"), "glob must not contain NUL");
export const BoundedLimitSchema = z.number().int().min(1).max(65_536).optional();
export const JobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe job identifier");
export const JobStatusSchema = z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"]);

export const ReadInputSchema = z.object({ workspace_id: WorkspaceIdSchema, path: RelativePathSchema, cursor: CursorSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(262_144).optional() }).strict();
export const InspectInputSchema = z.object({ action: z.enum(["list", "search", "stat", "git_status", "git_diff", "git_log", "git_show", "git_blame", "diagnostics"]), workspace_id: WorkspaceIdSchema, path: RelativePathSchema.optional(), query: z.string().min(1).max(512).optional(), max_results: z.number().int().min(1).max(256).optional(), cursor: InspectCursorSchema, mode: z.enum(["literal", "filename"]).optional(), case_sensitive: z.boolean().optional(), include_globs: z.array(SearchGlobSchema).max(32).optional(), exclude_globs: z.array(SearchGlobSchema).max(32).optional(), context_before: z.number().int().min(0).max(8).optional(), context_after: z.number().int().min(0).max(8).optional(), revision: z.string().regex(/^[0-9a-fA-F]{7,64}(?:\^\{0,1\})?$/).optional(), start_line: z.number().int().min(1).max(1_000_000).optional(), end_line: z.number().int().min(1).max(1_000_000).optional() }).strict().superRefine((value, context) => {
  if ((value.action === "search" && value.query === undefined) || (value.action !== "search" && value.query !== undefined)) context.addIssue({ code: "custom", message: "query is only valid and required for search" });
  if (value.action !== "search" && (value.mode !== undefined || value.case_sensitive !== undefined || value.include_globs !== undefined || value.exclude_globs !== undefined || value.context_before !== undefined || value.context_after !== undefined)) context.addIssue({ code: "custom", message: "search options are only valid for search" });
  if (value.action !== "search" && typeof value.cursor === "string" && value.cursor.startsWith("s1:")) context.addIssue({ code: "custom", message: "search snapshot cursors are only valid for search" });
  if (value.action === "stat" && value.path === undefined) context.addIssue({ code: "custom", message: "path is required for stat" });
  if (["git_log", "git_show", "git_blame"].includes(value.action) && value.path === undefined) context.addIssue({ code: "custom", message: "path is required for git history inspection" });
  if (value.action === "git_show" && value.revision === undefined) context.addIssue({ code: "custom", message: "revision is required for git_show" });
  if (value.action !== "git_show" && value.revision !== undefined) context.addIssue({ code: "custom", message: "revision is only valid for git_show" });
  if (value.action !== "git_blame" && (value.start_line !== undefined || value.end_line !== undefined)) context.addIssue({ code: "custom", message: "line range is only valid for git_blame" });
});
export const EditInputSchema = z.object({ workspace_id: WorkspaceIdSchema, patch: z.string().min(1).max(1_048_576), preview: z.boolean().optional(), preview_id: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_hashes: z.record(z.string().min(1).max(4096), z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional() }).strict().superRefine((value, context) => {
  if (value.preview === true && value.preview_id !== undefined) context.addIssue({ code: "custom", message: "preview_id is only valid when applying a patch" });
});
export const ShellInputSchema = z.object({ workspace_id: WorkspaceIdSchema, command: z.string().min(1).max(8_192), request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).optional(), wait_ms: z.number().int().min(1).max(LOCAL_RUNNER_OPERATION_TIMEOUT_MS).optional(), background: z.boolean().optional() }).strict();
export const JobInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspace_id: WorkspaceIdSchema.optional(), status: JobStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("get"), job_id: JobIdSchema }).strict(),
  z.object({ action: z.literal("logs"), job_id: JobIdSchema, stream: z.enum(["stdout", "stderr"]).optional(), cursor: CursorSchema, offset: z.number().int().min(0).optional(), limit: BoundedLimitSchema, tail: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("cancel"), job_id: JobIdSchema }).strict(),
  z.object({ action: z.literal("input"), job_id: JobIdSchema, data: z.string().max(65_536).optional(), close_stdin: z.boolean().optional() }).strict().refine((value) => value.data !== undefined || value.close_stdin === true, "data or close_stdin is required"),
]);

const emptySchema = z.object({}).strict();
const runnerSelectSchema = z.object({ runner_id: RunnerIdSchema, confirm_switch: z.boolean().optional() }).strict();

export const TOOL_SPECS = {
  runner_list: { scope: "coding:read", description: "List runners this client can read, with safe IDs, display names, and last-known connection state. Credentials and workspace roots are never returned.", inputSchema: emptySchema, annotations: readAnnotations },
  runner_current: { scope: "coding:read", description: "Return this MCP client's sticky runner selection, or null. An unavailable selection never falls back to another runner.", inputSchema: emptySchema, annotations: readAnnotations },
  runner_select: { scope: "coding:read", description: "Select this MCP client's active runner. Initial selection is immediate; changing a selection requires confirm_switch=true.", inputSchema: runnerSelectSchema, annotations: writeAnnotations },
  workspace_list: { scope: "coding:read", description: "List readable workspace IDs on the active runner. Workspace roots are never returned.", inputSchema: emptySchema, annotations: readAnnotations },
  inspect: { scope: "coding:read", description: "Inspect a workspace with bounded list, search, stat, Git history, or layered diagnostics. This is read-only; workspace roots and host paths are never returned.", inputSchema: InspectInputSchema, annotations: readAnnotations },
  read: { scope: "coding:read", description: "Read a bounded UTF-8-safe page of a workspace-relative file. Use next_cursor or offset to continue; host roots and absolute paths are not accepted.", inputSchema: ReadInputSchema, annotations: readAnnotations },
  edit: { scope: "coding:write", description: "Preview or apply a transactional, baseline-checked patch to a writable workspace. The result contains only bounded, workspace-relative change metadata.", inputSchema: EditInputSchema, annotations: destructiveAnnotations },
  shell: { scope: "coding:exec", description: "Run a command through the selected runner's Host shell (Bash on Linux/macOS or PowerShell on Windows). Commands have the runner user's OS permissions and are not sandboxed; the workspace controls initial cwd and policy, not the Host shell root. Use a restricted VM/container and avoid administrator/root runners for untrusted code. background=true returns a persistent job immediately; foreground waits only up to wait_ms.", inputSchema: ShellInputSchema, annotations: execAnnotations },
  job: { description: "List, inspect, or read bounded logs for persistent jobs. cancel and input require coding:exec plus workspace job-control permission. Job metadata never includes command, cwd, PID, roots, or secrets.", inputSchema: JobInputSchema, annotations: mixedAnnotations },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOL_SPECS;
export const SafeOutputSchema = z.object({}).passthrough();

function isSafeRelativePath(value: string): boolean {
  return !value.includes("\0") && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..");
}
