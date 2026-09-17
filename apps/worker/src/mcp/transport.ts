import { boundPageResponseProblem } from "./byte-pages.js";
import { encodeWireFrame } from "@aloneio/runmesh-protocol";
import { fail } from "./results/envelope.js";
import { failureMetadata } from "@aloneio/runmesh-protocol";
import { hintFor } from "./results/envelope.js";
import { internalHeaders } from "../security.js";
import { isBoundCursor } from "@aloneio/runmesh-protocol";
import { isConfiguredSecret } from "../security.js";
import { isKnownRpcFailureCode } from "@aloneio/runmesh-protocol";
import { isRecord } from "./results/primitives.js";
import { isSafeIdentifier } from "../security.js";
import type { JsonValue } from "@aloneio/runmesh-protocol";
import type { McpRequestEnv } from "./contracts.js";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { RpcRequestSchema } from "@aloneio/runmesh-protocol";
import { safeJobLogResult } from "./results/jobs.js";
import { safeReadResult } from "./results/files.js";
import type { ToolCall } from "./contracts.js";

function safeRunnerErrorCode(value: unknown, fallback: string): string {
  return isKnownRpcFailureCode(value) ? value : fallback;
}

export async function callRunner(env: McpRequestEnv, runnerId: string, method: string, params: Record<string, unknown>, policyRevision?: number, policyChecksum?: string, workspaceBoundJob = false): Promise<ToolCall> {
  if (!isSafeIdentifier(runnerId)) return fail("invalid_runner_id", "runner_id is invalid", "Use a runner identifier returned by runner_list.");
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The runner bridge is not configured.", "Ask the service operator to configure the internal bridge.", "not_started");
  if ((policyRevision === undefined || policyChecksum === undefined || !/^[a-f0-9]{64}$/.test(policyChecksum)) && method !== "echo" && method !== "runner.info") return fail("policy_pending", "The selected runner policy could not be verified.", "Wait for the runner to apply its control-plane policy, then retry.");
  // Validate the complete serialized request, including maximum correlation ID
  // and escaping, before forwarding any mutating operation to the Runner.
  try {
    encodeWireFrame(RpcRequestSchema.parse({ type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "r".repeat(128), method,
      params: params as JsonValue, ...(policyRevision === undefined ? {} : { policy_revision: policyRevision }) }));
  } catch { return fail("invalid_params", "Request exceeds the wire budget or is not JSON-safe; nothing was sent to the Runner.", "Reduce patch size, paths or expected hashes and retry."); }
  const authorization = await registryPostCall(env, "/auth/mcp/authorize-rpc", {
    ...env.mcpPrincipal, runner_id: runnerId, method, workspace_bound: workspaceBoundJob,
    workspace_id: params.expected_workspace_id ?? params.workspace_id,
    ...(typeof params.job_id === "string" ? { job_id: params.job_id } : {}),
    policy_revision: policyRevision, policy_checksum: policyChecksum,
  });
  if (!authorization.ok) return { ok: false, error: { ...authorization.error, ...failureMetadata(authorization.error.code, "not_started") } };
  if (!isRecord(authorization.value) || typeof authorization.value.ok !== "boolean") return fail("registry_unavailable", "Authorization service returned an invalid response.", "Retry later; nothing was sent to the Runner.", "not_started");
  if (authorization.value.ok !== true) {
    if (authorization.value.code === "runner_upgrade_required") return fail("runner_upgrade_required", "History-independent Job operations require Runner 0.1.1 or newer.", "Install a verified supported Runner before disabling cloud Job history.");
    return fail("permission_denied", "The current client, workspace or policy no longer authorizes this operation.", "Refresh the current permissions and policy before retrying.");
  }
  const body = JSON.stringify({ method, params, mcp_authorization: { ...env.mcpPrincipal, workspace_bound: workspaceBoundJob }, ...(policyRevision === undefined ? {} : { policy_revision: policyRevision, expected_policy_revision: policyRevision, expected_policy_checksum: policyChecksum }) });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", "/rpc", body);
  let response: Response;
  try {
    response = await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
  } catch {
    return fail("runner_offline", "The bridge reply was not received; the operation may already have started.", "Inspect the original Job or workspace state before submitting another mutation.", "unknown");
  }
  const payload = await json(response);
  if (response.status === 200 && isRecord(payload) && payload.type === "rpc.response" && Object.hasOwn(payload, "result")) {
    if ((method === "fs.read" || method === "job.logs") && (params.consistency === "snapshot" || params.consistency === "append" || isBoundCursor(params.cursor))) {
      const projected = method === "fs.read" ? safeReadResult(payload.result) : safeJobLogResult(payload.result);
      const problem = boundPageResponseProblem(method, params, payload.result, projected);
      if (problem !== undefined) return fail(problem, "The Runner did not return the requested bound page; no content is accepted.", problem === "runner_upgrade_required" ? "Use a verified compatible Runner or explicitly choose a fresh live read without a bound cursor." : "Start a fresh bounded read; do not join pages from different resources or generations.", "not_started");
    }
    return { ok: true, value: payload.result };
  }
  const bridgeError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const code = safeRunnerErrorCode(bridgeError?.code, "runner_rpc_failed");
  // Runner error details can include host filesystem paths. MCP exposes stable
  // error codes plus a safe recovery action rather than copying that text.
  const message = code === "runner_offline" ? "The runner is not connected." : "The runner rejected the request.";
  const rawState = bridgeError?.operation_state;
  const knownCode = isKnownRpcFailureCode(bridgeError?.code);
  const observedState = knownCode && (rawState === "not_started" || rawState === "unknown" || rawState === "running" || rawState === "committed") ? rawState : undefined;
  return fail(code, message, hintFor(code, observedState), observedState);
}

