import { McpServer, type AuthInfo, type ServerContext } from "@modelcontextprotocol/server";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import { z } from "zod";
import { internalHeaders, isSafeIdentifier } from "../security.js";
import type { ActiveRunnerContext, McpClientActiveRunner, McpRunnerSelectionResult } from "../registry.js";
import type { WorkerEnv } from "../runner-do.js";

const CONTENT_LIMIT = 32 * 1024;
const STRUCTURED_LIMIT = 64 * 1024;
const SUPPORTED_SCOPES = ["coding:read", "coding:write", "coding:exec"] as const;
type CodingScope = (typeof SUPPORTED_SCOPES)[number];

type ToolSpec = {
  readonly scope?: CodingScope;
  readonly description: string;
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
const mixedJobAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/**
 * The entire default public MCP API.  Runner RPC names below are intentionally
 * not aliases: they remain internal transport implementation details.
 */
const TOOL_SPECS = {
  runner_list: { scope: "coding:read", description: "List runners this client can read, with safe IDs, display names, and last-known connection state. Credentials and workspace roots are never returned.", annotations: readAnnotations },
  runner_current: { scope: "coding:read", description: "Return this MCP client's sticky runner selection, or null. An unavailable selection never falls back to another runner.", annotations: readAnnotations },
  runner_select: { scope: "coding:read", description: "Select this MCP client's active runner. Initial selection is immediate; changing a selection requires confirm_switch=true.", annotations: writeAnnotations },
  workspace_list: { scope: "coding:read", description: "List readable workspace IDs on the active runner. Workspace roots are never returned.", annotations: readAnnotations },
  inspect: { scope: "coding:read", description: "Inspect a workspace with bounded list, search, stat, git status, or git diff operations. This is read-only; workspace roots and host paths are never returned.", annotations: readAnnotations },
  read: { scope: "coding:read", description: "Read a bounded UTF-8-safe page of a workspace-relative file. Use next_cursor or offset to continue; host roots and absolute paths are not accepted.", annotations: readAnnotations },
  edit: { scope: "coding:write", description: "Apply a transactional, baseline-checked patch to a writable workspace. The result contains only bounded, workspace-relative change metadata.", annotations: destructiveAnnotations },
  shell: { scope: "coding:exec", description: "Run a command through the selected runner's Host shell (Bash on Linux/macOS or PowerShell on Windows). Commands have the runner user's OS permissions and are not sandboxed; the workspace controls initial cwd and policy, not the Host shell root. Use a restricted VM/container and avoid administrator/root runners for untrusted code. background=true returns a persistent job immediately; foreground waits only up to wait_ms.", annotations: execAnnotations },
  job: { description: "List, inspect, or read bounded logs for persistent jobs. cancel and input require coding:exec plus workspace job-control permission. Job metadata never includes command, cwd, PID, roots, or secrets.", annotations: mixedJobAnnotations },
} as const satisfies Record<string, ToolSpec>;

type ToolName = keyof typeof TOOL_SPECS;

const RunnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe runner identifier");
const WorkspaceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe workspace identifier");
const RelativePathSchema = z.string().min(1).max(4096).refine(isSafeRelativePath, "must be a workspace-relative path without traversal");
const CursorSchema = z.string().max(128).regex(/^\d+$/, "must be a numeric cursor").optional();
const BoundedLimitSchema = z.number().int().min(1).max(65_536).optional();
const JobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe job identifier");
const JobStatusSchema = z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"]);
const ReadInputSchema = z.object({ workspace_id: WorkspaceIdSchema, path: RelativePathSchema, cursor: CursorSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(262_144).optional() }).strict();
const InspectInputSchema = z.object({ action: z.enum(["list", "search", "stat", "git_status", "git_diff"]), workspace_id: WorkspaceIdSchema, path: RelativePathSchema.optional(), query: z.string().min(1).max(512).optional(), max_results: z.number().int().min(1).max(256).optional(), cursor: CursorSchema }).strict().superRefine((value, context) => {
  if ((value.action === "search" && value.query === undefined) || (value.action !== "search" && value.query !== undefined)) context.addIssue({ code: "custom", message: "query is only valid and required for search" });
  if (value.action === "stat" && value.path === undefined) context.addIssue({ code: "custom", message: "path is required for stat" });
});
const EditInputSchema = z.object({ workspace_id: WorkspaceIdSchema, patch: z.string().min(1).max(1_048_576), expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_hashes: z.record(z.string().min(1).max(4096), z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional() }).strict();
const ShellInputSchema = z.object({ workspace_id: WorkspaceIdSchema, command: z.string().min(1).max(8_192), wait_ms: z.number().int().min(1).max(LOCAL_RUNNER_OPERATION_TIMEOUT_MS).optional(), background: z.boolean().optional() }).strict();
const JobInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), workspace_id: WorkspaceIdSchema.optional(), status: JobStatusSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("get"), job_id: JobIdSchema }).strict(),
  z.object({ action: z.literal("logs"), job_id: JobIdSchema, stream: z.enum(["stdout", "stderr"]).optional(), cursor: CursorSchema, offset: z.number().int().min(0).optional(), limit: BoundedLimitSchema, tail: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("cancel"), job_id: JobIdSchema }).strict(),
  z.object({ action: z.literal("input"), job_id: JobIdSchema, data: z.string().max(65_536).optional(), close_stdin: z.boolean().optional() }).strict().refine((value) => value.data !== undefined || value.close_stdin === true, "data or close_stdin is required"),
]);

