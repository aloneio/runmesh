// Test-only observations are projected twice: before emission and when archived.
// No request identifiers, paths, header text or result content cross this boundary.
const operations = ["read", "workspace_list", "job_get", "job_logs"];
const serverMetrics = ["identity", "setup", "reauth", "action", "priming", "total", "registry_sign", "registry_fetch", "registry_body"];
const metrics = ["headers", "body", "total", ...serverMetrics.map(name => `server_${name}`)];
const stages = ["ingress", "identity", "body", "setup", "dispatch", "priming", "stream", "complete"];
const toolStages = ["none", "reauth", "action", "done"];
const dependencies = ["none", "identity", "reauth", "active_runner", "permissions", "policy_readiness", "workspaces", "job_snapshot", "rpc_authorization", "registry_other"];
const dependencyPhases = ["none", "sign", "fetch", "body"];
const outcomes = ["eof", "cancelled", "error", "bodyless"];
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const count = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const milliseconds = value => Number.isInteger(value) && value >= 0 && value <= 900000;
const concurrency = value => [1, 4, 8, 16].includes(value);
const marker = value => `RUNMESH_E2E_MCP_WORKER_EVENT=${JSON.stringify(value)}\n`;

function distribution(value) {
  if (!record(value) || !Number.isInteger(value.samples) || value.samples < 0 || value.samples > 32) return undefined;
  const points = [value.p50_ms, value.p95_ms, value.max_ms];
  if (value.samples === 0 ? !points.every(point => point === null)
    : !points.every(milliseconds) || value.p50_ms > value.p95_ms || value.p95_ms > value.max_ms) return undefined;
  return { samples: value.samples, p50_ms: value.p50_ms, p95_ms: value.p95_ms, max_ms: value.max_ms };
}

function timing(value) {
  if (!record(value) || !serverMetrics.every(name => milliseconds(value[name]))) return undefined;
  return Object.fromEntries(serverMetrics.map(name => [name, value[name]]));
}

function stageRequest(value, scope) {
  if (!record(value) || !count(value.sequence) || value.sequence === 0 || ![...operations, "other"].includes(value.tool)
    || !stages.includes(value.stage) || !toolStages.includes(value.tool_stage) || !milliseconds(value.elapsed_ms)
    || !dependencies.includes(value.dependency) || !dependencyPhases.includes(value.dependency_phase)) return undefined;
  const result = { sequence: value.sequence, tool: value.tool, stage: value.stage, tool_stage: value.tool_stage,
    dependency: value.dependency, dependency_phase: value.dependency_phase, elapsed_ms: value.elapsed_ms };
  if (scope === "active") return result;
  const observed = timing(value.timing);
  return outcomes.includes(value.outcome) && observed !== undefined ? { ...result, outcome: value.outcome, timing: observed } : undefined;
}

/** Parse only fixture-owned duration fields; never return header text. */
export function mcpServerTiming(header) {
  if (typeof header !== "string" || header.length > 1024) return {};
  const result = {};
  for (const part of header.split(",")) {
    const match = /^\s*rm_(identity|setup|reauth|action|priming|total|registry_sign|registry_fetch|registry_body);dur=(\d{1,6}(?:\.\d{1,3})?)\s*$/u.exec(part);
    if (match === null) continue;
    const name = match[1], value = Number(match[2]);
    if (Object.hasOwn(result, name) || !Number.isFinite(value) || value < 0 || value > 900000) return {};
    result[name] = Math.round(value);
  }
  return result;
}