export function registryJobsPath(runnerId: string, filters: Record<string, unknown>): string {
  const query = new URLSearchParams();
  if (typeof filters.workspace_id === "string") query.set("workspace_id", filters.workspace_id);
  if (typeof filters.status === "string") query.set("status", filters.status);
  if (typeof filters.limit === "number") query.set("limit", String(filters.limit));
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `/runners/${encodeURIComponent(runnerId)}/jobs${suffix}`;
}

export async function registryCall(env: McpRequestEnv, path: string): Promise<ToolCall> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.", "not_started");
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", path, "");
  try {
    const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "GET", headers }));
    if (response.status === 200) return { ok: true, value: await json(response) };
    void response.body?.cancel().catch(() => undefined);
    return fail(response.status === 404 ? "not_found" : "registry_unavailable", response.status === 404 ? "The requested registry record was not found." : "The registry is unavailable.", response.status === 404 ? "Use runner_list to discover valid identifiers." : "Retry shortly; the runner may still be available for live tools.", "not_started");
  } catch {
    return fail("registry_unavailable", "The registry is unavailable.", "Retry shortly; the runner may still be available for live tools.", "not_started");
  }
}

export async function registryPostCall(env: McpRequestEnv, path: string, input: Record<string, unknown>, receiptKind: "completed" | "audit" = "completed"): Promise<ToolCall> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
  const body = JSON.stringify(input);
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body);
  try {
    const response = await env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body }));
    // Authority and selection require completed JSON receipts at 200. Only
    // the audit caller opts into the documented disabled/degraded 202 receipt;
    // neither that receipt nor a conflict/denial can become an execution grant.
    const deferredAudit = receiptKind === "audit" && response.status === 202;
    if (response.status === 200 || response.status === 409 || response.status === 403 || deferredAudit) {
      const value = await json(response);
      if (response.status === 200 || (isRecord(value) && (deferredAudit
        ? value.audit_status === "disabled" || value.audit_status === "degraded"
        : value.ok === false && typeof value.code === "string"))) return { ok: true, value };
    } else { void response.body?.cancel().catch(() => undefined); }
    return fail(response.status === 404 ? "not_found" : "registry_unavailable", "The Registry did not return a completed or explicit denial receipt.", "Inspect the current state before retrying a mutation.", "unknown");
  } catch { return fail("registry_unavailable", "The Registry reply was not received.", "Inspect the current state before retrying a mutation.", "unknown"); }
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}
