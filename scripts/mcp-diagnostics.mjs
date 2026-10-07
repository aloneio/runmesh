// Diagnostic input can include credentials. Only fixed classifications cross
// this boundary; no response text, request arguments, IDs or log lines escape.
const contentTypes = ["json", "html", "text", "sse", "other", "absent"];
const bodyKinds = ["json_rpc_error", "empty", "non_json", "invalid_json", "not_rpc_error", "oversized", "read_timeout", "read_error"];
const phases = ["read_initial", "read_continuation", "runner_select", "shell", "edit", "job_get", "job_logs", "job_cancel", "other"];
const runtimeSignatures = new Map([
  ["network_connection_lost", "Network connection lost."],
  ["cross_request_io", "Cannot perform I/O on behalf of a different request."],
  ["cross_request_promise", "A promise was resolved or rejected from a different request context than the one it was created in."],
  ["hung_request", "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response."],
  ["locked_reader", "This ReadableStream is locked to a reader."],
]);
const rpcCodes = [-32700, -32600, -32601, -32602, -32603, -32000, "other", "absent"];
const rpcIds = ["matches", "null", "absent", "other"];
const errorKinds = ["type_error", "range_error", "syntax_error", "abort_error", "error", "other"];
const stages = ["request_validation", "identity_verification", "request_body", "module_loading", "provider_setup",
  "handler_dispatch", "server_factory", "sdk_transport", "response_priming", "response_headers"];
const reasons = ["invalid_auth_context", "conflicting_auth_context", "already_connected", "network_connection_lost", "unknown"];
const proxyMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const proxyAttempts = (method, attempts) => proxyMethods.includes(method) && Number.isInteger(attempts)
  && attempts >= 1 && attempts <= (["GET", "HEAD"].includes(method) ? 3 : 1);
const HTTP_MARKER = "RUNMESH_E2E_MCP_HTTP_DIAGNOSTIC=";
const TOOL_RESULT_MARKER = "RUNMESH_E2E_MCP_TOOL_RESULT_DIAGNOSTIC=";
const WORKER_MARKER = "RUNMESH_E2E_MCP_WORKER_EVENT=";
const jobStatuses = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "unknown", "absent", "other"];
const toolResultFields = {
  phase: ["inspect_search_initial", "inspect_search_continuation", "job_logs_initial", "job_logs_continuation", "job_logs_stderr", "other"],
  result: ["error", "success", "absent", "other"],
  // Fixed public RPC codes relevant to native tool admission and bounded reads.
  // Other codes remain classified as "other", never reflected from the result.
  error_code: ["invalid_params", "invalid_request", "invalid_path", "path_traversal", "invalid_workspace", "runner_not_selected",
    "permission_denied", "insufficient_scope", "readonly_workspace", "stale_policy", "policy_pending", "runner_not_active", "runner_expired", "runner_not_authorized",
    "runner_offline", "service_unavailable", "registry_unavailable", "control_plane_unavailable", "timeout", "runner_access_unavailable",
    "runner_upgrade_required", "runner_unavailable", "no_runners_available", "job_history_unavailable", "log_unavailable", "log_changed", "file_changed", "path_changed", "cursor_mismatch", "cursor_expired",
    "search_snapshot_changed", "not_found", "read_budget_exhausted", "snapshot_too_large", "file_too_large", "queue_full", "busy",
    "authorization_response_invalid", "internal_error", "runner_rpc_failed", "tool_result_invalid", "absent", "other"],
  failure_class: ["validation", "authorization", "availability", "conflict", "resource", "execution", "internal", "unknown", "absent", "other"],
  operation_state: ["not_started", "running", "committed", "unknown", "absent", "other"],
  next_action: ["correct_request", "refresh_permissions", "wait_and_retry", "re_read_and_retry", "inspect_job", "contact_operator", "absent", "other"],
};
const clean = value => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
const record = value => typeof value === "object" && value !== null && !Array.isArray(value);
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 8 * 1024 * 1024;
const countObservation = value => value === undefined ? "absent" : boundedCount(value) ? value : "other";
const countField = value => boundedCount(value) || value === "absent" || value === "other";
const logPhases = ["job_logs_initial", "job_logs_continuation", "job_logs_stderr"];
function logPageObservation(structured) {
  const data = structured?.data, cursor = structured?.next_cursor;
  return { data_type: data === undefined ? "absent" : typeof data === "string" ? "string" : "other",
    data_bytes: typeof data === "string" ? countObservation(Buffer.byteLength(data)) : "absent",
    returned_bytes: countObservation(structured?.returned_bytes), page_protocol: countObservation(structured?.page_protocol),
    next_cursor: cursor === undefined ? "absent" : cursor === null ? "null" : typeof cursor === "string" ? "string" : "other" };
}
function safeLogPage(value) {
  if (!record(value) || !["absent", "string", "other"].includes(value.data_type)
    || ![value.data_bytes, value.returned_bytes, value.page_protocol].every(countField)
    || !["absent", "null", "string", "other"].includes(value.next_cursor)) return undefined;
  return { data_type: value.data_type, data_bytes: value.data_bytes, returned_bytes: value.returned_bytes,
    page_protocol: value.page_protocol, next_cursor: value.next_cursor };
}