/** Events stay below the existing 768-character archive line limit. */
export function safeMcpTimingEvent(value) {
  if (!record(value) || !concurrency(value.concurrency)) return undefined;
  const base = { event: value.event, concurrency: value.concurrency };
  if (value.event === "load_timing" && operations.includes(value.operation) && ["passed", "failed"].includes(value.outcome)
    && milliseconds(value.elapsed_ms) && [value.started, value.completed, value.failed].every(number => Number.isInteger(number) && number >= 0 && number <= 32)
    && value.completed + value.failed <= value.started)
    return { ...base, operation: value.operation, outcome: value.outcome, elapsed_ms: value.elapsed_ms,
      started: value.started, completed: value.completed, failed: value.failed };
  if (value.event === "load_metric" && operations.includes(value.operation) && metrics.includes(value.metric)) {
    const observed = distribution(value);
    return observed === undefined ? undefined : { ...base, operation: value.operation, metric: value.metric, ...observed };
  }
  if (value.event === "mcp_stage_snapshot" && ["received", "timeout", "http_error", "invalid", "unavailable"].includes(value.outcome)) {
    const result = { ...base, outcome: value.outcome };
    if (value.outcome !== "received") return result;
    return value.schema_version === 1 && [value.entered, value.finished, value.dropped].every(count) && value.finished <= value.entered
      ? { ...result, schema_version: 1, entered: value.entered, finished: value.finished, dropped: value.dropped } : undefined;
  }
  if (value.event === "mcp_stage_request" && ["active", "recent"].includes(value.scope)
    && Number.isInteger(value.slot) && value.slot >= 1 && value.slot <= (value.scope === "active" ? 32 : 16)) {
    const observed = stageRequest(value, value.scope);
    return observed === undefined ? undefined : { ...base, scope: value.scope, slot: value.slot, ...observed };
  }
  return undefined;
}

/** Incomplete requests remain counted as started, separate from completed samples. */
export function mcpLoadTimingDiagnostic(value) {
  if (!record(value) || !Array.isArray(value.operations) || value.operations.length !== 4
    || new Set(value.operations.map(item => item?.operation)).size !== 4) return undefined;
  const events = [];
  for (const item of value.operations) {
    if (!record(item)) return undefined;
    const summary = safeMcpTimingEvent({ ...item, event: "load_timing", concurrency: value.concurrency, outcome: value.outcome, elapsed_ms: value.elapsed_ms });
    if (summary === undefined) return undefined;
    events.push(summary);
    const measurements = [...["headers", "body", "total"].map(name => [name, item[name]])];
    if (item.server_timing !== undefined) {
      if (!record(item.server_timing)) return undefined;
      for (const name of serverMetrics) if (Object.hasOwn(item.server_timing, name)) measurements.push([`server_${name}`, item.server_timing[name]]);
    }
    for (const [metric, observed] of measurements) {
      const entry = safeMcpTimingEvent({ ...observed, event: "load_metric", concurrency: value.concurrency, operation: item.operation, metric });
      if (entry === undefined || entry.samples > item.started) return undefined;
      events.push(entry);
    }
  }
  return events.map(marker).join("");
}

/** A snapshot may disappear with an isolate; absence never proves runtime health. */
export function mcpWorkerSnapshotDiagnostic(value) {
  if (!record(value) || !concurrency(value.concurrency)) return undefined;
  const invalid = () => marker({ event: "mcp_stage_snapshot", concurrency: value.concurrency, outcome: "invalid" });
  if (value.outcome !== "received") {
    const observed = safeMcpTimingEvent({ event: "mcp_stage_snapshot", concurrency: value.concurrency, outcome: value.outcome });
    return observed === undefined ? undefined : marker(observed);
  }
  const snapshot = value.diagnostics;
  if (!record(snapshot) || !Array.isArray(snapshot.active) || snapshot.active.length > 32
    || !Array.isArray(snapshot.recent) || snapshot.recent.length > 16) return invalid();
  const header = safeMcpTimingEvent({ ...snapshot, event: "mcp_stage_snapshot", concurrency: value.concurrency, outcome: "received" });
  if (header === undefined) return invalid();
  const events = [header], sequences = new Set();
  for (const scope of ["active", "recent"]) for (const [index, item] of snapshot[scope].entries()) {
    const observed = safeMcpTimingEvent({ ...item, event: "mcp_stage_request", concurrency: value.concurrency, scope, slot: index + 1 });
    if (observed === undefined || sequences.has(observed.sequence)) return invalid();
    sequences.add(observed.sequence); events.push(observed);
  }
  return events.map(marker).join("");
}

export function mcpTimingEventBudgetKey(event) {
  switch (event.event) {
    case "load_timing": return `timing:${event.concurrency}:${event.operation}`;
    case "load_metric": return `metric:${event.concurrency}:${event.operation}:${event.metric}`;
    case "mcp_stage_snapshot": return `snapshot:${event.concurrency}`;
    case "mcp_stage_request": return `stage:${event.concurrency}:${event.scope}:${event.slot}`;
    default: return undefined;
  }
}