/** Structured output is always a bounded object; individual tool descriptions define its safe fields. */
const SafeOutputSchema = z.object({}).passthrough();

export type McpAuth = Pick<AuthInfo, "clientId" | "scopes" | "expiresAt" | "resource" | "extra"> & { token: string };

/**
 * Fresh server factory target for createMcpHandler. Every HTTP request receives
 * an isolated McpServer and the default stateless 2025 compatibility lane.
 */
export function createCodingMcpServer(env: WorkerEnv, auth: McpAuth): McpServer {
  const server = new McpServer({ name: "runmesh", version: "0.1.0-dev.1" });

  register(server, "runner_list", z.object({}).strict(), async () => gatedRunnerList(env, auth.clientId));
  register(server, "runner_current", z.object({}).strict(), async () => {
    const selection = await getActiveRunnerSelection(env, auth.clientId);
    if (selection.ok) {
      const current = selection.value as McpClientActiveRunner;
      return success({
        active_runner_id: current.active_runner_id,
        active_runner_updated_at_ms: current.active_runner_updated_at_ms,
        active_runner: current.runner,
      });
    }
    return asToolResult(selection);
  });
  register(server, "runner_select", z.object({ runner_id: RunnerIdSchema, confirm_switch: z.boolean().optional() }).strict(), async ({ runner_id, confirm_switch }) => {
    const selection = await selectActiveRunner(env, auth.clientId, runner_id, confirm_switch === true);
    if (selection.ok) {
      const result = selection.value as { selection: McpClientActiveRunner; changed: boolean };
      return success({ ...result.selection, changed: result.changed });
    }
    if (selection.error.code === "runner_switch_confirmation_required") {
      const current = selection.error.details;
      return failureWithDetails(selection.error.code, selection.error.message, selection.error.hint, current === undefined ? {} : { current_active_runner: current });
    }
    return asToolResult(selection);
  });
  register(server, "workspace_list", z.object({}).strict(), async () => activeWorkspaceList(env, auth.clientId));
  register(server, "inspect", InspectInputSchema, async (params) => inspectTool(env, auth.clientId, params));
  register(server, "read", ReadInputSchema, async (params) => activeRunnerTool(env, auth.clientId, "fs.read", boundedReadParams(params, 32 * 1024), "read"));
  register(server, "edit", EditInputSchema, async (params) => activeRunnerTool(env, auth.clientId, "fs.apply_patch", params, "edit"));
  register(server, "shell", ShellInputSchema, async (params) => shellTool(env, auth.clientId, params));
  register(server, "job", JobInputSchema, async (params, scopes) => jobTool(env, auth.clientId, params, scopes));

  return server;

  function register<Input extends z.ZodType>(target: McpServer, name: ToolName, inputSchema: Input, action: (input: z.output<Input>, scopes: readonly string[]) => Promise<unknown>): void {
    const spec = TOOL_SPECS[name];
    (target.registerTool as unknown as (toolName: string, config: Record<string, unknown>, callback: (input: z.output<Input>, context: ServerContext) => Promise<unknown>) => unknown)(name, { description: spec.description, inputSchema, outputSchema: SafeOutputSchema, annotations: spec.annotations }, async (input, context) => {
      const contextAuth = context.http?.authInfo;
      // The protected handler injects AuthInfo. Captured auth is intentionally
      // a fallback for the stateless legacy lane, not a bearer-token parser.
      const scopes = contextAuth?.scopes ?? auth.scopes;
      const requiredScope = "scope" in spec ? spec.scope : undefined;
      if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
        return failure("insufficient_scope", `This tool requires ${requiredScope}.`, `Authorize the MCP client again with ${requiredScope}.`);
      }
      try {
        return await action(input as z.output<Input>, scopes);
      } catch {
        return failure("internal_error", "The MCP tool could not complete the request.", "Retry the request. If the problem persists, contact the service operator.");
      }
    });
  }
}

