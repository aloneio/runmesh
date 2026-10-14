import { boundedJsonReceipt, type BoundedJsonFailure } from "../bounded-json.js";
import { MAX_FRAME_BYTES } from "@aloneio/runmesh-protocol";
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
import { reportControlPlaneFailure, type ControlPlaneFailureStage } from "../platform/control-plane-diagnostics.js";
import type { McpDiagnosticDependency } from "../platform/mcp-diagnostics.js";

function safeRunnerErrorCode(value: unknown, fallback: string): string {
  return isKnownRpcFailureCode(value) ? value : fallback;
}

/** Classify a route without retaining its identifiers, query, or full path. */
function registryDiagnosticStage(path: string, method: "GET" | "POST"): ControlPlaneFailureStage {
  if (method === "POST") return path === "/auth/mcp/authorize-rpc" ? "mcp_rpc_authorization" : "mcp_registry_post";
  const segments = path.split("?", 1)[0]!.split("/");
  if (segments[1] === "auth" && segments[2] === "clients") {
    if (segments.length === 5 && segments[4] === "active-runner") return "mcp_active_runner";
    if (segments.length === 6 && segments[4] === "effective-permissions") return "mcp_permissions";
    if (segments.length === 6 && segments[4] === "effective-workspaces") return "mcp_workspaces";
  }
  if (segments[1] === "runners") {
    if (segments.length === 4 && segments[3] === "policy-readiness") return "mcp_policy_readiness";
    if (segments.length === 5 && segments[3] === "jobs") return "mcp_job_snapshot";
  }
  return "mcp_registry_read";
}

function reportRegistryFailure(stage: ControlPlaneFailureStage, failure: BoundedJsonFailure): void {
  // A missing record retains its normal not_found result, not an outage event.
  if (failure.outcome === "unexpected_status" && failure.status === 404) return;
  reportControlPlaneFailure(stage, failure.outcome, failure.error, failure.status, failure.phase);
}

function diagnosticDependency(stage: ControlPlaneFailureStage): McpDiagnosticDependency {
  switch (stage) {
    case "mcp_active_runner": return "active_runner";
    case "mcp_permissions": return "permissions";
    case "mcp_policy_readiness": return "policy_readiness";
    case "mcp_workspaces": return "workspaces";
    case "mcp_job_snapshot": return "job_snapshot";
    case "mcp_rpc_authorization": return "rpc_authorization";
    default: return "registry_other";
  }
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
  if (!isRecord(authorization.value) || typeof authorization.value.ok !== "boolean") {
    reportControlPlaneFailure("mcp_rpc_authorization", "invalid_receipt", undefined, 200);
    return fail("registry_unavailable", "Authorization service returned an invalid response.", "Retry later; nothing was sent to the Runner.", "not_started");
  }
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
  const stage = registryDiagnosticStage(path, "GET");
  const diagnostic = env.mcpDiagnostic, dependency = diagnosticDependency(stage);
  let headers: HeadersInit;
  diagnostic?.dependency(dependency, "sign");
  try { headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", path, ""); }
  catch (error) { reportControlPlaneFailure(stage, "exception", error); throw error; }
  try {
    diagnostic?.dependency(dependency, "fetch");
    const fetchResponse = (signal: AbortSignal) => env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "GET", headers, signal }));
    const response = await boundedJsonReceipt(diagnostic === undefined ? fetchResponse : async signal => {
      const result = await fetchResponse(signal); if (!signal.aborted) diagnostic.dependency(dependency, "body"); return result;
    }, [200], 5000, MAX_FRAME_BYTES, undefined, failure => reportRegistryFailure(stage, failure));
    diagnostic?.dependency("none", "none");
    if (response?.status === 200) return { ok: true, value: response.value };
    return fail(response?.status === 404 ? "not_found" : "registry_unavailable", response?.status === 404 ? "The requested registry record was not found." : "The registry is unavailable.", response?.status === 404 ? "Use runner_list to discover valid identifiers." : "Retry shortly; the runner may still be available for live tools.", "not_started");
  } catch (error) {
    reportControlPlaneFailure(stage, "exception", error);
    return fail("registry_unavailable", "The registry is unavailable.", "Retry shortly; the runner may still be available for live tools.", "not_started");
  }
}

export async function registryPostCall(env: McpRequestEnv, path: string, input: Record<string, unknown>, receiptKind: "completed" | "audit" = "completed"): Promise<ToolCall> {
  if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) return fail("service_unavailable", "The registry is not configured.", "Ask the service operator to configure the internal bridge.");
  const body = JSON.stringify(input);
  const stage = registryDiagnosticStage(path, "POST");
  const diagnostic = env.mcpDiagnostic, dependency = diagnosticDependency(stage);
  let headers: HeadersInit;
  diagnostic?.dependency(dependency, "sign");
  try { headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body); }
  catch (error) { reportControlPlaneFailure(stage, "exception", error); throw error; }
  try {
    diagnostic?.dependency(dependency, "fetch");
    const fetchResponse = (signal: AbortSignal) => env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body, signal }));
    const response = await boundedJsonReceipt(diagnostic === undefined ? fetchResponse : async signal => {
      const result = await fetchResponse(signal); if (!signal.aborted) diagnostic.dependency(dependency, "body"); return result;
    }, receiptKind === "audit" ? [200, 403, 409, 202] : [200, 403, 409], receiptKind === "audit" ? 750 : 5000, 16384, undefined, failure => reportRegistryFailure(stage, failure));
    diagnostic?.dependency("none", "none");
    // Authority and selection require completed JSON receipts at 200. Only
    // the audit caller opts into the documented disabled/degraded 202 receipt;
    // neither that receipt nor a conflict/denial can become an execution grant.
    const deferredAudit = receiptKind === "audit" && response?.status === 202;
    if (response !== undefined && (response.status === 200 || response.status === 409 || response.status === 403 || deferredAudit)) {
      const value = response.value;
      if (response.status === 200 || (isRecord(value) && (deferredAudit
        ? value.audit_status === "disabled" || value.audit_status === "degraded"
        : value.ok === false && typeof value.code === "string"))) return { ok: true, value };
      reportControlPlaneFailure(stage, "invalid_receipt", undefined, response.status);
    }
    return fail(response?.status === 404 ? "not_found" : "registry_unavailable", "The Registry did not return a completed or explicit denial receipt.", "Inspect the current state before retrying a mutation.", "unknown");
  } catch (error) { reportControlPlaneFailure(stage, "exception", error); return fail("registry_unavailable", "The Registry reply was not received.", "Inspect the current state before retrying a mutation.", "unknown"); }
}

async function json(response: Response): Promise<unknown> {
  // The bridge already bounds dispatch time. Bound its body separately so a
  // legitimate foreground command keeps its existing wait budget.
  return (await boundedJsonReceipt(async () => response, [response.status], 5000, MAX_FRAME_BYTES))?.value;
}
