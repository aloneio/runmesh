const MAX_COUNT = 2_147_483_647;
const MAX_DURATION_MS = 900_000;
const stages = ["ingress", "identity", "body", "setup", "dispatch", "priming", "stream", "complete"] as const;
const tools = ["read", "workspace_list", "job_get", "job_logs", "other"] as const;
const toolStages = ["none", "reauth", "action", "done"] as const;
const dependencies = ["none", "identity", "reauth", "active_runner", "permissions", "policy_readiness", "workspaces", "job_snapshot", "rpc_authorization", "registry_other"] as const;
const dependencyPhases = ["none", "sign", "fetch", "body"] as const;
const outcomes = ["eof", "cancelled", "error", "bodyless"] as const;
const timingNames = ["identity", "setup", "reauth", "action", "priming", "total", "registry_sign", "registry_fetch", "registry_body"] as const;
export type McpDiagnosticStage = typeof stages[number];
export type McpDiagnosticDependency = typeof dependencies[number];
type ToolStage = typeof toolStages[number];
type DependencyPhase = typeof dependencyPhases[number];
type Outcome = typeof outcomes[number];
type TimingName = typeof timingNames[number];
type Timing = Record<TimingName, number>;
export interface McpDiagnosticTrace {
  mark(stage: McpDiagnosticStage): void;
  classify(tool: unknown, action?: unknown): void;
  toolStage(stage: ToolStage): void;
  dependency(name: McpDiagnosticDependency, phase: DependencyPhase): void;
  finish(outcome: Outcome): void;
  serverTiming(): string;
}
interface Entry {
  sequence: number; tool: typeof tools[number]; stage: McpDiagnosticStage; tool_stage: ToolStage;
  dependency: McpDiagnosticDependency; dependency_phase: DependencyPhase; elapsed_ms: number;
}
interface Recent extends Entry { outcome: Outcome; timing: Timing }
const bounded = (value: number): number => Number.isFinite(value) ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value))) : 0;
const increment = (value: number): number => Math.min(MAX_COUNT, value + 1);

/** Test-only isolate observations. No identifiers, payloads, timers, I/O or retained requests. */
export function createMcpDiagnostics(now: () => number = () => performance.now()) {
  let entered = 0, finished = 0, dropped = 0, sequence = 0;
  const active = new Map<number, () => Entry>();
  const recent: Recent[] = [];
  return {
    snapshot(mode: string | undefined) {
      if (mode !== "1") return undefined;
      return { schema_version: 1 as const, entered, finished, dropped,
        active: [...active.values()].map(read => read()), recent: recent.map(item => ({ ...item, timing: { ...item.timing } })) };
    },
    begin(mode: string | undefined): McpDiagnosticTrace | undefined {
      if (mode !== "1") return undefined;
      entered = increment(entered);
      if (active.size >= 32) { dropped = increment(dropped); return undefined; }
      do { sequence = sequence >= MAX_COUNT ? 1 : sequence + 1; } while (active.has(sequence));
      const id = sequence, started = now();
      let complete = false;
      let finalTiming: Timing | undefined;
      const entry: Omit<Entry, "elapsed_ms"> = { sequence: id, tool: "other", stage: "ingress", tool_stage: "none", dependency: "none", dependency_phase: "none" };
      const timing = Object.fromEntries(timingNames.map(name => [name, 0])) as Timing;
      let httpTimer: { name: TimingName; started: number } | undefined;
      let toolTimer: { name: TimingName; started: number } | undefined;
      let dependencyTimer: { name: TimingName; started: number } | undefined;
      const add = (timer: typeof httpTimer, at: number): void => { if (timer) timing[timer.name] = bounded(timing[timer.name] + at - timer.started); };
      const readTiming = (at: number): Timing => {
        const result = { ...timing, total: bounded(at - started) };
        for (const timer of [httpTimer, toolTimer, dependencyTimer]) if (timer) result[timer.name] = bounded(result[timer.name] + at - timer.started);
        return result;
      };
      active.set(id, () => ({ ...entry, elapsed_ms: bounded(now() - started) }));
      return {
        mark(stage) {
          if (complete) return;
          const at = now(); add(httpTimer, at); httpTimer = undefined;
          entry.stage = stages.includes(stage) ? stage : "ingress";
          if (stage === "identity" || stage === "setup" || stage === "priming") httpTimer = { name: stage, started: at };
        },
        classify(tool, action) {
          if (complete) return;
          entry.tool = tool === "read" || tool === "workspace_list" ? tool : tool === "job" && action === "get" ? "job_get" : tool === "job" && action === "logs" ? "job_logs" : "other";
        },
        toolStage(stage) {
          if (complete) return;
          const at = now(); add(toolTimer, at); toolTimer = undefined;
          entry.tool_stage = toolStages.includes(stage) ? stage : "none";
          if (stage === "reauth" || stage === "action") toolTimer = { name: stage, started: at };
        },
        dependency(name, phase) {
          if (complete) return;
          const at = now(); add(dependencyTimer, at); dependencyTimer = undefined;
          entry.dependency = dependencies.includes(name) ? name : "registry_other";
          entry.dependency_phase = dependencyPhases.includes(phase) ? phase : "none";
          if (phase === "sign" || phase === "fetch" || phase === "body") dependencyTimer = { name: `registry_${phase}`, started: at };
        },
        finish(outcome) {
          if (complete) return;
          complete = true;
          const at = now();
          finalTiming = readTiming(at);
          recent.push({ ...entry, outcome: outcomes.includes(outcome) ? outcome : "error", elapsed_ms: bounded(at - started), timing: finalTiming });
          if (recent.length > 16) recent.shift();
          active.delete(id); finished = increment(finished);
        },
        serverTiming() {
          const values = finalTiming ?? readTiming(now());
          return timingNames.map(name => `rm_${name};dur=${values[name]}`).join(", ");
        },
      };
    },
  };
}

export const mcpDiagnostics = createMcpDiagnostics();

/** Observe EOF without reading ahead. Production passes the original Response through. */
export function observeMcpResponse(response: Response, trace?: McpDiagnosticTrace): Response {
  if (trace === undefined) return response;
  const headers = new Headers(response.headers);
  headers.set("server-timing", trace.serverTiming());
  if (response.body === null) {
    trace.finish("bodyless");
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  const reader = response.body.getReader();
  let cancelling = false;
  trace.mark("stream");
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { if (!cancelling) trace.finish("eof"); reader.releaseLock(); if (!cancelling) controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (!cancelling) trace.finish("error"); reader.releaseLock(); controller.error(error);
      }
    },
    async cancel(reason) {
      cancelling = true;
      try { await reader.cancel(reason); trace.finish("cancelled"); }
      catch (error) { trace.finish("error"); throw error; }
      finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