async function inspectTool(env: WorkerEnv, clientId: string, params: z.output<typeof InspectInputSchema>): Promise<unknown> {
  const method = params.action === "list" ? "fs.list" : params.action === "search" ? "fs.search" : params.action === "stat" ? "fs.stat" : params.action === "git_status" ? "git.status" : "git.diff";
  const input: Record<string, unknown> = {
    workspace_id: params.workspace_id,
    ...(params.path === undefined ? {} : { path: params.path }),
    ...(params.query === undefined ? {} : { query: params.query }),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    ...(params.action === "list" && params.max_results !== undefined ? { limit: params.max_results } : {}),
    ...(params.action === "search" && params.max_results !== undefined ? { max_results: params.max_results } : {}),
    ...(params.action === "git_diff" ? { max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_status" ? { max_bytes: 32 * 1024 } : {}),
  };
  return activeRunnerTool(env, clientId, method, input, "read");
}
async function shellTool(env: WorkerEnv, clientId: string, params: z.output<typeof ShellInputSchema>): Promise<unknown> {
  const invocation = { workspace_id: params.workspace_id, command: params.command, shell: true, created_by_client_id: clientId };
  if (params.background === true) return activeRunnerTool(env, clientId, "exec.start", invocation, "shell");
  const result = await activeRunnerTool(env, clientId, "exec.run", { ...invocation, ...(params.wait_ms === undefined ? {} : { wait_ms: params.wait_ms }) }, "shell");
  return normalizeShellResult(result);
}

function normalizeShellResult(result: unknown): unknown {
  if (!isToolSuccessResult(result)) return result;
  const value = result.structuredContent;
  if (!isRecord(value.job)) return result;
  const { job, ...rest } = value;
  return success({ ...rest, ...safeJobMetadata(job), status: typeof job.status === "string" ? job.status : "unknown" });
}

async function jobTool(env: WorkerEnv, clientId: string, params: z.output<typeof JobInputSchema>, scopes: readonly string[]): Promise<unknown> {
  switch (params.action) {
    case "list":
      if (!scopes.includes("coding:read")) return failure("insufficient_scope", "This job action requires coding:read.", "Authorize the MCP client again with coding:read.");
      return activeJobList(env, clientId, params);
    case "get":
      if (!scopes.includes("coding:read")) return failure("insufficient_scope", "This job action requires coding:read.", "Authorize the MCP client again with coding:read.");
      return activeJobGet(env, clientId, params.job_id);
    case "logs":
      if (!scopes.includes("coding:read")) return failure("insufficient_scope", "This job action requires coding:read.", "Authorize the MCP client again with coding:read.");
      return activeJobRunnerTool(env, clientId, "job.logs", boundedReadParams(params, 16 * 1024), "read");
    case "cancel":
      if (!scopes.includes("coding:exec")) return failure("insufficient_scope", "This job action requires coding:exec.", "Authorize the MCP client again with coding:exec.");
      return activeJobRunnerTool(env, clientId, "job.cancel", params, "job_control");
    case "input":
      if (!scopes.includes("coding:exec")) return failure("insufficient_scope", "This job action requires coding:exec.", "Authorize the MCP client again with coding:exec.");
      return activeJobRunnerTool(env, clientId, "job.input", params, "job_control");
  }
}

function isToolSuccessResult(value: unknown): value is { readonly structuredContent: Record<string, unknown> } {
  return isRecord(value) && value.isError !== true && isRecord(value.structuredContent);
}

function safeJobMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  for (const key of ["job_id", "workspace_id", "status", "created_at_ms", "started_at_ms", "updated_at_ms", "completed_at_ms", "exit_code", "signal", "recovery_note", "output_truncated", "cancellation_delivered_at_ms"]) {
    if (value[key] !== undefined) output[key] = value[key];
  }
  return output;
}

type ActiveSelection = {
  readonly runnerId: string;
  readonly context: ActiveRunnerContext & { readonly automatic_selection: boolean };
};
type SelectionCall = ToolSuccess | ToolFailure;
type ActiveSelectionCall = { readonly ok: true; readonly value: ActiveSelection } | ToolFailure;

async function getActiveRunnerSelection(env: WorkerEnv, clientId: string): Promise<SelectionCall> {
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`);
  if (!call.ok) return call;
  return { ok: true, value: call.value as McpClientActiveRunner };
}

async function selectActiveRunner(env: WorkerEnv, clientId: string, runnerId: string, confirmSwitch: boolean): Promise<SelectionCall> {
  const call = await registryPostCall(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`, { runner_id: runnerId, confirm_switch: confirmSwitch });
  if (call.ok) {
    const result = call.value as McpRunnerSelectionResult;
    if (result.ok) return { ok: true, value: result };
    if (result.code === "runner_switch_confirmation_required") return failWithDetails(result.code, "Switching the active runner requires confirmation.", "Retry with confirm_switch=true to switch runners.", result.selection);
    return fail(result.code, "The runner selection could not be changed.", "Call runner_list and choose an available runner.");
  }
  return call;
}

