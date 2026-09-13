import { McpServer, type AuthInfo, type ServerContext } from "@modelcontextprotocol/server";
import {
  encodeWireFrame, PROTOCOL_CURRENT_VERSION, failureMetadata, type JsonValue, RpcRequestSchema,
} from "@aloneio/runmesh-protocol";
import { z } from "zod";
import { internalHeaders, isSafeIdentifier, isConfiguredSecret } from "../security.js";
import type { ActiveRunnerContext, McpClientActiveRunner, McpRunnerSelectionResult, PolicyReadiness as RegistryPolicyReadiness } from "../registry.js";
import type { WorkerEnv } from "../runner-do.js";
import { PRODUCT_VERSION } from "../generated-version.js";
import { ContextInputSchema, EditInputSchema, InspectInputSchema, JobInputSchema, SafeOutputSchema, ShellInputSchema, SUPPORTED_SCOPES, TOOL_SPECS, type CodingScope, type ToolName } from "./catalog.js";

const CONTENT_LIMIT = 32 * 1024;
const STRUCTURED_LIMIT = 64 * 1024;
const utf8Encoder = new TextEncoder();

export type McpAuth = AuthInfo & { token: string };
// Captured once per handler instance; never stored in shared Worker globals.
type McpRequestEnv = WorkerEnv & { readonly mcpPrincipal: { readonly client_id: string; readonly secret_version: unknown } };

/**
 * Fresh server factory target for createMcpHandler. Every HTTP request receives
 * an isolated McpServer and the default stateless 2025 compatibility lane.
 */
export function createCodingMcpServer(rawEnv: WorkerEnv, auth: McpAuth): McpServer {
  const env: McpRequestEnv = { ...rawEnv, mcpPrincipal: { client_id: auth.clientId, secret_version: auth.extra?.secret_version } };
  const server = new McpServer({ name: "runmesh", version: PRODUCT_VERSION });

  register(server, "runner_list", async () => gatedRunnerList(env, auth.clientId));
  register(server, "runner_current", async () => {
    const selection = await getActiveRunnerSelection(env, auth.clientId);
    if (selection.ok) {
      const current = selection.value as McpClientActiveRunner;
      return success(safeSelectionValue(current));
    }
    return asToolResult(selection);
  });
  register(server, "runner_select", async ({ runner_id, confirm_switch }) => {
    const selection = await selectActiveRunner(env, auth.clientId, runner_id, confirm_switch === true);
    if (selection.ok) {
      const result = selection.value as { selection: McpClientActiveRunner; changed: boolean };
      return success({ ...safeSelectionValue(result.selection), changed: result.changed });
    }
    if (selection.error.code === "runner_switch_confirmation_required") {
      const current = selection.error.details;
      return failureWithDetails(selection.error.code, selection.error.message, selection.error.hint, current === undefined ? {} : { current_active_runner: safeSelectionValue(current) });
    }
    return asToolResult(selection);
  });
  register(server, "workspace_list", async () => activeWorkspaceList(env, auth.clientId));
  register(server, "inspect", async (params) => inspectTool(env, auth.clientId, params));
  register(server, "read", async (params) => activeRunnerTool(env, auth.clientId, "fs.read", boundedReadParams(params, 32 * 1024), "read", "read"));
  register(server, "edit", async (params) => editTool(env, auth.clientId, params));
  register(server, "shell", async (params) => shellTool(env, auth.clientId, params));
  register(server, "job", async (params, scopes) => jobTool(env, auth.clientId, params, scopes));
  register(server, "context", async (params, scopes) => contextTool(env, auth.clientId, params, scopes));

  return server;

  function register<Name extends ToolName>(target: McpServer, name: Name, action: (input: z.output<(typeof TOOL_SPECS)[Name]["inputSchema"]>, scopes: readonly string[]) => Promise<unknown>): void {
    const spec = TOOL_SPECS[name];
    type Input = z.output<(typeof TOOL_SPECS)[Name]["inputSchema"]>;
    (target.registerTool as unknown as (toolName: string, config: Record<string, unknown>, callback: (input: Input, context: ServerContext) => Promise<unknown>) => unknown)(name, { description: spec.description, inputSchema: spec.inputSchema, outputSchema: SafeOutputSchema, annotations: spec.annotations }, async (input, _context) => {
      // The URL credential can be rotated while a body or SDK import is
      // awaited. Re-read the exact generation and scopes before every tool.
      const live = await registryPostCall(env, "/auth/mcp/revalidate", env.mcpPrincipal);
      if (!live.ok || !isRecord(live.value) || live.value.client_id !== auth.clientId || live.value.secret_version !== env.mcpPrincipal.secret_version || !Array.isArray(live.value.scopes) || live.value.scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope as CodingScope))) {
        return failure("permission_denied", "The MCP credential is no longer authorized.", "Use the currently authorized MCP connection; do not retry a revoked URL.");
      }
      const scopes = live.value.scopes as string[];
      const requiredScope = "scope" in spec ? spec.scope : undefined;
      if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
        return failure("insufficient_scope", `This tool requires ${requiredScope}.`, `Authorize the MCP client again with ${requiredScope}.`);
      }
      try {
        return await action(input, scopes);
      } catch {
        return failure("internal_error", "The MCP tool could not complete the request.", "Retry the request. If the problem persists, contact the service operator.");
      }
    });
  }
}