async function boundedBody(response) {
  if (response.body === null) return { body_kind: "empty" };
  let reader;
  try { reader = response.body.getReader(); } catch { return { body_kind: "read_error" }; }
  const maxBytes = 4096, deadline = performance.now() + 250;
  let timer, stopped = false;
  const read = async () => {
    const bytes = new Uint8Array(maxBytes);
    let size = 0, chunks = 0;
    try {
      for (;;) {
        if (stopped || performance.now() >= deadline) return { body_kind: "read_timeout" };
        const next = await reader.read();
        if (stopped || performance.now() >= deadline) return { body_kind: "read_timeout" };
        if (next.done) return size === 0 ? { body_kind: "empty" } : { bytes: bytes.subarray(0, size) };
        if (++chunks > 4096 || !(next.value instanceof Uint8Array) || next.value.byteLength > maxBytes - size) return { body_kind: "oversized" };
        bytes.set(next.value, size); size += next.value.byteLength;
      }
    } catch { return { body_kind: "read_error" }; }
  };
  try {
    return await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => resolve({ body_kind: "read_timeout" }), 250); })]);
  } finally {
    stopped = true; clearTimeout(timer);
    // Cancellation itself may never settle on a broken upstream stream.
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A cancelled pending read releases asynchronously. */ }
  }
}

function responseContentType(response) {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return type === undefined ? "absent" : type === "application/json" ? "json"
    : type === "text/html" ? "html" : type === "text/plain" ? "text" : type === "text/event-stream" ? "sse" : "other";
}

function responseRuntimeSignature(observed, contentType) {
  if (observed.bytes === undefined || contentType !== "text") return undefined;
  // Miniflare can format an uncaught runtime error as a text stack. Retain
  // only its fixed signature, not the stack or a claim about its root cause.
  const text = new TextDecoder().decode(observed.bytes);
  return [...runtimeSignatures].find(([, literal]) => ["", "Error: ", "TypeError: "].some(prefix => text.startsWith(prefix + literal)))?.[0];
}

export async function adminSetupHttpDiagnostic(response, stage) {
  const content_type = responseContentType(response);
  const observed = await boundedBody(response);
  const runtime_signature = responseRuntimeSignature(observed, content_type);
  const detail = {
    stage: ["runner_permissions", "workspace_create", "readonly_workspace_create", "context_workspace_create"].includes(stage) ? stage : "other",
    status: response.status, content_type, body_kind: observed.body_kind ?? "present",
    ...(runtime_signature === undefined ? {} : { runtime_signature }),
  };
  return `RUNMESH_E2E_ADMIN_SETUP_DIAGNOSTIC=${JSON.stringify(detail)}`;
}

export async function mcpHttpFailure(response, requestId, name, args) {
  const content_type = responseContentType(response);
  const phase = name === "read" ? (args.cursor === undefined ? "read_initial" : "read_continuation")
    : name === "runner_select" || name === "shell" || name === "edit" ? name
    : name === "job" && ["get", "logs", "cancel"].includes(args.action) ? `job_${args.action}` : "other";
  const observed = await boundedBody(response);
  const detail = { content_type, phase, body_kind: observed.body_kind ?? "non_json", rpc_code: "absent", rpc_id: "absent" };
  const runtime_signature = responseRuntimeSignature(observed, content_type);
  if (runtime_signature !== undefined) detail.runtime_signature = runtime_signature;
  if (observed.bytes !== undefined && content_type === "json") {
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes));
      detail.body_kind = record(value) && value.jsonrpc === "2.0" && record(value.error)
        && Number.isInteger(value.error.code) && typeof value.error.message === "string" ? "json_rpc_error" : "not_rpc_error";
      if (detail.body_kind === "json_rpc_error") {
        detail.rpc_code = typeof value.error.code === "number" && rpcCodes.includes(value.error.code) ? value.error.code : "other";
        detail.rpc_id = !Object.hasOwn(value, "id") ? "absent" : value.id === requestId ? "matches" : value.id === null ? "null" : "other";
      }
    } catch { detail.body_kind = "invalid_json"; }
  }
  return new Error(`RUNMESH_E2E_MCP_HTTP_STATUS=${response.status}\n${HTTP_MARKER}${JSON.stringify(detail)}`);
}