async function resolveActiveRunner(env: WorkerEnv, clientId: string, allowOfflineSnapshot = false): Promise<ActiveSelectionCall> {
  const initial = await getActiveRunnerSelection(env, clientId);
  if (!initial.ok) return initial;
  let state = initial.value as McpClientActiveRunner;
  let automatic = false;
  if (state.active_runner_id === null) {
    const runners = await registryCall(env, "/runners");
    if (!runners.ok) return runners;
    const list = isRecord(runners.value) && Array.isArray(runners.value.runners) ? runners.value.runners : [];
    if (list.length === 0) {
      return fail("no_runners_available", "No registered runners are available.", "Register a runner, then call runner_list and runner_select.");
    }
    if (list.length !== 1 || !isRecord(list[0]) || typeof list[0].runner_id !== "string") {
      return fail("runner_not_selected", "No active runner is selected.", "Call runner_list, then runner_select with the desired runner_id.");
    }
    const selected = await selectActiveRunner(env, clientId, list[0].runner_id, false);
    if (!selected.ok) return selected;
    state = (selected.value as { selection: McpClientActiveRunner }).selection;
    automatic = true;
  }
  const context = state.runner;
  if (context === null || context.state === "unavailable") {
    return failWithDetails("runner_unavailable", "The selected runner is unavailable.", "Call runner_current to inspect the selection; select another runner explicitly if needed.", { runner_context: { ...(context ?? { runner_id: state.active_runner_id, state: "unavailable", available: false, updated_at_ms: state.active_runner_updated_at_ms }), automatic_selection: automatic } });
  }
  if (context.state !== "online" && !allowOfflineSnapshot) {
    return failWithDetails("runner_offline", "The selected runner is not connected.", "Confirm the selected runner is connected, then retry.", { runner_context: { ...context, automatic_selection: automatic } });
  }
  return { ok: true, value: { runnerId: context.runner_id, context: { ...context, automatic_selection: automatic } } };
}

function runnerSuccess(value: unknown, selection: ActiveSelection): unknown {
  if (isRecord(value)) return success({ ...value, runner_context: selection.context });
  return success({ data: value, runner_context: selection.context });
}
function runnerFailure(error: ToolFailure["error"], selection: ActiveSelection): unknown {
  return failureWithDetails(error.code, error.message, error.hint, { runner_context: selection.context });
}