async function inspectTool(env: McpRequestEnv, clientId: string, params: z.output<typeof InspectInputSchema>): Promise<unknown> {
  if (params.action === "diagnostics") return diagnosticsTool(env, clientId, params.workspace_id);
  const method = params.action === "list" ? "fs.list" : params.action === "search" ? "fs.search" : params.action === "stat" ? "fs.stat" : params.action === "git_status" ? "git.status" : params.action === "git_diff" ? "git.diff" : params.action === "git_log" ? "git.log" : params.action === "git_show" ? "git.show" : "git.blame";
  const input: Record<string, unknown> = {
    workspace_id: params.workspace_id,
    ...(params.path === undefined ? {} : { path: params.path }),
    ...(params.action === "git_show" ? { revision: params.revision } : {}),
    ...(params.action === "git_blame" ? { start_line: params.start_line, end_line: params.end_line } : {}),
    ...(params.query === undefined ? {} : { query: params.query }),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    ...(params.action !== "search" || params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.action !== "search" || params.case_sensitive === undefined ? {} : { case_sensitive: params.case_sensitive }),
    ...(params.action !== "search" || params.include_globs === undefined ? {} : { include_globs: params.include_globs }),
    ...(params.action !== "search" || params.exclude_globs === undefined ? {} : { exclude_globs: params.exclude_globs }),
    ...(params.action !== "search" || params.context_before === undefined ? {} : { context_before: params.context_before }),
    ...(params.action !== "search" || params.context_after === undefined ? {} : { context_after: params.context_after }),
    ...(params.action === "list" && params.max_results !== undefined ? { limit: params.max_results } : {}),
    ...(params.action === "search" && params.max_results !== undefined ? { max_results: params.max_results } : {}),
    ...(params.action === "git_diff" ? { max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_status" ? { max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_log" ? { limit: params.max_results, max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_show" ? { revision: params.revision, max_bytes: 64 * 1024 } : {}),
    ...(params.action === "git_blame" ? { start_line: params.start_line, end_line: params.end_line, max_bytes: 64 * 1024 } : {}),
  };
  return activeRunnerTool(env, clientId, method, input, "read", inspectResultMode(params.action));
}
async function diagnosticsTool(env: McpRequestEnv, clientId: string, workspaceId: string): Promise<unknown> {
  const observedAtMs = Date.now();
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  const checks: Array<Record<string, unknown>> = [
    { name: "worker_auth", state: "pass", evidence_source: "mcp_revalidation", observed_at_ms: observedAtMs },
    { name: "runner_selection", state: selected.value.context.state === "online" ? "pass" : "fail", code: selected.value.context.state === "online" ? null : "runner_offline", evidence_source: "registry", observed_at_ms: observedAtMs },
  ];
  const permissionCall = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-permissions/${encodeURIComponent(selected.value.runnerId)}?workspace_id=${encodeURIComponent(workspaceId)}`);
  const permissionValue = permissionCall.ok && isRecord(permissionCall.value) && isRecord(permissionCall.value.permissions) ? permissionCall.value.permissions : undefined;
  const permissions = permissionValue === undefined ? undefined : {
    read: permissionValue.read === true,
    edit: permissionValue.edit === true,
    shell: permissionValue.shell === true,
    job_control: permissionValue.job_control === true,
  };
  checks.push({ name: "workspace_authorization", state: permissions === undefined ? "unknown" : permissions.read ? "pass" : "fail", code: permissions === undefined ? "permission_state_unavailable" : permissions.read ? null : "permission_denied", evidence_source: "effective_permission", observed_at_ms: observedAtMs });

  const readinessRaw = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/policy-readiness`);
  const readinessValue = readinessRaw.ok && isRecord(readinessRaw.value) ? readinessRaw.value : undefined;
  const policyState = readinessValue?.ok === true ? "pass" : readinessValue === undefined ? "unknown" : "fail";
  checks.push({
    name: "policy_alignment",
    state: policyState,
    code: policyState === "pass" ? null : typeof readinessValue?.code === "string" ? readinessValue.code : "policy_state_unavailable",
    evidence_source: "registry_policy_readiness",
    observed_at_ms: observedAtMs,
    desired_revision: safePositiveIntegerValue(readinessValue?.desired_revision),
    applied_revision: safePositiveIntegerValue(readinessValue?.applied_revision),
    runner_reported_revision: safePositiveIntegerValue(readinessValue?.runner_reported_policy_revision),
  });

  let rpcState: "pass" | "fail" | "unknown" = "unknown";
  let rpcCode: string | null = null;
  let shell: Record<string, unknown> | undefined;
  if (selected.value.context.state !== "online") rpcCode = "runner_offline";
  else if (permissions?.read !== true) rpcCode = permissions === undefined ? "permission_state_unavailable" : "permission_denied";
  else {
    const readiness = await policyReadiness(env, selected.value.runnerId);
    if (!readiness.ok) rpcCode = readiness.error.error.code;
    else {
      const live = await callRunner(env, selected.value.runnerId, "env.info", { workspace_id: workspaceId }, readiness.value.applied_revision, readiness.value.active_checksum);
      rpcState = live.ok ? "pass" : "fail";
      rpcCode = live.ok ? null : live.error.code;
      if (live.ok && isRecord(live.value) && isRecord(live.value.shell)) {
        shell = { available: live.value.shell.available === true };
        if (live.value.shell.available === true && (live.value.shell.kind === "bash" || live.value.shell.kind === "powershell")) shell.kind = live.value.shell.kind;
      }
    }
  }
  checks.push({ name: "runner_rpc", state: rpcState, code: rpcCode, evidence_source: "live_rpc", observed_at_ms: Date.now() });
  const value: Record<string, unknown> = { workspace_id: workspaceId, observed_at_ms: observedAtMs, permissions: permissions ?? null, checks };
  if (shell !== undefined) value.shell = shell;
  return runnerSuccess(value, selected.value);
}
function safePositiveIntegerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
async function editTool(env: McpRequestEnv, clientId: string, params: z.output<typeof EditInputSchema>): Promise<unknown> {
  const input: Record<string, unknown> = { ...params };
  delete input.preview;
  return activeRunnerTool(env, clientId, params.preview === true ? "fs.preview_patch" : "fs.apply_patch", input, "edit", "edit");
}
async function shellTool(env: McpRequestEnv, clientId: string, params: z.output<typeof ShellInputSchema>): Promise<unknown> {
  const invocation = { workspace_id: params.workspace_id, command: params.command, shell: true, created_by_client_id: clientId, ...(params.request_id === undefined ? {} : { request_id: params.request_id }) };
  // Background starts return a Runner JobRecord.  Keep the MCP response on
  // the stable job-metadata allow-list; command/cwd/PID/process identity are
  // Runner-internal and must not cross this boundary.
  if (params.background === true) return activeRunnerTool(env, clientId, "exec.start", invocation, "shell", "job");
  const result = await activeRunnerTool(env, clientId, "exec.run", { ...invocation, ...(params.wait_ms === undefined ? {} : { wait_ms: params.wait_ms }) }, "shell", "shell");
  return normalizeShellResult(result);
}

function normalizeShellResult(result: unknown): unknown {
  if (!isToolSuccessResult(result)) return result;
  const value = result.structuredContent;
  // `success()` may already have returned its bounded truncation envelope.
  // Preserve that explicit signal rather than replacing it with an empty
  // projection; the serialized data has already passed redaction.
  if (isRedactionTruncationEnvelope(value)) return result;
  return success(safeShellResult(value));
}

async function jobTool(env: McpRequestEnv, clientId: string, params: z.output<typeof JobInputSchema>, scopes: readonly string[]): Promise<unknown> {
  switch (params.action) {
    case "list":
      if (!scopes.includes("coding:read")) return failure("insufficient_scope", "This job action requires coding:read.", "Authorize the MCP client again with coding:read.");
      return activeJobList(env, clientId, params);
    case "get":
      if (!scopes.includes("coding:read")) return failure("insufficient_scope", "This job action requires coding:read.", "Authorize the MCP client again with coding:read.");
      return activeJobGet(env, clientId, params.job_id);
    case "logs":
      if (!scopes.includes("coding:read")) return failure("insufficient_scope", "This job action requires coding:read.", "Authorize the MCP client again with coding:read.");
      return activeJobRunnerTool(env, clientId, "job.logs", boundedReadParams(params, 16 * 1024), "read", "logs");
    case "cancel":
      if (!scopes.includes("coding:exec")) return failure("insufficient_scope", "This job action requires coding:exec.", "Authorize the MCP client again with coding:exec.");
      return activeJobRunnerTool(env, clientId, "job.cancel", params, "job_control", "job");
    case "input":
      if (!scopes.includes("coding:exec")) return failure("insufficient_scope", "This job action requires coding:exec.", "Authorize the MCP client again with coding:exec.");
      return activeJobRunnerTool(env, clientId, "job.input", params, "job_control", "input");
  }
}

async function contextTool(env: McpRequestEnv, clientId: string, params: z.output<typeof ContextInputSchema>, scopes: readonly string[]): Promise<unknown> {
  const mutating = params.action === "checkpoint" || params.action === "rebuild";
  const requiredScope = mutating ? "coding:write" : "coding:read";
  if (!scopes.includes(requiredScope)) return failure("insufficient_scope", `This context action requires ${requiredScope}.`, `Authorize the MCP client again with ${requiredScope}.`);
  const method = `context.${params.action}`;
  return activeRunnerTool(env, clientId, method, params, mutating ? "edit" : "read", "context");
}

function isToolSuccessResult(value: unknown): value is { readonly structuredContent: Record<string, unknown> } {
  return isRecord(value) && value.isError !== true && isRecord(value.structuredContent);
}

/**
 * Project only the stable, non-sensitive Job metadata contract exposed by
 * MCP.  Runner JobRecord objects also carry command/cwd/PID/process identity
 * fields that must never cross the MCP boundary.
 */
export function safeJobMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  // The allow-list is only the first boundary.  Runner records normally have
  // already passed their local schema, but Registry snapshots and old peers
  // are untrusted at this layer too.  Copy scalar values only; otherwise a
  // hostile object such as `{ job_id: { cwd: ... } }` could survive the key
  // filter and become an arbitrary nested MCP response.
  const jobId = safeJobIdentifier(value.job_id);
  if (jobId !== undefined) output.job_id = jobId;
  const workspaceId = safeJobIdentifier(value.workspace_id);
  if (workspaceId !== undefined) output.workspace_id = workspaceId;
  // Keep the originating MCP client attribution in the public job metadata.
  // It is a bounded identifier, and lets callers correlate shared jobs after
  // the original MCP request has completed.
  const createdByClientId = safeJobIdentifier(value.created_by_client_id);
  if (createdByClientId !== undefined) output.created_by_client_id = createdByClientId;
  const requestId = safeJobIdentifier(value.request_id);
  if (requestId !== undefined) output.request_id = requestId;
  if (typeof value.status === "string") output.status = safeJobStatus(value.status);
  copyRequiredTimestamp(value, output, "created_at_ms");
  copyNullableTimestamp(value, output, "started_at_ms");
  copyRequiredTimestamp(value, output, "updated_at_ms");
  copyNullableTimestamp(value, output, "completed_at_ms");
  const exitCode = value.exit_code;
  if (exitCode === null || isSafeExitCode(exitCode)) output.exit_code = exitCode;
  const signal = safeSignal(value.signal);
  if (signal !== undefined) output.signal = signal;
  // Recovery notes are Runner-authored free text and can contain raw process
  // errors, filesystem paths, or credential-adjacent details.  They are useful
  // to the authenticated administrator surface, but are intentionally not a
  // part of the public MCP Job contract; exposing a bounded string is still
  // an information leak, so omit it rather than attempting ad-hoc filtering.
  if (typeof value.output_truncated === "boolean") output.output_truncated = value.output_truncated;
  copyNullableTimestamp(value, output, "cancellation_delivered_at_ms");
  return output;
}

/**
 * Project the bounded log envelope returned by `job.logs`. Log `data` is
 * intentionally retained (it is the content the caller requested), while
 * arbitrary future fields—including a nested JobRecord—are discarded.
 */
export function safeJobLogResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const jobId = safeJobIdentifier(value.job_id);
  if (jobId !== undefined) output.job_id = jobId;
  if (value.stream === "stdout" || value.stream === "stderr") output.stream = value.stream;
  if (typeof value.data === "string") output.data = value.data.slice(0, 65_536);
  if (isSafeNonnegativeInteger(value.offset)) output.offset = value.offset;
  if (value.next_cursor === null || isSafeCursor(value.next_cursor)) output.next_cursor = value.next_cursor;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
  if (isSafeNonnegativeInteger(value.size)) output.size = value.size;
  return output;
}

