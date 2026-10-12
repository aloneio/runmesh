import assert from "node:assert/strict";
import { ROOT } from "./ci-report.mjs";
import { writeCiEvidenceFile } from "./evidence-io.mjs";

const MAX_SUPPLEMENT_BYTES = 65536;
const serialize = value => JSON.stringify(value, null, 2) + "\n";
function timingPriority(event) {
  switch (event?.event) {
    case "mcp_stage_snapshot": return 0;
    case "load_timing": return 1;
    case "mcp_stage_request": return event.scope === "active" ? 2 : 3;
    case "load_metric": return 4;
    default: return undefined;
  }
}

function boundedSupplement(value) {
  let body = serialize(value);
  if (Buffer.byteLength(body) <= MAX_SUPPLEMENT_BYTES || !Array.isArray(value?.worker_events)) return body;
  const candidates = value.worker_events.map((event, index) => ({ event, index, priority: timingPriority(event) }))
    .filter(item => item.priority !== undefined);
  if (candidates.length === 0) return body;
  const selected = new Set();
  const project = () => serialize({ ...value,
    worker_events: value.worker_events.filter((event, index) => timingPriority(event) === undefined || selected.has(index)),
    worker_event_truncation: { omitted: candidates.length - selected.size },
  });
  body = project();
  // Primary failures, source identity and runtime evidence own the budget.
  // An oversized base still fails publication instead of losing that evidence.
  assert.ok(Buffer.byteLength(body) <= MAX_SUPPLEMENT_BYTES, "supplement primary evidence exceeds its byte limit");
  for (let priority = 0; priority <= 4; priority++) {
    const groups = new Map();
    for (const item of candidates.filter(candidate => candidate.priority === priority)) {
      if (!groups.has(item.event.concurrency)) groups.set(item.event.concurrency, []);
      groups.get(item.event.concurrency).push(item);
    }
    const queues = [...groups.values()];
    const rounds = Math.max(0, ...queues.map(queue => queue.length));
    // Take one event from each concurrency group per round. A preceding group
    // cannot consume the later group's share of a given diagnostic priority.
    for (let round = 0; round < rounds; round++) for (const queue of queues) {
      const item = queue[round];
      if (item === undefined) continue;
      selected.add(item.index);
      const proposed = project();
      if (Buffer.byteLength(proposed) <= MAX_SUPPLEMENT_BYTES) body = proposed;
      else selected.delete(item.index);
    }
  }
  return body;
}

/** Explicit projected summaries only. A new attempt replaces old success
 * before any external process; never recursively copy a report directory. */
export async function writeSupplement(name, value, root = ROOT) {
  assert.ok(["package-e2e", "browser-tests", "transport-tests", "crossforge-evidence"].includes(name));
  const body = boundedSupplement(value); assert.ok(Buffer.byteLength(body) <= MAX_SUPPLEMENT_BYTES);
  await writeCiEvidenceFile(root, `${name}.json`, body);
}