async function activeRunnerTool(env: WorkerEnv, clientId: string, method: string, params: Record<string, unknown>, requiredPermission?: PermissionBit): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const permission = requiredPermission === undefined
    ? undefined
    : params.workspace_id === undefined
      ? await checkAnyReadPermission(env, clientId, selected.value.runnerId)
      : await checkPermission(env, clientId, selected.value.runnerId, params.workspace_id, requiredPermission);
  if (permission !== undefined) return asToolResult(permission);
  const revisionCall = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/policy-revision`);
  const revision = policyRevision(revisionCall);
  if (revision === undefined) return asToolResult(policyPending());
  const call = await callRunner(env, selected.value.runnerId, method, params, revision);
  return call.ok ? runnerSuccess(call.value, selected.value) : runnerFailure(call.error, selected.value);
}

async function activeJobRunnerTool(env: WorkerEnv, clientId: string, method: string, params: Record<string, unknown>, requiredPermission: PermissionBit): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const job = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/jobs/${encodeURIComponent(String(params.job_id))}`);
  if (!job.ok) return runnerFailure(job.error, selected.value);
  const workspaceId = isRecord(job.value) && typeof job.value.workspace_id === "string" ? job.value.workspace_id : undefined;
  const permission = await checkPermission(env, clientId, selected.value.runnerId, workspaceId, requiredPermission);
  if (permission !== undefined) return asToolResult(permission);
  const revisionCall = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/policy-revision`);
  const revision = policyRevision(revisionCall);
  if (revision === undefined) return asToolResult(policyPending());
  const call = await callRunner(env, selected.value.runnerId, method, params, revision);
  return call.ok ? runnerSuccess(call.value, selected.value) : runnerFailure(call.error, selected.value);
}

async function activeJobList(env: WorkerEnv, clientId: string, filters: Record<string, unknown>): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  if (filters.workspace_id !== undefined) {
    const permission = await checkPermission(env, clientId, selected.value.runnerId, filters.workspace_id, "read");
    if (permission !== undefined) return asToolResult(permission);
  } else {
    const permission = await checkAnyReadPermission(env, clientId, selected.value.runnerId);
    if (permission !== undefined) return asToolResult(permission);
  }
  const call = await registryCall(env, registryJobsPath(selected.value.runnerId, filters));
  if (!call.ok) return runnerFailure(call.error, selected.value);
  const value = isRecord(call.value) ? call.value : {};
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  const visible: unknown[] = [];
  for (const job of jobs) {
    const workspaceId = isRecord(job) ? job.workspace_id : undefined;
    if (await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read") === undefined) visible.push(job);
  }
  return runnerSuccess({ ...value, jobs: visible }, selected.value);
}

async function activeWorkspaceList(env: WorkerEnv, clientId: string): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const call = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/workspaces`);
  if (!call.ok) return runnerFailure(call.error, selected.value);
  const value = isRecord(call.value) ? call.value : {};
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : [];
  const visible: unknown[] = [];
  for (const workspace of workspaces) {
    const workspaceId = isRecord(workspace) ? workspace.workspace_id : undefined;
    if (await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read") === undefined) visible.push(workspace);
  }
  return runnerSuccess({ ...value, workspaces: visible }, selected.value);
}
type PermissionCheck = ToolFailure;
async function checkPermission(env: WorkerEnv, clientId: string, runnerId: string, workspaceId: unknown, required: PermissionBit): Promise<PermissionCheck | undefined> {
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return fail("permission_denied", "Workspace permission could not be resolved.", "Use a workspace identifier managed by the administrator.");
  const readiness = await policyReadiness(env, runnerId);
  if (!readiness.ok) return readiness.error;
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-permissions/${encodeURIComponent(runnerId)}?workspace_id=${encodeURIComponent(workspaceId)}`);
  if (!call.ok) return fail("permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.");
  const permissions = isRecord(call.value) && isRecord(call.value.permissions) ? call.value.permissions : undefined;
  if (permissions?.[required] !== true) return fail(required === "edit" ? "readonly_workspace" : "permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.");
  return undefined;
}
async function policyReadiness(env: WorkerEnv, runnerId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: PermissionCheck }> {
  const readiness = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}`);
  if (!readiness.ok) return { ok: false, error: fail("permission_denied", "The selected runner policy could not be verified.", "Wait for the runner to reconnect and apply the latest control-plane policy.") };
  const runner = isRecord(readiness.value) ? readiness.value : undefined;
  const desired = runner?.desired_policy_revision;
  const applied = runner?.applied_policy_revision;
  const status = runner?.policy_status;
  if (typeof desired === "number" && desired > 0 && (status !== "applied" || applied !== desired)) return { ok: false, error: fail("policy_pending", "The selected runner has not applied the latest policy.", "The control plane has a newer policy than the runner. Wait briefly and retry.") };
  return { ok: true };
}