/** Project the acknowledgement returned by `job.input`; no JobRecord fields belong here. */
export function safeJobInputResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  if (isSafeNonnegativeInteger(value.accepted)) output.accepted = value.accepted;
  if (typeof value.eof === "boolean") output.eof = value.eof;
  return output;
}

/** Project the `exec.run` response, including its nested job and log envelopes. */
export function safeShellResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const job = isRecord(value.job) ? value.job : value;
  Object.assign(output, safeJobMetadata(job));
  if (typeof value.completed === "boolean") output.completed = value.completed;
  if (isSafeNonnegativeInteger(value.wait_cap_ms)) output.wait_cap_ms = value.wait_cap_ms;
  if (value.stdout !== undefined) output.stdout = safeJobLogResult(value.stdout);
  if (value.stderr !== undefined) output.stderr = safeJobLogResult(value.stderr);
  if (value.runner_context !== undefined) output.runner_context = safeRunnerContext(value.runner_context);
  // A status is required by the shell contract even when an old/malformed
  // Runner omitted it. Normalize arbitrary strings to the stable enum so a
  // hostile RPC result cannot smuggle an unbounded status value downstream.
  if (Object.prototype.hasOwnProperty.call(output, "status")) output.status = safeJobStatus(output.status);
  return output;
}

/**
 * Project filesystem read results at the MCP boundary.  A current Runner
 * emits workspace-relative paths, but a stale or compromised peer is still
 * untrusted: absolute/UNC/drive-qualified paths are omitted instead of being
 * allowed through the generic redactor.
 */
export function safeReadResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  copySafeRelativePath(value, output, "path");
  if (typeof value.data === "string") output.data = value.data.slice(0, 65_536);
  if (value.encoding === "utf-8" || value.encoding === "utf8") output.encoding = "utf-8";
  if (isSafeNonnegativeInteger(value.offset)) output.offset = value.offset;
  if (value.next_cursor === null || isSafeCursor(value.next_cursor)) output.next_cursor = value.next_cursor;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
  if (isSafeNonnegativeInteger(value.size)) output.size = value.size;
  return output;
}

export function safeContextResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
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
  if (value.schema_version === 1) output.schema_version = 1;
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
  if (value.base_commit_status === null || value.base_commit_status === "claimed") output.base_commit_status = value.base_commit_status;
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

function copyContextText(source: Record<string, unknown>, target: Record<string, unknown>, key: string, max: number): void {
  const value = source[key];
  if (typeof value === "string" && value.length <= max && !hasControlCharacters(value)) target[key] = value;
}

export type InspectResultKind = "list" | "search" | "stat" | "git_status" | "git_diff" | "git_log" | "git_show" | "git_blame";

