import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_CURRENT_VERSION, decodeWireFrame, encodeWireFrame, type RunnerSync, type RunnerWelcome, type WireMessage } from "@aloneio/runmesh-protocol";
import { RunnerConnection } from "../src/connection.js";
import type { ConnectionRuntimePort } from "../src/connection/ports.js";
import type { JobEvent } from "../src/jobs/records.js";
import { connectionPolicyStore, connectionRuntime } from "./helpers/connection-runtime.js";
import { jobRecord } from "./helpers/job-record.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}
function welcomeFrame(requestId: string): RunnerWelcome {
  return {
    type: "runner.welcome", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: requestId,
    session_id: "handshake-session", negotiated_protocol_version: PROTOCOL_CURRENT_VERSION,
    worker: { worker_id: "runmesh", worker_version: "test", capabilities: {
      filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
      max_concurrent_jobs: 1, supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "cloudflare" },
    } },
  };
}
async function transport(options: { autoWelcome?: boolean; history?: "batched" | "off"; runtime?: Partial<ConnectionRuntimePort> } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  const frames: WireMessage[] = [], states: string[] = [];
  let peer: WebSocket | undefined, acknowledge = true, sequence = 0, failure: unknown;
  let emitJobEvent: (event: JobEvent) => void = () => { throw new Error("runtime has not been constructed"); };
  const runtime = connectionRuntime(options.runtime);
  server.on("connection", socket => {
    peer = socket;
    socket.on("message", bytes => {
      const frame = decodeWireFrame(String(bytes)); frames.push(frame);
      if (frame.type === "runner.hello" && options.autoWelcome !== false) {
        const welcome = welcomeFrame(frame.request_id);
        if (options.history !== undefined) welcome.extensions = { runmesh_job_history: {
          mode: options.history, interval_seconds: 300, retention_days: 7, local_retention_days: 0,
        } };
        socket.send(encodeWireFrame(welcome));
      }
      if (frame.type === "runner.sync" && acknowledge) socket.send(encodeWireFrame({ type: "rpc.response",
        protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "history-" + frame.sync_sequence, result: { history_status: "recorded" } }));
    });
  });
  const connection = new RunnerConnection({
    config: { runnerId: "handshake-runner", server: "ws://127.0.0.1:" + address.port, token: "synthetic-token", workspaces: [] },
    policyStore: connectionPolicyStore(), heartbeatMs: 86_400_000,
    onStateChange: state => states.push(state), sleep: async () => { connection.stop(); },
  }, { createRuntime: sink => { emitJobEvent = sink; return runtime; } });
  const running = connection.start().catch(error => { failure = error; });
  const close = async () => {
    connection.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(failure).toBeUndefined();
  };
  try { await waitFor(() => frames.some(frame => frame.type === "runner.hello")); }
  catch (error) { await close(); throw error; }
  return {
    frames, states, runtime, close,
    emit: (event: JobEvent) => emitJobEvent(event),
    welcome: () => peer!.send(encodeWireFrame(welcomeFrame("hello-handshake"))),
    acknowledge: (value: boolean) => { acknowledge = value; },
    syncs: () => frames.filter((frame): frame is RunnerSync => frame.type === "runner.sync"),
    // An echo following an acknowledgement proves both were consumed in wire order.
    async flush() {
      const id = "barrier-" + ++sequence;
      peer!.send(encodeWireFrame({ type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: id, method: "echo", params: {} }));
      await waitFor(() => frames.some(frame => frame.type === "rpc.response" && frame.request_id === id));
    },
  };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("runner welcome handshake fencing", () => {
  it("withholds job lifecycle frames until the welcome handshake completes", async () => {
    const f = await transport({ autoWelcome: false });
    try {
      f.emit({ type: "started", job: jobRecord({ job_id: "before-welcome" }) });
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      expect(f.frames.map(frame => frame.type)).toEqual(["runner.hello"]);
      expect(f.states).not.toContain("online");
      f.welcome(); await waitFor(() => f.states.includes("online"));
      f.emit({ type: "started", job: jobRecord({ job_id: "after-welcome" }) });
      await waitFor(() => f.frames.some(frame => frame.type === "job.started"));
    } finally { await f.close(); }
  });
});
it("negotiates batched history, suppresses event-driven uploads, and retries without an acknowledgement", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let jobs: RunnerSync["jobs"] = [];
  const configureJobRetention = vi.fn();
  const f = await transport({ history: "batched", runtime: { syncJobs: async () => jobs, configureJobRetention } });
  try {
    await waitFor(() => f.syncs().length === 1); await f.flush();
    const before = f.frames.length;
    const records = Array.from({ length: 50 }, (_, i) => jobRecord({ job_id: "j-" + i, status: "succeeded", exit_code: 0 }));
    jobs = records.map(({ job_id, workspace_id, status, created_at_ms, updated_at_ms }) => ({
      job_id, workspace_id, status, created_at_ms, updated_at_ms, runner_id: "handshake-runner",
    }));
    for (const job of records) f.emit({ type: "completed", job });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    expect(f.frames).toHaveLength(before);
    f.acknowledge(false);
    await vi.advanceTimersByTimeAsync(300_000); await waitFor(() => f.syncs().length === 2);
    expect(f.syncs().at(-1)?.jobs).toHaveLength(50);
    await vi.advanceTimersByTimeAsync(300_000); await waitFor(() => f.syncs().length === 3);
    expect(f.syncs().at(-1)?.jobs).toEqual(f.syncs().at(-2)?.jobs);
    expect(f.frames.filter(frame => frame.type.startsWith("job."))).toHaveLength(0);
    expect(configureJobRetention).toHaveBeenCalledWith(0);
  } finally { await f.close(); }
});
it.each(["batched", "off"] as const)("%s idle history performs no redundant network upload across a simulated daily cadence", async mode => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const syncJobs = vi.fn(async () => []), cleanupJobs = vi.fn(async () => {});
  const f = await transport({ history: mode, runtime: { syncJobs, cleanupJobs } });
  try {
    await waitFor(() => f.states.includes("online"));
    if (mode === "batched") await waitFor(() => f.syncs().length === 1);
    await f.flush();
    const initial = f.syncs().length;
    for (let i = 0; i < 288; i++) await vi.advanceTimersByTimeAsync(300_000);
    await f.flush();
    expect(f.syncs()).toHaveLength(initial); expect(cleanupJobs).not.toHaveBeenCalled();
    if (mode === "off") {
      expect(initial).toBe(0); expect(syncJobs).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1); // Only the independent heartbeat remains scheduled.
    }
    console.log(JSON.stringify({ scenario: "idle_runner_history", mode, periodic_opportunities: 288, extra_uploads: 0 }));
  } finally { await f.close(); }
});
