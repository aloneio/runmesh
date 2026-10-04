// Diagnostic input can include credentials. Only fixed classifications cross
// this boundary; no response text, request arguments, IDs or log lines escape.
const contentTypes = ["json", "html", "text", "sse", "other", "absent"];
const bodyKinds = ["json_rpc_error", "empty", "non_json", "invalid_json", "not_rpc_error", "oversized", "read_timeout", "read_error"];
const phases = ["read_initial", "read_continuation", "other"];
const rpcCodes = [-32700, -32600, -32601, -32602, -32603, -32000, "other", "absent"];
const rpcIds = ["matches", "null", "absent", "other"];
const errorKinds = ["type_error", "range_error", "syntax_error", "abort_error", "error", "other"];
const stages = ["handler_dispatch", "server_factory", "sdk_transport"];
const reasons = ["invalid_auth_context", "conflicting_auth_context", "already_connected", "unknown"];
const HTTP_MARKER = "RUNMESH_E2E_MCP_HTTP_DIAGNOSTIC=";
const WORKER_MARKER = "RUNMESH_E2E_MCP_WORKER_EVENT=";
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

export async function mcpHttpFailure(response, requestId, name, args) {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const content_type = type === undefined ? "absent" : type === "application/json" ? "json"
    : type === "text/html" ? "html" : type === "text/plain" ? "text" : type === "text/event-stream" ? "sse" : "other";
  const phase = name === "read" ? (args.cursor === undefined ? "read_initial" : "read_continuation") : "other";
  const observed = await boundedBody(response);
  const detail = { content_type, phase, body_kind: observed.body_kind ?? "non_json", rpc_code: "absent", rpc_id: "absent" };
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
      || !bodyKinds.includes(value.body_kind) || !rpcCodes.includes(value.rpc_code) || !rpcIds.includes(value.rpc_id)) return undefined;
    return { content_type: value.content_type, phase: value.phase, body_kind: value.body_kind, rpc_code: value.rpc_code, rpc_id: value.rpc_id };
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