/** Project each inspect operation without exposing host roots or raw errors. */
export function safeInspectResult(value: unknown, kind: InspectResultKind): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  if (kind === "stat") {
    copySafeRelativePath(value, output, "path");
    if (value.type === "file" || value.type === "directory" || value.type === "other") output.type = value.type;
    if (isSafeNonnegativeInteger(value.size)) output.size = value.size;
    if (isSafeNonnegativeInteger(value.modified_at_ms)) output.modified_at_ms = value.modified_at_ms;
    if (value.encoding === "utf-8" || value.encoding === "binary") output.encoding = value.encoding;
    if (typeof value.binary === "boolean") output.binary = value.binary;
    return output;
  }
  if (kind === "list") {
    copySafeRelativePath(value, output, "path");
    if (Array.isArray(value.entries)) {
      output.entries = value.entries.slice(0, 256).flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.name !== "string" || !safeDirectoryName(entry.name)) return [];
        const type = entry.type === "file" || entry.type === "directory" || entry.type === "other" ? entry.type : undefined;
        return type === undefined ? [] : [{ name: entry.name, type }];
      });
    }
    copySafeCursorFields(value, output);
    return output;
  }
  if (kind === "search") {
    if (typeof value.query === "string" && value.query.length <= 512 && !hasControlCharacters(value.query)) output.query = value.query;
    if (value.mode === "literal" || value.mode === "filename") output.mode = value.mode;
    if (typeof value.case_sensitive === "boolean") output.case_sensitive = value.case_sensitive;
    if (value.engine === "builtin_literal" || value.engine === "builtin_filename") output.engine = value.engine;
    if (typeof value.snapshot_id === "string" && /^[a-f0-9]{16}$/u.test(value.snapshot_id)) output.snapshot_id = value.snapshot_id;
    if (Array.isArray(value.results)) {
      output.results = value.results.slice(0, 256).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const path = safeRelativePathValue(entry.path);
        if (path === undefined || !isSafePositiveInteger(entry.line) || typeof entry.text !== "string") return [];
        const item: Record<string, unknown> = { path, line: entry.line, text: entry.text.slice(0, 4_096) };
        if (isSafePositiveInteger(entry.column)) item.column = entry.column;
        if (typeof entry.match === "string") item.match = entry.match.slice(0, 1_024);
        for (const key of ["context_before", "context_after"] as const) {
          if (!Array.isArray(entry[key])) continue;
          item[key] = entry[key].slice(0, 8).flatMap((contextLine) => isRecord(contextLine) && isSafePositiveInteger(contextLine.line) && typeof contextLine.text === "string" ? [{ line: contextLine.line, text: contextLine.text.slice(0, 4_096) }] : []);
        }
        return [item];
      });
    }
    copySafeCursorFields(value, output);
    if (value.next_snapshot_cursor === null || (typeof value.next_snapshot_cursor === "string" && /^s1:[a-f0-9]{16}:\d+$/u.test(value.next_snapshot_cursor))) output.next_snapshot_cursor = value.next_snapshot_cursor;
    if (["time_budget", "byte_budget", "directory_budget", "entry_budget", "file_budget", "result_budget", "response_bytes"].includes(String(value.truncated_reason))) output.truncated_reason = value.truncated_reason;
    if (isRecord(value.scanned)) {
      const scanned: Record<string, unknown> = {};
      for (const key of ["bytes", "files", "directories", "entries"] as const) if (isSafeNonnegativeInteger(value.scanned[key])) scanned[key] = value.scanned[key];
      output.scanned = scanned;
    }
    copySafeInteger(value, output, "returned_bytes");
    return output;
  }
  if (kind === "git_status") {
    copySafeRelativePath(value, output, "path");
    if (isRecord(value.branch)) {
      const branch: Record<string, unknown> = {};
      for (const key of ["oid", "head", "upstream"] as const) {
        if (typeof value.branch[key] === "string" && value.branch[key].length <= 512 && !hasControlCharacters(value.branch[key] as string)) branch[key] = value.branch[key];
      }
      output.branch = branch;
    }
    if (Array.isArray(value.entries)) {
      output.entries = value.entries.slice(0, 1_000).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const path = safeRelativePathValue(entry.path);
        if (path === undefined) return [];
        const item: Record<string, unknown> = { path };
        for (const key of ["original_path"] as const) {
          const original = safeRelativePathValue(entry[key]);
          if (original !== undefined) item[key] = original;
        }
        for (const key of ["index_status", "worktree_status"] as const) {
          if (typeof entry[key] === "string" && entry[key].length <= 8 && !hasControlCharacters(entry[key] as string)) item[key] = entry[key];
        }
        if (typeof entry.untracked === "boolean") item.untracked = entry.untracked;
        if (typeof entry.ignored === "boolean") item.ignored = entry.ignored;
        return [item];
      });
    }
    copySafeInteger(value, output, "ahead");
    copySafeInteger(value, output, "behind");
    copySafeInteger(value, output, "output_bytes");
    if (typeof value.truncated === "boolean") output.truncated = value.truncated;
    return output;
  }
  if (kind === "git_log") {
    copySafeRelativePath(value, output, "path");
    if (Array.isArray(value.commits)) output.commits = value.commits.slice(0, 100).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.oid !== "string" || !/^[0-9a-f]{40,64}$/i.test(entry.oid)) return [];
      return [{ oid: entry.oid, author: typeof entry.author === "string" ? entry.author.slice(0, 512) : "", date: typeof entry.date === "string" ? entry.date.slice(0, 64) : "", subject: typeof entry.subject === "string" ? entry.subject.slice(0, 4096) : "" }];
    });
    copySafeInteger(value, output, "limit");
    if (typeof value.truncated === "boolean") output.truncated = value.truncated;
    return output;
  }
  if (kind === "git_show" || kind === "git_blame") {
    copySafeRelativePath(value, output, "path");
    if (typeof value.revision === "string") output.revision = value.revision;
    for (const key of ["start_line", "end_line"] as const) copySafeInteger(value, output, key);
    if (typeof value.output === "string") output.output = value.output.slice(0, 65_536);
    if (value.encoding === "utf-8") output.encoding = "utf-8";
    copySafeInteger(value, output, "bytes");
    if (typeof value.truncated === "boolean") output.truncated = value.truncated;
    return output;
  }
  // git_diff.  GitService returns `path`, `diff`, `encoding`, and `bytes`;
  // keep those names stable at the MCP boundary (and accept the older
  // aliases only for compatibility with pre-privileged Runners).
  const path = safeRelativePathValue(value.path) ?? safeRelativePathValue(value.requested_path);
  if (path !== undefined) output.path = path;
  if (typeof value.staged === "boolean") output.staged = value.staged;
  const diff = typeof value.diff === "string" ? value.diff : value.output;
  if (typeof diff === "string") output.diff = diff.slice(0, 65_536);
  if (value.encoding === "utf-8" || value.encoding === "utf8") output.encoding = "utf-8";
  const bytes = value.bytes ?? value.output_bytes;
  if (isSafeNonnegativeInteger(bytes)) output.bytes = bytes;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
  return output;
}

/** Return only workspace-relative patch metadata; recovery paths/errors stay local to the Runner. */
export function safeEditResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  if (isSha256(value.preview_id)) output.preview_id = value.preview_id;
  for (const key of ["insertions", "deletions"] as const) copySafeInteger(value, output, key);
  if (typeof value.previews_truncated === "boolean") output.previews_truncated = value.previews_truncated;
  if (Array.isArray(value.changed_paths)) {
    output.changed_paths = value.changed_paths.slice(0, 128).flatMap((item) => safePatchChange(item));
  }
  if (Array.isArray(value.operations)) {
    output.operations = value.operations.slice(0, 128).flatMap((item) => safePatchOperation(item));
  }
  if (Array.isArray(value.previews)) {
    output.previews = value.previews.slice(0, 128).flatMap((item) => {
      if (!isRecord(item)) return [];
      const path = safeRelativePathValue(item.path);
      if (path === undefined || typeof item.diff !== "string") return [];
      const preview: Record<string, unknown> = { path, diff: item.diff.slice(0, 16 * 1_024) };
      if (item.status === "created" || item.status === "updated" || item.status === "deleted") preview.status = item.status;
      for (const key of ["insertions", "deletions"] as const) if (isSafeNonnegativeInteger(item[key])) preview[key] = item[key];
      if (typeof item.truncated === "boolean") preview.truncated = item.truncated;
      return [preview];
    });
  }
  if (Array.isArray(value.warnings)) {
    output.warnings = value.warnings.slice(0, 128).flatMap((item) => {
      if (!isRecord(item)) return [];
      const path = safeRelativePathValue(item.path);
      return path === undefined ? [] : [{ path, code: "recovery_required" }];
    });
  }
  return output;
}

function safePatchChange(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const path = safeRelativePathValue(value.path);
  if (path === undefined) return [];
  const status = value.status === "created" || value.status === "updated" || value.status === "deleted" ? value.status : undefined;
  if (status === undefined) return [];
  const result: Record<string, unknown> = { path, status };
  for (const key of ["before_hash", "after_hash"] as const) {
    if (value[key] === null || isSha256(value[key])) result[key] = value[key];
  }
  if (isSafeMode(value.mode)) result.mode = value.mode;
  return [result];
}

function safePatchOperation(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const path = safeRelativePathValue(value.path);
  if (path === undefined) return [];
  const operation = value.operation === "add" || value.operation === "update" || value.operation === "delete" || value.operation === "move" ? value.operation : undefined;
  if (operation === undefined || value.status !== "applied") return [];
  const result: Record<string, unknown> = { operation, path, status: "applied" };
  const destination = safeRelativePathValue(value.destination);
  if (destination !== undefined) result.destination = destination;
  if (Array.isArray(value.results)) result.results = value.results.slice(0, 128).flatMap((item) => safePatchChange(item));
  return [result];
}

function copySafeWorkspaceId(value: Record<string, unknown>, output: Record<string, unknown>): void {
  const id = safeJobIdentifier(value.workspace_id);
  if (id !== undefined) output.workspace_id = id;
}

function copySafeRelativePath(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  const path = safeRelativePathValue(value[key]);
  if (path !== undefined) output[key] = path;
}

function copySafeCursorFields(value: Record<string, unknown>, output: Record<string, unknown>): void {
  if (value.next_cursor === null || isSafeCursor(value.next_cursor)) output.next_cursor = value.next_cursor;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
}

function copySafeInteger(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (isSafeNonnegativeInteger(value[key])) output[key] = value[key];
}

function safeRelativePathValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 4_096 && isSafeRelativePath(value) ? value : undefined;
}

function safeDirectoryName(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !hasControlCharacters(value) && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function hasControlCharacters(value: string): boolean { return /[\u0000-\u001f\u007f-\u009f]/u.test(value); }
function isSafePositiveInteger(value: unknown): value is number { return isSafeNonnegativeInteger(value) && value > 0; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isSafeMode(value: unknown): value is number { return isSafeNonnegativeInteger(value) && value <= 0o7777; }

function safeJobStatus(value: unknown): string {
  return value === "queued" || value === "running" || value === "cancelling" || value === "cancelled" || value === "succeeded" || value === "failed" || value === "unknown" || value === "interrupted" ? value : "unknown";
}

function safeJobIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ? value : undefined;
}

function isSafeCursor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^(?:\d+|s1:[a-f0-9]{16}:\d+)$/u.test(value);
}

function isSafeExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 2 ** 31;
}

function copyRequiredTimestamp(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (isSafeNonnegativeInteger(value[key])) output[key] = value[key];
}

function copyNullableTimestamp(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (value[key] === null || isSafeNonnegativeInteger(value[key])) output[key] = value[key];
}

function safeRunnerContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const runnerId = safeJobIdentifier(value.runner_id);
  if (runnerId !== undefined) output.runner_id = runnerId;
  if (value.state === "online" || value.state === "offline" || value.state === "stale" || value.state === "unavailable") output.state = value.state;
  if (typeof value.available === "boolean") output.available = value.available;
  if (value.updated_at_ms === null || isSafeNonnegativeInteger(value.updated_at_ms)) output.updated_at_ms = value.updated_at_ms;
  if (typeof value.automatic_selection === "boolean") output.automatic_selection = value.automatic_selection;
  return output;
}

/** Explicitly project sticky selection data; Registry responses are internal
 * and must not be spread into the public MCP response. */
function safeSelectionValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { active_runner_id: null, active_runner_updated_at_ms: null, active_runner: null };
  return {
    active_runner_id: value.active_runner_id === null ? null : safeJobIdentifier(value.active_runner_id) ?? null,
    active_runner_updated_at_ms: value.active_runner_updated_at_ms === null || isSafeNonnegativeInteger(value.active_runner_updated_at_ms)
      ? value.active_runner_updated_at_ms
      : null,
    active_runner: value.runner === null ? null : safeRunnerContext(value.runner),
  };
}

function safeSignal(value: unknown): string | null | undefined {
  if (value === null) return null;
  // Signals are a finite, protocol-level enum in current Runners.  Do not
  // let a stale/malformed peer use this short field as a filesystem/path
  // side-channel.
  return typeof value === "string" && value.length <= 32 && /^(?:SIG[A-Z0-9]+|[A-Z][A-Z0-9_]{0,31})$/u.test(value)
    ? value
    : undefined;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRedactionTruncationEnvelope(value: Record<string, unknown>): boolean {
  return value.truncated === true
    && typeof value.data === "string"
    && typeof value.recovery_hint === "string"
    && Object.keys(value).every((key) => key === "truncated" || key === "data" || key === "recovery_hint");
}

type ActiveSelection = {
  readonly runnerId: string;
  readonly context: ActiveRunnerContext & { readonly automatic_selection: boolean };
};
type RunnerResultMode = "raw" | "job" | "logs" | "input" | "shell" | "read" | "edit" | "context" | "inspect:list" | "inspect:search" | "inspect:stat" | "inspect:git_status" | "inspect:git_diff" | "inspect:git_log" | "inspect:git_show" | "inspect:git_blame";
type ActivePolicyReadiness = Omit<Extract<RegistryPolicyReadiness, { readonly ok: true }>, "lifecycle_id" | "session_id"> & {
  readonly lifecycle_id: string;
  readonly session_id: string;
};
function inspectResultMode(action: InspectResultKind): RunnerResultMode { return `inspect:${action}` as RunnerResultMode; }
type SelectionCall = ToolSuccess | ToolFailure;
type ActiveSelectionCall = { readonly ok: true; readonly value: ActiveSelection } | ToolFailure;

async function getActiveRunnerSelection(env: McpRequestEnv, clientId: string): Promise<SelectionCall> {
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`);
  if (!call.ok) return call;
  return { ok: true, value: call.value as McpClientActiveRunner };
}

async function selectActiveRunner(env: McpRequestEnv, clientId: string, runnerId: string, confirmSwitch: boolean): Promise<SelectionCall> {
  const call = await registryPostCall(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner`, { runner_id: runnerId, confirm_switch: confirmSwitch });
  if (call.ok) {
    const result = call.value as McpRunnerSelectionResult;
    if (result.ok) return { ok: true, value: result };
    if (result.code === "runner_switch_confirmation_required") return failWithDetails(result.code, "Switching the active runner requires confirmation.", "Retry with confirm_switch=true to switch runners.", result.selection);
    return fail(result.code, "The runner selection could not be changed.", "Call runner_list and choose an available runner.");
  }
  return call;
}

async function resolveActiveRunner(env: McpRequestEnv, clientId: string, allowOfflineSnapshot = false): Promise<ActiveSelectionCall> {
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
  const runnerContext = safeRunnerContext(selection.context);
  if (isRecord(value)) return success({ ...value, runner_context: runnerContext });
  return success({ data: value, runner_context: runnerContext });
}
function runnerFailure(error: ToolFailure["error"], selection: ActiveSelection): unknown {
  return failureWithDetails(error.code, error.message, error.hint, { runner_context: safeRunnerContext(selection.context) });
}

async function activeRunnerTool(env: McpRequestEnv, clientId: string, method: string, params: Record<string, unknown>, requiredPermission?: PermissionBit, resultMode: RunnerResultMode = "raw"): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const permission = requiredPermission === undefined
    ? undefined
    : params.workspace_id === undefined
      ? await checkAnyReadPermission(env, clientId, selected.value.runnerId)
      : await checkPermission(env, clientId, selected.value.runnerId, params.workspace_id, requiredPermission);
  if (permission !== undefined) return asToolResult(permission);
  const readiness = await policyReadiness(env, selected.value.runnerId);
  if (!readiness.ok) return asToolResult(readiness.error);
  const startedAtMs = Date.now();
  const call = await callRunner(env, selected.value.runnerId, method, params, readiness.value.applied_revision, readiness.value.active_checksum);
  const result = call.ok ? runnerSuccess(projectRunnerResult(call.value, resultMode), selected.value) : runnerFailure(call.error, selected.value);
  const audit = await recordRunnerToolCall(env, {
    runnerId: selected.value.runnerId,
    clientId,
    method,
    params,
    result,
    startedAtMs,
    readiness: readiness.value,
  }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
  return withAuditReceipt(result, audit);
}