export function mcpHttpDiagnostic(text) {
  if (typeof text !== "string") return undefined;
  const raw = /^RUNMESH_E2E_MCP_HTTP_DIAGNOSTIC=(\{[^\r\n]{1,512}\})\r?$/mu.exec(text)?.[1];
  try {
    const value = JSON.parse(raw);
    if (!record(value) || !contentTypes.includes(value.content_type) || !phases.includes(value.phase)
      || !bodyKinds.includes(value.body_kind) || !rpcCodes.includes(value.rpc_code) || !rpcIds.includes(value.rpc_id)
      || (value.runtime_signature !== undefined && !runtimeSignatures.has(value.runtime_signature))) return undefined;
    return { content_type: value.content_type, phase: value.phase, body_kind: value.body_kind, rpc_code: value.rpc_code, rpc_id: value.rpc_id,
      ...(value.runtime_signature === undefined ? {} : { runtime_signature: value.runtime_signature }) };
  } catch { return undefined; }
}

/** A safe assertion message: never inspect free-form content, messages or details. */
export function mcpToolResultDiagnostic(phase, result) {
  const structured = record(result) && record(result.structuredContent) ? result.structuredContent : undefined;
  const error = structured?.error;
  const field = (name, value) => value === undefined ? "absent" : toolResultFields[name].includes(value) ? value : "other";
  const errorField = name => error === undefined ? undefined : record(error) ? error[name] : null;
  const flag = record(result) ? result.isError : undefined;
  const detail = {
    phase: toolResultFields.phase.includes(phase) ? phase : "other",
    result: flag === true ? "error" : flag === false ? "success" : flag === undefined ? "absent" : "other",
    error_code: field("error_code", errorField("code")),
    failure_class: field("failure_class", errorField("failure_class")),
    operation_state: field("operation_state", errorField("operation_state")),
    next_action: field("next_action", errorField("next_action")),
  };
  // Observe only byte counts and field kinds. No text, cursor value or job ID
  // crosses into the assertion marker, even when successful pages are invalid.
  if (logPhases.includes(detail.phase) && flag !== true) detail.pagination = logPageObservation(structured);
  // Assertion libraries prefix and suffix custom messages. Keep the marker on
  // its own complete line so the decoder never accepts surrounding free text.
  return `\n${TOOL_RESULT_MARKER}${JSON.stringify(detail)}\n`;
}

export function mcpToolResultFailureDiagnostic(text) {
  if (typeof text !== "string") return undefined;
  const raw = /^RUNMESH_E2E_MCP_TOOL_RESULT_DIAGNOSTIC=(\{[^\r\n]{1,768}\})\r?$/mu.exec(text)?.[1];
  try {
    const value = JSON.parse(raw);
    if (!record(value) || Object.entries(toolResultFields).some(([key, allowed]) => !allowed.includes(value[key]))) return undefined;
    const detail = Object.fromEntries(Object.keys(toolResultFields).map(key => [key, value[key]]));
    if (value.pagination !== undefined) {
      const pagination = safeLogPage(value.pagination);
      if (!logPhases.includes(detail.phase) || pagination === undefined) return undefined;
      detail.pagination = pagination;
    }
    return detail;
  } catch { return undefined; }
}

export function jobCompletionDiagnostic(text) {
  if (typeof text !== "string") return undefined;
  const raw = /^RUNMESH_E2E_JOB_COMPLETION_DIAGNOSTIC=(\{[^\r\n]{1,256}\})\r?$/mu.exec(text)?.[1];
  try {
    const value = JSON.parse(raw);
    if (!record(value) || !["timeout", "terminal_failure", "tool_error"].includes(value.outcome)
      || !jobStatuses.includes(value.status) || !(value.exit_code === null
        || (Number.isInteger(value.exit_code) && value.exit_code >= -2147483648 && value.exit_code <= 2147483647))) return undefined;
    return { outcome: value.outcome, status: value.status, exit_code: value.exit_code };
  } catch { return undefined; }
}