async function checkAnyReadPermission(env: WorkerEnv, clientId: string, runnerId: string): Promise<PermissionCheck | undefined> {
  const managed = await registryCall(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces`);
  const managedWorkspaces = managed.ok && isRecord(managed.value) && Array.isArray(managed.value.workspaces) ? managed.value.workspaces : [];
  const readiness = await policyReadiness(env, runnerId);
  if (!readiness.ok) return readiness.error;
  if (managedWorkspaces.length > 0) {
    for (const item of managedWorkspaces) {
      if (!isRecord(item) || typeof item.workspace_id !== "string") continue;
      if (await checkPermission(env, clientId, runnerId, item.workspace_id, "read") === undefined) return undefined;
    }
  } else {
    const synced = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/workspaces`);
    if (!synced.ok || !isRecord(synced.value) || !Array.isArray(synced.value.workspaces)) return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
    for (const item of synced.value.workspaces) {
      if (!isRecord(item) || typeof item.workspace_id !== "string") continue;
      if (await checkPermission(env, clientId, runnerId, item.workspace_id, "read") === undefined) return undefined;
    }
  }
  return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
}

async function gatedRunnerList(env: WorkerEnv, clientId: string): Promise<unknown> {
  const call = await registryCall(env, "/runners");
  if (!call.ok) return asToolResult(call);
  const runners = isRecord(call.value) && Array.isArray(call.value.runners) ? call.value.runners : [];
  const visible: unknown[] = [];
  for (const runner of runners) {
    if (!isRecord(runner) || typeof runner.runner_id !== "string") continue;
    if (await checkAnyReadPermission(env, clientId, runner.runner_id) === undefined) visible.push(runner);
  }
  return runnerListToolValue(visible);
}
type PermissionBit = "read" | "edit" | "shell" | "job_control";

async function activeJobGet(env: WorkerEnv, clientId: string, jobId: string): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  const snapshot = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/jobs/${encodeURIComponent(jobId)}`);
  if (!snapshot.ok) return runnerFailure(snapshot.error, selected.value);
  const workspaceId = isRecord(snapshot.value) && typeof snapshot.value.workspace_id === "string" ? snapshot.value.workspace_id : undefined;
  const permission = await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read");
  if (permission !== undefined) return asToolResult(permission);
  if (selected.value.context.state !== "online") return runnerSuccess({ ...(snapshot.value as Record<string, unknown>), source: "registry_snapshot", runner_state: "offline" }, selected.value);
  const revisionCall = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/policy-revision`);
  const revision = policyRevision(revisionCall);
  if (revision === undefined) return runnerFailure(policyPending().error, selected.value);
  const live = await callRunner(env, selected.value.runnerId, "job.get", { job_id: jobId }, revision);
  if (live.ok || live.error.code !== "runner_offline") return live.ok ? runnerSuccess(live.value, selected.value) : runnerFailure(live.error, selected.value);
  return runnerSuccess({ ...(snapshot.value as Record<string, unknown>), source: "registry_snapshot", runner_state: "offline" }, selected.value);
}

function isSafeRelativePath(value: string): boolean {
  // Reject POSIX absolute, Windows drive-qualified, and UNC/device paths at
  // the MCP boundary before they reach a runner on another platform.
  return !value.includes("\0") && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..");
}

function boundedReadParams(params: Record<string, unknown>, max: number): Record<string, unknown> {
  const requested = typeof params.limit === "number" ? params.limit : max;
  return { ...params, limit: Math.min(requested, max) };
}

type ToolSuccess = { readonly ok: true; readonly value: unknown };
type ToolFailure = { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly hint: string; readonly details?: unknown } };
type ToolCall = ToolSuccess | ToolFailure;

const SAFE_RUNNER_ERROR_CODES = new Set([
  "baseline_changed", "busy", "expected_hash_mismatch", "file_too_large", "git_failed", "git_output_too_large", "git_timeout", "git_unavailable",
  "hunk_ambiguous", "hunk_not_found", "hunk_overlap", "invalid_params", "invalid_patch", "invalid_path", "invalid_request", "invalid_workspace", "missing_file", "mixed_newlines", "not_utf8",
  "method_not_found", "patch_install_failed", "patch_rollback_failed", "path_traversal", "permission_denied", "policy_pending", "readonly_workspace", "runner_offline", "stale_policy", "symlink_escape", "symlink_write", "target_exists", "timeout",
]);