async function activeJobRunnerTool(env: McpRequestEnv, clientId: string, method: string, params: Record<string, unknown>, requiredPermission: PermissionBit, resultMode: RunnerResultMode = "raw"): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const job = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/jobs/${encodeURIComponent(String(params.job_id))}`);
  if (!job.ok) return runnerFailure(job.error, selected.value);
  const workspaceId = isRecord(job.value) && typeof job.value.workspace_id === "string" ? job.value.workspace_id : undefined;
  const requestedJobId = typeof params.job_id === "string" ? params.job_id : undefined;
  if (requestedJobId === undefined || workspaceId === undefined || !isSafeIdentifier(workspaceId)) {
    return runnerFailure(fail("permission_denied", "The operation is not permitted for this job.", "Use a job identifier belonging to an authorized workspace.").error, selected.value);
  }
  const permission = await checkPermission(env, clientId, selected.value.runnerId, workspaceId, requiredPermission);
  if (permission !== undefined) return asToolResult(permission);
  const readiness = await policyReadiness(env, selected.value.runnerId);
  if (!readiness.ok) return asToolResult(readiness.error);
  const startedAtMs = Date.now();
  // Bind the live request to the Registry-authorized workspace as an
  // additional confused-deputy defense. Current Runners validate this field;
  // older Runners may ignore the optional value, so response identity checks
  // below remain in place for compatibility.
  const boundParams = { ...params, expected_workspace_id: workspaceId };
  const call = await callRunner(env, selected.value.runnerId, method, boundParams, readiness.value.applied_revision, readiness.value.active_checksum);
  if (!call.ok) {
    const failure = runnerFailure(call.error, selected.value);
    const audit = await recordRunnerToolCall(env, {
      runnerId: selected.value.runnerId,
      clientId,
      method,
      params: boundParams,
      result: failure,
      startedAtMs,
      workspaceId,
      jobId: requestedJobId,
      readiness: readiness.value,
    }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
    return withAuditReceipt(failure, audit);
  }
  // A live Runner is expected to echo the addressed job identity in metadata
  // and cancellation responses.  If it does, bind both IDs to the Registry
  // snapshot that passed the permission check; never return a cross-workspace
  // record from a stale/reused job ID.  Log/input acknowledgements may omit
  // workspace_id by contract, so they are still bound by the exact job_id
  // request and the Registry preflight above.
  if (!runnerJobResultMatches(call.value, requestedJobId, workspaceId)) {
    const failure = runnerFailure(fail("permission_denied", "The Runner returned a job from a different workspace.", "Refresh the job list and retry with the authorized job identifier.").error, selected.value);
    const audit = await recordRunnerToolCall(env, {
      runnerId: selected.value.runnerId,
      clientId,
      method,
      params: boundParams,
      result: failure,
      startedAtMs,
      workspaceId,
      jobId: requestedJobId,
      readiness: readiness.value,
    }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
    return withAuditReceipt(failure, audit);
  }
  const result = runnerSuccess(projectRunnerResult(call.value, resultMode), selected.value);
  const audit = await recordRunnerToolCall(env, {
    runnerId: selected.value.runnerId,
    clientId,
    method,
    params: boundParams,
    result,
    startedAtMs,
    workspaceId,
    jobId: requestedJobId,
    readiness: readiness.value,
  }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
  return withAuditReceipt(result, audit);
}

function projectRunnerResult(value: unknown, mode: RunnerResultMode): unknown {
  if (mode === "job") return safeJobMetadata(value);
  if (mode === "logs") return safeJobLogResult(value);
  if (mode === "input") return safeJobInputResult(value);
  if (mode === "shell") return safeShellResult(value);
  if (mode === "read") return safeReadResult(value);
  if (mode === "edit") return safeEditResult(value);
  if (mode === "context") return safeContextResult(value);
  if (mode.startsWith("inspect:")) return safeInspectResult(value, mode.slice("inspect:".length) as InspectResultKind);
  return value;
}

async function activeJobList(env: McpRequestEnv, clientId: string, filters: Record<string, unknown>): Promise<unknown> {
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
    if (await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read") === undefined) {
      // Registry snapshots contain Runner-internal JobRecord fields (cwd,
      // command, PID, and process identity).  Keep the MCP contract to the
      // documented metadata allow-list even when a future Registry adds more
      // fields or redaction rules change.
      visible.push(safeJobMetadata(job));
    }
  }
  // Keep the outer envelope closed as well as each JobRecord.  Spreading a
  // Registry response here would let a future/internal field (for example a
  // root path or query diagnostic) cross the MCP boundary without going
  // through an explicit projection.
  const projected: Record<string, unknown> = { jobs: visible };
  const runnerId = safeJobIdentifier(value.runner_id);
  if (runnerId !== undefined) projected.runner_id = runnerId;
  if (selected.value.context.state !== "online") {
    projected.source = "registry_snapshot";
    projected.runner_state = "offline";
  }
  return runnerSuccess(projected, selected.value);
}

async function activeWorkspaceList(env: McpRequestEnv, clientId: string): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  // The Registry projects the policy and effective intersection in one event
  // turn: the workspace's permission ceiling is not the caller's permission.
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-workspaces/${encodeURIComponent(selected.value.runnerId)}`);
  if (!call.ok) return runnerFailure(call.error, selected.value);
  const value = isRecord(call.value) ? call.value : {};
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : [];
  const projected: Record<string, unknown> = { workspaces: workspaces.flatMap((workspace) => { const safe = safeWorkspaceMetadata(workspace); return safe === undefined ? [] : [safe]; }) };
  const runnerId = safeJobIdentifier(value.runner_id);
  if (runnerId !== undefined) projected.runner_id = runnerId;
  if (isSafeNonnegativeInteger(value.revision)) projected.revision = value.revision;
  if (typeof value.checksum === "string" && /^[a-f0-9]{64}$/u.test(value.checksum)) projected.checksum = value.checksum;
  if (selected.value.context.state !== "online") { projected.source = "registry_snapshot"; projected.runner_state = "offline"; }
  return runnerSuccess(projected, selected.value);
}

type PermissionCheck = ToolFailure;
async function checkPermission(env: McpRequestEnv, clientId: string, runnerId: string, workspaceId: unknown, required: PermissionBit): Promise<PermissionCheck | undefined> {
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return fail("permission_denied", "Workspace permission could not be resolved.", "Use a workspace identifier managed by the administrator.");
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-permissions/${encodeURIComponent(runnerId)}?workspace_id=${encodeURIComponent(workspaceId)}`);
  if (!call.ok) return fail("permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.");
  const permissions = isRecord(call.value) && isRecord(call.value.permissions) ? call.value.permissions : undefined;
  if (permissions?.[required] !== true) return fail(required === "edit" ? "readonly_workspace" : "permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.");
  return undefined;
}
async function policyReadiness(env: McpRequestEnv, runnerId: string): Promise<{ readonly ok: true; readonly value: ActivePolicyReadiness } | { readonly ok: false; readonly error: PermissionCheck }> {
  const readiness = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/policy-readiness`);
  if (!readiness.ok || !isRecord(readiness.value)) return { ok: false, error: fail("stale_policy", "The selected runner policy could not be verified.", "Wait for the runner to reconnect and apply the latest control-plane policy.") };
  const value = readiness.value;
  const desiredRevision = typeof value.desired_revision === "number" && Number.isSafeInteger(value.desired_revision) && value.desired_revision > 0 ? value.desired_revision : undefined;
  const desiredChecksum = typeof value.desired_checksum === "string" && /^[a-f0-9]{64}$/u.test(value.desired_checksum) ? value.desired_checksum : undefined;
  const appliedRevision = typeof value.applied_revision === "number" && Number.isSafeInteger(value.applied_revision) && value.applied_revision > 0 ? value.applied_revision : undefined;
  const activeChecksum = typeof value.active_checksum === "string" && /^[a-f0-9]{64}$/u.test(value.active_checksum) ? value.active_checksum : undefined;
  const reportedRevision = typeof value.runner_reported_policy_revision === "number" && Number.isSafeInteger(value.runner_reported_policy_revision) && value.runner_reported_policy_revision > 0 ? value.runner_reported_policy_revision : undefined;
  const reportedChecksum = typeof value.runner_reported_policy_checksum === "string" && /^[a-f0-9]{64}$/u.test(value.runner_reported_policy_checksum) ? value.runner_reported_policy_checksum : undefined;
  const connectionEpoch = typeof value.connection_epoch === "number" && Number.isSafeInteger(value.connection_epoch) && value.connection_epoch >= 0 ? value.connection_epoch : undefined;
  const credentialVersion = typeof value.credential_version === "number" && Number.isSafeInteger(value.credential_version) && value.credential_version >= 0 ? value.credential_version : undefined;
  const lifecycleId = typeof value.lifecycle_id === "string" && safeLifecycleId(value.lifecycle_id) ? value.lifecycle_id : undefined;
  const sessionId = typeof value.session_id === "string" && safeJobIdentifier(value.session_id) !== undefined ? value.session_id : undefined;
  const triad = desiredRevision !== undefined && appliedRevision !== undefined && reportedRevision !== undefined && desiredChecksum !== undefined && activeChecksum !== undefined && reportedChecksum !== undefined
    && desiredRevision === appliedRevision && reportedRevision === appliedRevision && desiredChecksum === activeChecksum && reportedChecksum === activeChecksum;
  if (value.ok !== true || desiredRevision === undefined || desiredChecksum === undefined || appliedRevision === undefined || activeChecksum === undefined || reportedRevision === undefined || reportedChecksum === undefined || connectionEpoch === undefined || credentialVersion === undefined || lifecycleId === undefined || sessionId === undefined || !triad) {
    const code = value.code === "stale_policy" ? "stale_policy" : "policy_pending";
    return { ok: false, error: fail(code, "The selected runner has no trusted active policy.", "Wait for the runner to reconnect and apply the latest control-plane policy.") };
  }
  return {
    ok: true,
    value: {
      ok: true,
      policy_status: "applied",
      desired_revision: desiredRevision,
      desired_checksum: desiredChecksum,
      applied_revision: appliedRevision,
      active_checksum: activeChecksum,
      runner_reported_policy_revision: reportedRevision,
      runner_reported_policy_checksum: reportedChecksum,
      connection_epoch: connectionEpoch,
      credential_version: credentialVersion,
      lifecycle_id: lifecycleId,
      session_id: sessionId,
    },
  };
}

