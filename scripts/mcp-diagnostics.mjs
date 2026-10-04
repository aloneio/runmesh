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
const HTTP_MARKER = "RUNMESH_E2E_MCP_HTTP_DIAGNOSTIC=";
const WORKER_MARKER = "RUNMESH_E2E_MCP_WORKER_EVENT=";
const jobStatuses = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "unknown", "absent", "other"];
const clean = value => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
const record = value => typeof value === "object" && value !== null && !Array.isArray(value);

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
  const match = /^(?:\[(?:WARN|WARNING|ERROR)\]\s*|\u25b2 \[WARNING\] )?RUNMESH_MCP_HANDLER_ERROR kind=([a-z_]+) stage=([a-z_]+) reason=([a-z_]+)$/u.exec(clean(line).trim());
  return match && errorKinds.includes(match[1]) && stages.includes(match[2]) && reasons.includes(match[3])
    ? { event: "mcp_handler_error", kind: match[1], stage: match[2], reason: match[3] } : undefined;
}

export function createMcpWorkerDiagnosticForwarder(emit) {
  let pending = "", discard = false, emitted = 0;
  return chunk => {
    // A chunk or a line may start inside private output. Require one complete,
    // bounded marker line and emit a newly constructed object, never its text.
    for (const part of String(chunk).split(/(?<=\n)/u)) {
      const complete = part.endsWith("\n");
      if (!discard && pending.length + part.length <= 1024) pending += part;
      else { pending = ""; discard = true; }
      if (!complete) continue;
      const event = !discard && emitted < 16 ? workerEvent(pending) : undefined;
      if (event) { emitted++; emit(`${WORKER_MARKER}${JSON.stringify(event)}\n`); }
      pending = ""; discard = false;
    }
  };
}

export function mcpWorkerFailureEvidence(stderr) {
  if (typeof stderr !== "string") return [];
  const events = [];
  // Match execFile's capture bound so a later assertion cannot evict an earlier
  // fixed event. Retain at most sixteen freshly constructed records.
  const text = clean(stderr.slice(0, 8 * 1024 * 1024));
  for (const match of text.matchAll(/^RUNMESH_E2E_MCP_WORKER_EVENT=(\{[^\r\n]{1,256}\})\r?$/gmu)) {
    try {
      const value = JSON.parse(match[1]);
      if (record(value) && value.event === "mcp_handler_error" && errorKinds.includes(value.kind) && stages.includes(value.stage) && reasons.includes(value.reason))
        events.push({ event: "mcp_handler_error", kind: value.kind, stage: value.stage, reason: value.reason });
    } catch { /* Unrecognized private output contributes no diagnostics. */ }
    if (events.length === 16) break;
  }
  return events;
}