export function policyPending(): ToolFailure {
  return fail("policy_pending", "The selected runner has not applied the latest policy.", "Wait for the runner to apply its control-plane policy, then retry.") as ToolFailure;
}

function policyRevision(call: ToolCall): number | undefined {
  if (!call.ok || !isRecord(call.value)) return undefined;
  const revision = call.value.applied_policy_revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 && revision === call.value.desired_policy_revision && call.value.policy_status === "applied" ? revision : undefined;
}

function safeRunnerErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_RUNNER_ERROR_CODES.has(value) ? value : fallback;
}

async function callRunner(env: WorkerEnv, runnerId: string, method: string, params: Record<string, unknown>, policyRevision?: number): Promise<ToolCall> {
  if (!isSafeIdentifier(runnerId)) return fail("invalid_runner_id", "runner_id is invalid", "Use a runner identifier returned by runner_list.");
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.INTERNAL_CONTROL_SECRET.length === 0) return fail("service_unavailable", "The runner bridge is not configured.", "Ask the service operator to configure the internal bridge.");
  if (policyRevision === undefined && method !== "echo" && method !== "runner.info") return fail("policy_pending", "The selected runner policy could not be verified.", "Wait for the runner to apply its control-plane policy, then retry.");
  const body = JSON.stringify({ method, params, ...(policyRevision === undefined ? {} : { policy_revision: policyRevision }) });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", "/rpc", body);
  let response: Response;
  try {
    response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
  } catch {
    return fail("runner_offline", "The runner is not reachable.", "Confirm the runner is connected, then retry.");
  }
  const payload = await json(response);
  if (isRecord(payload) && payload.type === "rpc.response") return { ok: true, value: payload.result };
  const bridgeError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const code = safeRunnerErrorCode(bridgeError?.code, response.status === 503 ? "runner_offline" : "runner_rpc_failed");
  // Runner error details can include host filesystem paths. MCP exposes stable
  // error codes plus a safe recovery action rather than copying that text.
  const message = code === "runner_offline" ? "The runner is not connected." : "The runner rejected the request.";
  return fail(code, message, hintFor(code));
}

function registryJobsPath(runnerId: string, filters: Record<string, unknown>): string {
  const query = new URLSearchParams();
  if (typeof filters.workspace_id === "string") query.set("workspace_id", filters.workspace_id);
  if (typeof filters.status === "string") query.set("status", filters.status);
  if (typeof filters.limit === "number") query.set("limit", String(filters.limit));
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `/runners/${encodeURIComponent(runnerId)}/jobs${suffix}`;
}

function runnerListToolValue(value: readonly unknown[]): unknown {
  const runners = value.filter(isRecord).map((runner) => {
    const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
    const displayName = typeof runner.display_name === "string" && runner.display_name.length > 0 ? runner.display_name : runnerId;
    const state = runner.state === "online" || runner.state === "offline" || runner.state === "stale" ? runner.state : "unavailable";
    return { runner_id: runnerId, display_name: displayName, state, available: state === "online", updated_at_ms: typeof runner.updated_at_ms === "number" ? runner.updated_at_ms : null };
  });
  return success({ runners });
}

async function registryCall(env: WorkerEnv, path: string): Promise<ToolCall> {
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.INTERNAL_CONTROL_SECRET.length === 0) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", path, "");
  try {
    const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "GET", headers }));
    const value = await json(response);
    if (response.ok) return { ok: true, value };
    return fail(response.status === 404 ? "not_found" : "registry_unavailable", response.status === 404 ? "The requested registry record was not found." : "The registry is unavailable.", response.status === 404 ? "Use runner_list to discover valid identifiers." : "Retry shortly; the runner may still be available for live tools.");
  } catch {
    return fail("registry_unavailable", "The registry is unavailable.", "Retry shortly; the runner may still be available for live tools.");
  }
}