async function snapshotAuthorization(env: McpRequestEnv, runnerId: string): Promise<ToolFailure | undefined> {
  const snapshot = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/snapshot-authorization`);
  if (!snapshot.ok || !isRecord(snapshot.value) || snapshot.value.ok !== true) return fail("policy_pending", "The selected runner has no trusted active policy snapshot.", "Wait for an active policy to be acknowledged, then retry.");
  return undefined;
}
function safeLifecycleId(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}
async function checkAnyReadPermission(env: McpRequestEnv, clientId: string, runnerId: string): Promise<PermissionCheck | undefined> {
  const snapshotPermission = await snapshotAuthorization(env, runnerId);
  if (snapshotPermission !== undefined) return snapshotPermission;
  const active = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/active-workspaces`);
  if (!active.ok || !isRecord(active.value) || !Array.isArray(active.value.workspaces)) return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
  for (const item of active.value.workspaces) {
    if (!isRecord(item) || typeof item.workspace_id !== "string" || item.enabled !== true) continue;
    if (await checkPermission(env, clientId, runnerId, item.workspace_id, "read") === undefined) return undefined;
  }
  return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
}

async function gatedRunnerList(env: McpRequestEnv, clientId: string): Promise<unknown> {
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

async function activeJobGet(env: McpRequestEnv, clientId: string, jobId: string): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  const snapshot = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/jobs/${encodeURIComponent(jobId)}`);
  if (!snapshot.ok) return runnerFailure(snapshot.error, selected.value);
  const workspaceId = isRecord(snapshot.value) && typeof snapshot.value.workspace_id === "string" ? snapshot.value.workspace_id : undefined;
  if (workspaceId === undefined || !isSafeIdentifier(workspaceId)) {
    return runnerFailure(fail("permission_denied", "The operation is not permitted for this job.", "Use a job identifier belonging to an authorized workspace.").error, selected.value);
  }
  const permission = await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read");
  if (permission !== undefined) return asToolResult(permission);
  if (selected.value.context.state !== "online") {
    return runnerSuccess({ ...safeJobMetadata(snapshot.value), source: "registry_snapshot", runner_state: "offline" }, selected.value);
  }
  const readiness = await policyReadiness(env, selected.value.runnerId);
  if (!readiness.ok) return asToolResult(readiness.error);
  const live = await callRunner(env, selected.value.runnerId, "job.get", { job_id: jobId, expected_workspace_id: workspaceId }, readiness.value.applied_revision, readiness.value.active_checksum);
  if (live.ok) {
    if (!runnerJobResultMatches(live.value, jobId, workspaceId)) {
      return runnerFailure(fail("permission_denied", "The Runner returned a job from a different workspace.", "Refresh the job list and retry with the authorized job identifier.").error, selected.value);
    }
    return runnerSuccess(safeJobMetadata(live.value), selected.value);
  }
  if (live.error.code !== "runner_offline") return runnerFailure(live.error, selected.value);
  return runnerSuccess({ ...safeJobMetadata(snapshot.value), source: "registry_snapshot", runner_state: "offline" }, selected.value);
}

/** Check an RPC job envelope against the Registry-authorized job/workspace pair. */
function runnerJobResultMatches(value: unknown, jobId: string, workspaceId: string): boolean {
  if (!isRecord(value)) return false;
  const nested = isRecord(value.job) ? value.job : value;
  const returnedJobId = nested.job_id;
  if (returnedJobId !== undefined && returnedJobId !== jobId) return false;
  const returnedWorkspaceId = nested.workspace_id;
  if (returnedWorkspaceId !== undefined && returnedWorkspaceId !== workspaceId) return false;
  return true;
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
type ToolFailure = { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly hint: string; readonly details?: unknown; readonly failure_class?: string; readonly operation_state?: string; readonly retry_after_ms?: number; readonly next_action?: string } };
type ToolCall = ToolSuccess | ToolFailure;

const SAFE_RUNNER_ERROR_CODES = new Set([
  "baseline_changed", "busy", "expected_hash_mismatch", "file_too_large", "git_failed", "git_output_too_large", "git_timeout", "git_unavailable",
  "context_index_corrupt", "context_index_too_large", "context_record_corrupt", "context_record_missing", "context_record_too_large", "context_rebuild_budget", "context_revision_conflict", "context_storage_unsafe", "context_turn_conflict",
  "hunk_ambiguous", "hunk_not_found", "hunk_overlap", "invalid_params", "invalid_patch", "invalid_path", "invalid_request", "invalid_workspace", "missing_file", "mixed_newlines", "not_utf8",
  "method_not_found", "insufficient_scope", "patch_install_failed", "patch_rollback_failed", "path_traversal", "permission_denied", "policy_pending", "readonly_workspace", "request_id_conflict", "runner_offline", "search_snapshot_changed", "stale_policy", "symlink_escape", "symlink_write", "target_exists", "timeout",
]);

export function policyPending(): ToolFailure {
  return fail("policy_pending", "The selected runner has not applied the latest policy.", "Wait for the runner to apply its control-plane policy, then retry.") as ToolFailure;
}

function safeRunnerErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_RUNNER_ERROR_CODES.has(value) ? value : fallback;
}

async function callRunner(env: McpRequestEnv, runnerId: string, method: string, params: Record<string, unknown>, policyRevision?: number, policyChecksum?: string): Promise<ToolCall> {
  if (!isSafeIdentifier(runnerId)) return fail("invalid_runner_id", "runner_id is invalid", "Use a runner identifier returned by runner_list.");
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The runner bridge is not configured.", "Ask the service operator to configure the internal bridge.");
  if ((policyRevision === undefined || policyChecksum === undefined || !/^[a-f0-9]{64}$/.test(policyChecksum)) && method !== "echo" && method !== "runner.info") return fail("policy_pending", "The selected runner policy could not be verified.", "Wait for the runner to apply its control-plane policy, then retry.");
  // Validate the complete serialized request, including maximum correlation ID
  // and escaping, before forwarding any mutating operation to the Runner.
  try {
    encodeWireFrame(RpcRequestSchema.parse({ type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "r".repeat(128), method,
      params: params as JsonValue, ...(policyRevision === undefined ? {} : { policy_revision: policyRevision }) }));
  } catch { return fail("invalid_params", "Request exceeds the wire budget or is not JSON-safe; nothing was sent to the Runner.", "Reduce patch size, paths or expected hashes and retry."); }
  const authorization = await registryPostCall(env, "/auth/mcp/authorize-rpc", {
    ...env.mcpPrincipal, runner_id: runnerId, method,
    workspace_id: params.expected_workspace_id ?? params.workspace_id,
    ...(typeof params.job_id === "string" ? { job_id: params.job_id } : {}),
    policy_revision: policyRevision, policy_checksum: policyChecksum,
  });
  if (!authorization.ok || !isRecord(authorization.value) || authorization.value.ok !== true) {
    return fail("permission_denied", "The current client, workspace or policy no longer authorizes this operation.", "Refresh the current permissions and policy before retrying.");
  }
  const body = JSON.stringify({ method, params, mcp_authorization: env.mcpPrincipal, ...(policyRevision === undefined ? {} : { policy_revision: policyRevision, expected_policy_revision: policyRevision, expected_policy_checksum: policyChecksum }) });
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

function safeJobIdentifierFromResult(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.structuredContent)) return undefined;
  const direct = safeJobIdentifier(value.structuredContent.job_id);
  if (direct !== undefined) return direct;
  const job = isRecord(value.structuredContent.job) ? value.structuredContent.job : undefined;
  return job === undefined ? undefined : safeJobIdentifier(job.job_id);
}

function safeWorkspaceIdFromResult(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.structuredContent)) return null;
  const direct = safeJobIdentifier(value.structuredContent.workspace_id);
  if (direct !== undefined) return direct;
  const job = isRecord(value.structuredContent.job) ? value.structuredContent.job : undefined;
  return job === undefined ? null : safeJobIdentifier(job.workspace_id) ?? null;
}

function safeRunnerContextFromResult(value: unknown): { readonly runner_id?: string } | undefined {
  if (!isRecord(value) || !isRecord(value.structuredContent)) return undefined;
  const direct = isRecord(value.structuredContent.runner_context) ? value.structuredContent.runner_context : undefined;
  if (direct !== undefined) {
    const runnerId = safeJobIdentifier(direct.runner_id);
    return runnerId === undefined ? undefined : { runner_id: runnerId };
  }
  const error = isRecord(value.structuredContent.error) ? value.structuredContent.error : undefined;
  const details = error !== undefined && isRecord(error.details) ? error.details : undefined;
  if (details === undefined || !isRecord(details.runner_context)) return undefined;
  const runnerId = safeJobIdentifier(details.runner_context.runner_id);
  return runnerId === undefined ? undefined : { runner_id: runnerId };
}

function runnerListToolValue(value: readonly unknown[]): unknown {
  const runners = value.filter(isRecord).map((runner) => {
    const runnerId = safeJobIdentifier(runner.runner_id) ?? "unknown";
    const displayName = typeof runner.display_name === "string" && runner.display_name.length > 0 && runner.display_name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(runner.display_name) ? runner.display_name : runnerId;
    const state = runner.state === "online" || runner.state === "offline" || runner.state === "stale" ? runner.state : "unavailable";
    return { runner_id: runnerId, display_name: displayName, state, available: state === "online", updated_at_ms: isSafeNonnegativeInteger(runner.updated_at_ms) ? runner.updated_at_ms : null };
  });
  return success({ runners });
}

/** Public workspace metadata is intentionally smaller than the Registry row. */
function safeWorkspaceMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const workspaceId = safeJobIdentifier(value.workspace_id);
  if (workspaceId === undefined || typeof value.enabled !== "boolean" || !isRecord(value.permissions)) return undefined;
  const permissions = value.permissions;
  if (typeof permissions.read !== "boolean" || typeof permissions.edit !== "boolean" || typeof permissions.shell !== "boolean" || typeof permissions.job_control !== "boolean") return undefined;
  return { workspace_id: workspaceId, enabled: value.enabled, permissions: { read: permissions.read, edit: permissions.edit, shell: permissions.shell, job_control: permissions.job_control } };
}

async function registryCall(env: McpRequestEnv, path: string): Promise<ToolCall> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
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

async function registryPostCall(env: McpRequestEnv, path: string, input: Record<string, unknown>): Promise<ToolCall> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
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
type AuditReceipt = { readonly correlation_id: string; readonly audit_status: "recorded" | "degraded" | "unknown" };
async function recordRunnerToolCall(env: McpRequestEnv, input: {
  readonly runnerId: string;
  readonly clientId: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
  readonly startedAtMs: number;
  readonly workspaceId?: string;
  readonly jobId?: string;
  readonly readiness: ActivePolicyReadiness;
}): Promise<AuditReceipt> {
  const structuredContent = isRecord(input.result) && isRecord(input.result.structuredContent) ? input.result.structuredContent : undefined;
  const errorValue = structuredContent === undefined ? undefined : structuredContent.error;
  const errorCode = errorValue !== undefined && isRecord(errorValue) && typeof errorValue.code === "string"
    ? errorValue.code
    : "internal_error";
  const result = isRecord(input.result) && input.result.isError === true
    ? { status: "error" as const, error_code: errorCode }
    : { status: "ok" as const, error_code: null };
  const completedAtMs = Date.now();
  const jobId = input.jobId ?? safeJobIdentifierFromResult(input.result) ?? null;
  const runnerContext = safeRunnerContextFromResult(input.result);
  const correlationId = `call-${crypto.randomUUID()}`;
  const recorded = await registryPostCall(env, `/runners/${encodeURIComponent(input.runnerId)}/mcp-calls`, {
    call_id: correlationId,
    client_id: input.clientId,
    method: input.method,
    workspace_id: input.workspaceId ?? safeWorkspaceIdFromResult(input.result),
    job_id: jobId,
    status: result.status,
    error_code: result.error_code,
    // Audit transports metadata only: never send tool arguments or output.
    result_runner_id: runnerContext?.runner_id ?? null,
    started_at_ms: input.startedAtMs,
    completed_at_ms: completedAtMs,
    duration_ms: completedAtMs - input.startedAtMs,
    epoch: input.readiness.connection_epoch,
    credential_version: input.readiness.credential_version,
    lifecycle_id: input.readiness.lifecycle_id,
    session_id: input.readiness.session_id,
    now_ms: completedAtMs,
  });
  if (!recorded.ok) return { correlation_id: correlationId, audit_status: "unknown" };
  const status = isRecord(recorded.value) && (recorded.value.audit_status === "recorded" || recorded.value.audit_status === "degraded") ? recorded.value.audit_status : "unknown";
  return { correlation_id: correlationId, audit_status: status };
}
function withAuditReceipt(result: unknown, receipt: AuditReceipt): unknown {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return result;
  const structuredContent = { ...result.structuredContent, ...receipt };
  return { ...result, structuredContent, content: [{ type: "text", text: boundedText(structuredContent, CONTENT_LIMIT) }] };
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
  const error = { error: { code, message: message.slice(0, 4_096), recovery_hint: hint.slice(0, 4_096), ...failureMetadata(code) } };
  return { content: [{ type: "text", text: `Error (${code}): ${error.error.message}\nRecovery: ${error.error.recovery_hint}` }], structuredContent: error, isError: true };
}

function failureWithDetails(code: string, message: string, hint: string, details: unknown): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError: true } {
  const error = { error: { code, message: message.slice(0, 4_096), recovery_hint: hint.slice(0, 4_096), ...failureMetadata(code), details: redactAndBound(details, 8_192) } };
  return { content: [{ type: "text", text: `Error (${code}): ${error.error.message}\nRecovery: ${error.error.recovery_hint}` }], structuredContent: error, isError: true };
}

function failWithDetails(code: string, message: string, hint: string, details: unknown): ToolFailure { return { ok: false, error: { code, message, hint, details, ...failureMetadata(code) } }; }
function fail(code: string, message: string, hint: string): ToolFailure { return { ok: false, error: { code, message, hint, ...failureMetadata(code) } }; }
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
  if (utf8Encoder.encode(text).byteLength <= max) return text;
  const marker = "\n… truncated by MCP response limit";
  const markerBytes = utf8Encoder.encode(marker).byteLength;
  return `${truncateUtf8(text, Math.max(0, max - markerBytes))}${marker}`;
}
function redactAndBound(value: unknown, max: number): unknown {
  const redacted = redact(value, new WeakSet());
  const serialized = JSON.stringify(redacted) ?? "null";
  if (utf8Encoder.encode(serialized).byteLength <= max) return redacted;
  return { truncated: true, data: truncateUtf8(serialized, max), recovery_hint: "Use the tool's cursor, offset, or limit fields to paginate." };
}

/** Return a UTF-8 prefix without cutting a Unicode code point in half. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8Encoder.encode(codePoint).byteLength;
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (!isRecord(value) || seen.has(value)) return "[unavailable]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|secret|password|verifier|root|cwd|command|pid|process_start_fingerprint|recovery_liveness)/i.test(key)) continue;
    // Define properties explicitly instead of assigning to an ordinary
    // object.  A hostile RPC result can contain an own `__proto__` key;
    // `output[key] = ...` would invoke Object.prototype's legacy setter and
    // mutate the redaction envelope's prototype.
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: redact(item, seen),
      writable: true,
    });
  }
  return output;
}

export const MCP_TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));
export const MCP_SUPPORTED_SCOPES = SUPPORTED_SCOPES;
