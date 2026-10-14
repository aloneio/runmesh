const stages = ["registry_initialize", "registry_fetch", "runner_fetch", "runner_registry_sign", "runner_registry_fetch", "runner_mcp_authorization", "runner_heartbeat", "runner_session", "runner_message", "runner_history_sync", "runner_history_event",
  "mcp_reauthorize", "mcp_active_runner", "mcp_permissions", "mcp_policy_readiness", "mcp_workspaces", "mcp_job_snapshot", "mcp_rpc_authorization", "mcp_registry_read", "mcp_registry_post", "other"] as const;
const outcomes = ["exception", "deadline", "parent_abort", "unexpected_status", "length_limit", "empty_body", "empty_chunks", "fragment_limit", "body_limit", "invalid_json", "invalid_receipt", "other"] as const;
const phases = ["fetch", "body_read", "json_parse", "other"] as const;
export type ControlPlaneFailureStage = typeof stages[number];
export type ControlPlaneFailureOutcome = typeof outcomes[number];
export type ControlPlaneFailurePhase = typeof phases[number];

/** Log only fixed classifications; runtime exception text can contain credentials. */
export function reportControlPlaneFailure(stage: ControlPlaneFailureStage, outcome: ControlPlaneFailureOutcome, error?: unknown, status?: number, phase?: ControlPlaneFailurePhase): void {
  try {
    const kind = error instanceof TypeError ? "type_error" : error instanceof RangeError ? "range_error"
      : error instanceof SyntaxError ? "syntax_error" : error instanceof DOMException && error.name === "AbortError" ? "abort_error"
        : error instanceof Error ? "error" : "other";
    let reason = "unknown";
    switch (error instanceof Error ? error.message : undefined) {
      case "Network connection lost.": reason = "network_connection_lost"; break;
      case "Cannot perform I/O on behalf of a different request.": reason = "cross_request_io"; break;
      case "A promise was resolved or rejected from a different request context than the one it was created in.": reason = "cross_request_promise"; break;
      case "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.": reason = "hung_request"; break;
      case "This ReadableStream is locked to a reader.": reason = "locked_reader"; break;
    }
    const safeStage = stages.includes(stage) ? stage : "other";
    const safeOutcome = outcomes.includes(outcome) ? outcome : "other";
    const safeStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : "none";
    const phaseField = phase === undefined ? "" : ` phase=${phases.includes(phase) ? phase : "other"}`;
    console.warn(`RUNMESH_CONTROL_PLANE_FAILURE stage=${safeStage} outcome=${safeOutcome} kind=${kind} reason=${reason} status=${safeStatus}${phaseField}`);
  } catch {
    // Observability must preserve the original availability/error behavior.
  }
}