function workerEvent(line) {
  const text = clean(line).trim();
  const match = /^(?:\[(?:WARN|WARNING|ERROR)\]\s*|\u25b2 \[WARNING\] )?RUNMESH_MCP_HANDLER_ERROR kind=([a-z_]+) stage=([a-z_]+) reason=([a-z_]+)$/u.exec(text);
  if (match && errorKinds.includes(match[1]) && stages.includes(match[2]) && reasons.includes(match[3]))
    return { event: "mcp_handler_error", kind: match[1], stage: match[2], reason: match[3] };
  // Runtime failures can bypass the MCP handler entirely. Match complete fixed
  // messages, including the pinned Wrangler error prefix, never arbitrary logs.
  const runtime = text.replace(/^(?:\[(?:WARN|WARNING|ERROR)\]\s*|[\u25b2\u2718] \[(?:WARNING|ERROR)\] )/u, "").replace(/^Error: /u, "");
  for (const [signature, message] of runtimeSignatures) {
    if (runtime === message) return { event: "runtime_log", signature };
  }
  // Pinned Wrangler wraps an upstream fetch failure with its method, URL and
  // attempt count. Only the fixed classification and bounded numeric fields
  // leave this parser; the URL can contain an MCP credential.
  const proxy = /^Error inside ProxyWorker \(the affected request failed; the dev server continues\): (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (https?:\/\/[^\s\u0000-\u001f\u007f]+) \(failed after ([1-3]) (attempts?)\): Network connection lost\.$/u.exec(runtime);
  if (proxy && proxyAttempts(proxy[1], Number(proxy[3])) && proxy[4] === (proxy[3] === "1" ? "attempt" : "attempts")) {
    try { new URL(proxy[2]); } catch { return undefined; }
    return { event: "proxy_upstream_connection_lost", method: proxy[1], attempts: Number(proxy[3]) };
  }
  return undefined;
}

const launcherReasons = ["setup_failed", "test_failed", "unexpected_exit", "teardown_failed"];
const launcherSignals = ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGINT", "other"];
const fixtureNames = ["queue", "busy"];
const fixturePhases = ["primary", "release", "cancel", "observe"];
const fixtureFailureKinds = ["mcp_http_failure", "assertion_failed", "timeout", "other"];
const progressFixtures = ["job_recording", "job_history"];
const progressPhases = ["admin_login_page", "admin_login", "client_create", "runner_select", "recording_update", "history_settings", "history_restore", "shell", "job_logs", "job_metadata", "job_poll", "job_list"];
const progressBoundaries = ["headers", "body", "validation", "request", "filesystem", "poll"];
const exitCode = value => value === null || (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647);

function safeWorkerEvent(value) {
  if (!record(value)) return undefined;
  if (value.event === "mcp_handler_error" && errorKinds.includes(value.kind) && stages.includes(value.stage) && reasons.includes(value.reason))
    return { event: "mcp_handler_error", kind: value.kind, stage: value.stage, reason: value.reason };
  if (value.event === "runtime_log" && runtimeSignatures.has(value.signature)) return { event: "runtime_log", signature: value.signature };
  if (value.event === "proxy_upstream_connection_lost" && proxyAttempts(value.method, value.attempts))
    return { event: "proxy_upstream_connection_lost", method: value.method, attempts: value.attempts };
  if (value.event === "launcher_snapshot" && launcherReasons.includes(value.reason) && exitCode(value.exit_code)
    && (value.signal === null || launcherSignals.includes(value.signal)) && typeof value.teardown_started === "boolean" && typeof value.exited_before_teardown === "boolean")
    return { event: "launcher_snapshot", reason: value.reason, exit_code: value.exit_code, signal: value.signal,
      teardown_started: value.teardown_started, exited_before_teardown: value.exited_before_teardown };
  if (value.event === "fixture_progress" && progressFixtures.includes(value.fixture) && progressPhases.includes(value.phase)
    && progressBoundaries.includes(value.boundary) && Number.isInteger(value.elapsed_ms) && value.elapsed_ms >= 0 && value.elapsed_ms <= 900000)
    return { event: "fixture_progress", fixture: value.fixture, phase: value.phase, boundary: value.boundary, elapsed_ms: value.elapsed_ms };
  if (value.event === "fixture_failure" && fixtureNames.includes(value.fixture) && fixturePhases.includes(value.phase) && fixtureFailureKinds.includes(value.kind)) {
    const base = { event: "fixture_failure", fixture: value.fixture, phase: value.phase, kind: value.kind };
    if (value.kind !== "mcp_http_failure") return base;
    const detail = mcpHttpDiagnostic(HTTP_MARKER + JSON.stringify(value.mcp_response));
    return detail !== undefined && Number.isInteger(value.http_status) && value.http_status >= 100 && value.http_status <= 599
      ? { ...base, http_status: value.http_status, mcp_response: detail } : undefined;
  }
  return undefined;
}

function eventMarker(value) {
  const event = safeWorkerEvent(value);
  return event === undefined ? undefined : `${WORKER_MARKER}${JSON.stringify(event)}\n`;
}

/** This observes the Wrangler launcher, not the inner workerd process. */
export function mcpLauncherDiagnostic(value) {
  return eventMarker({ ...value, event: "launcher_snapshot" });
}

/** Failure-only snapshots identify a pending fixture boundary, never its inputs. */
export function mcpFixtureProgressDiagnostic(value) {
  return eventMarker({ ...value, event: "fixture_progress" });
}

/** Keep the primary failure and each cleanup phase distinct without error text. */
export function mcpFixtureFailureDiagnostic(fixture, phase, error) {
  const text = typeof error?.message === "string" ? error.message.slice(0, 16384) : "";
  const status = /^(?:Error: )?RUNMESH_E2E_MCP_HTTP_STATUS=([1-5]\d{2})\r?$/mu.exec(text)?.[1];
  const detail = mcpHttpDiagnostic(text);
  const kind = status !== undefined && detail !== undefined ? "mcp_http_failure"
    : error?.code === "ERR_ASSERTION" || error?.name === "AssertionError" ? "assertion_failed"
      : /timed? ?out|ETIMEDOUT/iu.test(text) ? "timeout" : "other";
  return eventMarker({ event: "fixture_failure", fixture, phase, kind,
    ...(kind === "mcp_http_failure" ? { http_status: Number(status), mcp_response: detail } : {}) });
}

function eventBudget() {
  const counts = new Map();
  return event => {
    // Separate bounds preserve launcher and fixture evidence during log floods.
    // Totals: 16 handler + 8 runtime + 8 proxy + 4 launcher + 2 primary + 16 cleanup + 2 progress = 56.
    const key = event.event === "fixture_progress" ? `progress:${event.fixture}`
      : event.event === "fixture_failure" ? `${event.fixture}:${event.phase === "primary" ? "primary" : "cleanup"}` : event.event;
    const limit = event.event === "fixture_progress" ? 1 : event.event === "mcp_handler_error" ? 16 : event.event === "launcher_snapshot" ? 4
      : event.event === "fixture_failure" && event.phase === "primary" ? 1 : 8;
    const count = counts.get(key) ?? 0;
    if (count >= limit) return false;
    counts.set(key, count + 1); return true;
  };
}

export function createMcpWorkerDiagnosticForwarder(emit) {
  let pending = "", discard = false;
  const admit = eventBudget();
  return chunk => {
    // A chunk or a line may start inside private output. Require one complete,
    // bounded marker line and emit a newly constructed object, never its text.
    for (const part of String(chunk).split(/(?<=\n)/u)) {
      const complete = part.endsWith("\n");
      if (!discard && pending.length + part.length <= 1024) pending += part;
      else { pending = ""; discard = true; }
      if (!complete) continue;
      const event = !discard ? workerEvent(pending) : undefined;
      if (event && admit(event)) emit(`${WORKER_MARKER}${JSON.stringify(event)}\n`);
      pending = ""; discard = false;
    }
  };
}

export function mcpWorkerFailureEvidence(stderr) {
  if (typeof stderr !== "string") return [];
  const events = [], admit = eventBudget();
  // Match execFile's capture bound so a later assertion cannot evict an earlier
  // fixed event. Each category retains its own bounded, reconstructed records.
  const text = clean(stderr.slice(0, 8 * 1024 * 1024));
  for (const match of text.matchAll(/^RUNMESH_E2E_MCP_WORKER_EVENT=(\{[^\r\n]{1,768}\})\r?$/gmu)) {
    try {
      const event = safeWorkerEvent(JSON.parse(match[1]));
      if (event !== undefined && admit(event)) events.push(event);
    } catch { /* Unrecognized private output contributes no diagnostics. */ }
  }
  return events;
}
