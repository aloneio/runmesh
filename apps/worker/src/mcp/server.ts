import { McpServer, type AuthInfo, type ServerContext } from "@modelcontextprotocol/server";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@remote-coding-runtime/protocol";
import { z } from "zod";
import { internalHeaders, isSafeIdentifier } from "../security.js";
import type { ActiveRunnerContext, McpClientActiveRunner, McpRunnerSelectionResult } from "../registry.js";
import type { WorkerEnv } from "../runner-do.js";

const CONTENT_LIMIT = 32 * 1024;
const STRUCTURED_LIMIT = 64 * 1024;
const SUPPORTED_SCOPES = ["coding:read", "coding:write", "coding:exec"] as const;
type CodingScope = (typeof SUPPORTED_SCOPES)[number];

type ToolSpec = {
  readonly rpc?: string;
  readonly scope: CodingScope;
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

/** The complete public MCP catalog. Do not add aliases: these names are the API. */
const TOOL_SPECS = {
  runner_list: { scope: "coding:read", description: "List registered runners and their last known connection state. No runner credentials are returned; no selection is required.", annotations: readAnnotations },
  runner_current: { scope: "coding:read", description: "Return this MCP client's active runner selection, or null when no runner is selected. A revoked or deleted selection is reported unavailable without fallback.", annotations: readAnnotations },
  runner_select: { scope: "coding:read", description: "Select this MCP client's active runner. The first selection is immediate; changing it requires confirm_switch=true.", annotations: writeAnnotations },
  runner_info: { scope: "coding:read", description: "Return safe, last-known metadata for one runner. Metadata never contains workspace roots or credentials.", annotations: readAnnotations },
  workspace_list: { scope: "coding:read", description: "List the active runner's last synchronized workspace identifiers. Workspace roots are never exposed.", annotations: readAnnotations },
  env_info: { rpc: "env.info", scope: "coding:read", description: "Read bounded environment and workspace capability information from the active connected runner.", annotations: readAnnotations },
  fs_read: { rpc: "fs.read", scope: "coding:read", description: "Read a bounded UTF-8 byte range from a workspace-relative file on a connected runner.", annotations: readAnnotations },
  fs_list: { rpc: "fs.list", scope: "coding:read", description: "List a bounded page of a workspace-relative directory on a connected runner.", annotations: readAnnotations },
  fs_search: { rpc: "fs.search", scope: "coding:read", description: "Search bounded workspace-relative text files on a connected runner.", annotations: readAnnotations },
  fs_apply_patch: { rpc: "fs.apply_patch", scope: "coding:write", description: "Apply a transactional, baseline-checked patch to a writable workspace on a connected runner.", annotations: destructiveAnnotations },
  exec_start: { rpc: "exec.start", scope: "coding:exec", description: "Start a persistent local job and return its job metadata promptly. Use job_get and job_logs to observe it later.", annotations: execAnnotations },
  exec_run: { rpc: "exec.run", scope: "coding:exec", description: "Start a local job and wait only for the runner's short bounded completion window.", annotations: execAnnotations },
  job_list: { scope: "coding:read", description: "List bounded historical job metadata from the registry, including while a runner is offline.", annotations: readAnnotations },
  job_get: { rpc: "job.get", scope: "coding:read", description: "Get local job metadata; an offline runner may return its last synchronized snapshot instead.", annotations: readAnnotations },
  job_logs: { rpc: "job.logs", scope: "coding:read", description: "Read a bounded, paginated stdout or stderr log range from a connected runner.", annotations: readAnnotations },
  job_cancel: { rpc: "job.cancel", scope: "coding:exec", description: "Request cancellation of a local job on a connected runner.", annotations: destructiveAnnotations },
  job_input: { rpc: "job.input", scope: "coding:exec", description: "Write bounded UTF-8 input or EOF to a local running job on a connected runner.", annotations: writeAnnotations },
  git_status: { rpc: "git.status", scope: "coding:read", description: "Return bounded Git status for a workspace on a connected runner.", annotations: readAnnotations },
  git_diff: { rpc: "git.diff", scope: "coding:read", description: "Return a bounded Git diff for a workspace-relative path on a connected runner.", annotations: readAnnotations },
} as const satisfies Record<string, ToolSpec>;

type ToolName = keyof typeof TOOL_SPECS;

const RunnerIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe runner identifier");
const WorkspaceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe workspace identifier");
const RelativePathSchema = z.string().min(1).max(4096).refine(isSafeRelativePath, "must be a workspace-relative path without traversal");
const OptionalRelativePathSchema = z.string().min(1).max(4096).optional().refine((value) => value === undefined || isSafeRelativePath(value), "must be a workspace-relative path without traversal");
const CursorSchema = z.string().max(128).regex(/^\d+$/, "must be a numeric cursor").optional();
const BoundedLimitSchema = z.number().int().min(1).max(65_536).optional();
const RunnerInputSchema = z.object({ runner_id: RunnerIdSchema }).strict();
const JobIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe job identifier");

export type McpAuth = Pick<AuthInfo, "clientId" | "scopes" | "expiresAt" | "resource" | "extra"> & { token: string };

/**
 * Fresh server factory target for createMcpHandler. Every HTTP request receives
 * an isolated McpServer and the default stateless 2025 compatibility lane.
 */
export function createCodingMcpServer(env: WorkerEnv, auth: McpAuth): McpServer {
  const server = new McpServer({ name: "remote-coding-runtime", version: "0.1.0" });

  register(server, "runner_list", z.object({}).strict(), async () => runnerListTool(env));
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
  register(server, "runner_info", RunnerInputSchema, async ({ runner_id }) => registryTool(env, `/runners/${encodeURIComponent(runner_id)}`));

  register(server, "workspace_list", z.object({}).strict(), async () => activeRegistryTool(env, auth.clientId, (runnerId) => `/runners/${encodeURIComponent(runnerId)}/workspaces`));
  register(server, "env_info", z.object({}).strict(), async () => activeRunnerTool(env, auth.clientId, "env.info", {}));
  register(server, "fs_read", z.object({ workspace_id: WorkspaceIdSchema, path: RelativePathSchema, cursor: CursorSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(262_144).optional() }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "fs.read", boundedReadParams(params, 32 * 1024)));
  register(server, "fs_list", z.object({ workspace_id: WorkspaceIdSchema, path: OptionalRelativePathSchema, cursor: CursorSchema, limit: z.number().int().min(1).max(1_000).optional() }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "fs.list", params));
  register(server, "fs_search", z.object({ workspace_id: WorkspaceIdSchema, path: OptionalRelativePathSchema, query: z.string().min(1).max(1_024) }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "fs.search", params));
  register(server, "fs_apply_patch", z.object({ workspace_id: WorkspaceIdSchema, patch: z.string().min(1).max(1_048_576), expected_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), expected_hashes: z.record(z.string().min(1).max(4096), z.string().regex(/^[a-f0-9]{64}$/).nullable()).optional() }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "fs.apply_patch", params));
  register(server, "exec_start", z.object({ workspace_id: WorkspaceIdSchema, cwd: OptionalRelativePathSchema, command: z.union([z.string().min(1).max(8_192), z.array(z.string().min(1).max(8_192)).min(1).max(256)]), args: z.array(z.string().max(8_192)).max(256).optional(), shell: z.boolean().optional() }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "exec.start", { ...params, created_by_client_id: auth.clientId }));
  register(server, "exec_run", z.object({ workspace_id: WorkspaceIdSchema, cwd: OptionalRelativePathSchema, command: z.union([z.string().min(1).max(8_192), z.array(z.string().min(1).max(8_192)).min(1).max(256)]), args: z.array(z.string().max(8_192)).max(256).optional(), shell: z.boolean().optional(), wait_ms: z.number().int().min(1).max(LOCAL_RUNNER_OPERATION_TIMEOUT_MS).optional() }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "exec.run", { ...params, created_by_client_id: auth.clientId }));
  register(server, "job_list", z.object({ workspace_id: WorkspaceIdSchema.optional(), status: z.enum(["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), async (filters) => activeRegistryTool(env, auth.clientId, (runnerId) => registryJobsPath(runnerId, filters), true));
  register(server, "job_get", z.object({ job_id: JobIdSchema }).strict(), async ({ job_id }) => activeJobGet(env, auth.clientId, job_id));
  register(server, "job_logs", z.object({ job_id: JobIdSchema, stream: z.enum(["stdout", "stderr"]).optional(), cursor: CursorSchema, offset: z.number().int().min(0).optional(), limit: BoundedLimitSchema, tail: z.boolean().optional() }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "job.logs", boundedReadParams(params, 16 * 1024)));
  register(server, "job_cancel", z.object({ job_id: JobIdSchema }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "job.cancel", params));
  register(server, "job_input", z.object({ job_id: JobIdSchema, data: z.string().max(65_536).optional(), close_stdin: z.boolean().optional() }).strict().refine((value) => value.data !== undefined || value.close_stdin === true, "data or close_stdin is required"), async (params) => activeRunnerTool(env, auth.clientId, "job.input", params));
  register(server, "git_status", z.object({ workspace_id: WorkspaceIdSchema }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "git.status", params));
  register(server, "git_diff", z.object({ workspace_id: WorkspaceIdSchema, path: OptionalRelativePathSchema, staged: z.boolean().optional(), max_bytes: BoundedLimitSchema }).strict(), async (params) => activeRunnerTool(env, auth.clientId, "git.diff", params));

  return server;

  function register<Input extends z.ZodObject<z.ZodRawShape>>(target: McpServer, name: ToolName, inputSchema: Input, action: (input: z.output<Input>) => Promise<unknown>): void {
    const spec = TOOL_SPECS[name];
    (target.registerTool as unknown as (toolName: string, config: Record<string, unknown>, callback: (input: z.output<Input>, context: ServerContext) => Promise<unknown>) => unknown)(name, { description: spec.description, inputSchema, outputSchema: z.record(z.string(), z.unknown()), annotations: spec.annotations }, async (input, context) => {
      const contextAuth = context.http?.authInfo;
      // The protected handler injects AuthInfo. Captured auth is intentionally
      // a fallback for the stateless legacy lane, not a bearer-token parser.
      const scopes = contextAuth?.scopes ?? auth.scopes;
      if (!scopes.includes(spec.scope)) {
        return failure("insufficient_scope", `This tool requires ${spec.scope}.`, `Authorize the MCP client again with ${spec.scope}.`);
      }
      try {
        return await action(input as z.output<Input>);
      } catch {
        return failure("internal_error", "The MCP tool could not complete the request.", "Retry the request. If the problem persists, contact the service operator.");
      }
    });
  }
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

async function activeRunnerTool(env: WorkerEnv, clientId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const call = await callRunner(env, selected.value.runnerId, method, params);
  return call.ok ? runnerSuccess(call.value, selected.value) : runnerFailure(call.error, selected.value);
}

async function activeRegistryTool(env: WorkerEnv, clientId: string, path: (runnerId: string) => string, allowOfflineSnapshot = false): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, allowOfflineSnapshot);
  if (!selected.ok) return asToolResult(selected);
  const call = await registryCall(env, path(selected.value.runnerId));
  return call.ok ? runnerSuccess(call.value, selected.value) : runnerFailure(call.error, selected.value);
}

async function activeJobGet(env: WorkerEnv, clientId: string, jobId: string): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  if (selected.value.context.state !== "online") {
    const snapshot = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/jobs/${encodeURIComponent(jobId)}`);
    return snapshot.ok
      ? runnerSuccess({ ...(snapshot.value as Record<string, unknown>), source: "registry_snapshot", runner_state: "offline" }, selected.value)
      : snapshot.error.code === "not_found"
        ? runnerFailure(snapshot.error, selected.value)
        : runnerFailure(fail("runner_offline", "The selected runner is not connected.", "Confirm the selected runner is connected, then retry.").error, selected.value);
  }
  const live = await callRunner(env, selected.value.runnerId, "job.get", { job_id: jobId });
  if (live.ok || live.error.code !== "runner_offline") return live.ok ? runnerSuccess(live.value, selected.value) : runnerFailure(live.error, selected.value);
  const snapshot = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/jobs/${encodeURIComponent(jobId)}`);
  return snapshot.ok
    ? runnerSuccess({ ...(snapshot.value as Record<string, unknown>), source: "registry_snapshot", runner_state: "offline" }, selected.value)
    : runnerFailure(live.error, selected.value);
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
  "method_not_found", "patch_install_failed", "patch_rollback_failed", "path_traversal", "readonly_workspace", "runner_offline", "symlink_escape", "symlink_write", "target_exists", "timeout",
]);

function safeRunnerErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_RUNNER_ERROR_CODES.has(value) ? value : fallback;
}

async function callRunner(env: WorkerEnv, runnerId: string, method: string, params: Record<string, unknown>): Promise<ToolCall> {
  if (!isSafeIdentifier(runnerId)) return fail("invalid_runner_id", "runner_id is invalid", "Use a runner identifier returned by runner_list.");
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.INTERNAL_CONTROL_SECRET.length === 0) return fail("service_unavailable", "The runner bridge is not configured.", "Ask the service operator to configure the internal bridge.");
  const body = JSON.stringify({ method, params });
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

async function runnerListTool(env: WorkerEnv): Promise<unknown> {
  const call = await registryCall(env, "/runners");
  if (!call.ok) return asToolResult(call);
  const value = isRecord(call.value) && Array.isArray(call.value.runners) ? call.value.runners : [];
  const runners = value.filter(isRecord).map((runner) => {
    const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
    const displayName = typeof runner.display_name === "string" && runner.display_name.length > 0 ? runner.display_name : runnerId;
    const state = runner.state === "online" || runner.state === "offline" || runner.state === "stale" ? runner.state : "unavailable";
    return { runner_id: runnerId, display_name: displayName, state, available: state === "online", updated_at_ms: typeof runner.updated_at_ms === "number" ? runner.updated_at_ms : null };
  });
  return success({ runners });
}

async function registryTool(env: WorkerEnv, path: string): Promise<unknown> {
  return asToolResult(await registryCall(env, path));
}

async function registryCall(env: WorkerEnv, path: string): Promise<ToolCall> {
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.INTERNAL_CONTROL_SECRET.length === 0) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
  const [pathname] = path.split("?", 1);
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", pathname ?? path, "");
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