async function registryPostCall(env: WorkerEnv, path: string, input: Record<string, unknown>): Promise<ToolCall> {
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.INTERNAL_CONTROL_SECRET.length === 0) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
  const body = JSON.stringify(input);
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body);
  try {
    const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body }));
    const value = await json(response);
    if (isRecord(value) && typeof value.code === "string") return { ok: true, value };
    if (response.ok || response.status === 409) return { ok: true, value };
    return fail(response.status === 404 ? "not_found" : "registry_unavailable", "The registry is unavailable.", "Retry shortly.");
  } catch { return fail("registry_unavailable", "The registry is unavailable.", "Retry shortly."); }
}
function asToolResult(call: ToolCall): unknown {
  return call.ok ? success(call.value) : call.error.details === undefined
    ? failure(call.error.code, call.error.message, call.error.hint)
    : failureWithDetails(call.error.code, call.error.message, call.error.hint, call.error.details);
}

function success(value: unknown): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> } {
  const safe = redactAndBound(value, STRUCTURED_LIMIT);
  const structuredContent = isRecord(safe) ? safe : { data: safe };
  return { content: [{ type: "text", text: boundedText(structuredContent, CONTENT_LIMIT) }], structuredContent };
}

function failure(code: string, message: string, hint: string): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError: true } {
  const error = { error: { code, message: message.slice(0, 4_096), recovery_hint: hint.slice(0, 4_096) } };
  return { content: [{ type: "text", text: `Error (${code}): ${error.error.message}\nRecovery: ${error.error.recovery_hint}` }], structuredContent: error, isError: true };
}

function failureWithDetails(code: string, message: string, hint: string, details: unknown): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError: true } {
  const error = { error: { code, message: message.slice(0, 4_096), recovery_hint: hint.slice(0, 4_096), details: redactAndBound(details, 8_192) } };
  return { content: [{ type: "text", text: `Error (${code}): ${error.error.message}\nRecovery: ${error.error.recovery_hint}` }], structuredContent: error, isError: true };
}

function failWithDetails(code: string, message: string, hint: string, details: unknown): ToolFailure { return { ok: false, error: { code, message, hint, details } }; }
function fail(code: string, message: string, hint: string): ToolFailure { return { ok: false, error: { code, message, hint } }; }
function hintFor(code: string): string {
  if (code === "runner_offline" || code === "timeout") return "Confirm the runner is connected, then retry.";
  if (code === "policy_pending") return "The control plane has a newer policy than the runner. Wait briefly and retry.";
  if (code === "invalid_patch") return "Use the documented *** Begin Patch envelope and exact, non-overlapping hunks.";
  if (code === "missing_file") return "Choose an existing source file or use Add File for a new target.";
  if (code === "target_exists") return "Choose a new target path or update the existing file instead.";
  if (code === "baseline_changed" || code === "expected_hash_mismatch") return "Re-read the affected files and retry with current expected hashes.";
  if (code === "hunk_not_found" || code === "hunk_ambiguous" || code === "hunk_overlap") return "Re-read the file and submit an exact, unambiguous, non-overlapping hunk.";
  if (code === "patch_install_failed" || code === "patch_rollback_failed") return "Inspect workspace state, then retry a smaller patch; no host paths were exposed.";
  if (code === "file_too_large" || code === "not_utf8" || code === "mixed_newlines") return "Use a supported bounded UTF-8 text file or split the change.";
  if (code === "path_traversal" || code === "invalid_path") return "Use a workspace-relative path without .. segments or an absolute path.";
  if (code === "busy") return "Wait for active runner requests to complete, then retry.";
  if (code === "method_not_found") return "Update the runner to a version that supports this tool.";
  return "Correct the request parameters and retry.";
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedText(value: unknown, max: number): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length <= max ? text : `${text.slice(0, max)}\n… truncated by MCP response limit`;
}
function redactAndBound(value: unknown, max: number): unknown {
  const redacted = redact(value, new WeakSet());
  const serialized = JSON.stringify(redacted) ?? "null";
  if (serialized.length <= max) return redacted;
  return { truncated: true, data: serialized.slice(0, max), recovery_hint: "Use the tool's cursor, offset, or limit fields to paginate." };
}
function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (!isRecord(value) || seen.has(value)) return "[unavailable]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|secret|password|verifier|root|cwd|command|pid|process_start_fingerprint|recovery_liveness)/i.test(key)) continue;
    output[key] = redact(item, seen);
  }
  return output;
}

export const MCP_TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));
export const MCP_SUPPORTED_SCOPES = SUPPORTED_SCOPES;
