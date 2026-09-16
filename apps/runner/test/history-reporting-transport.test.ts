import { WebSocketServer, type WebSocket } from "ws";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { decodeWireFrame, encodeWireFrame, runnerPolicyChecksum, type WireMessage } from "@aloneio/runmesh-protocol";
import { RunnerConnection } from "../src/connection.js";
import { RunnerRuntime } from "../src/runtime.js";
import type { HistoryUploadClock } from "../src/history-upload.js";

const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await pause(); }
  throw new Error("Synthetic transport did not settle");
}
class Clock implements HistoryUploadClock {
  public readonly tasks = new Map<number, { delay: number; callback: () => void }>();
  private sequence = 0;
  public schedule(delay: number, callback: () => void): () => void {
    const id = ++this.sequence; this.tasks.set(id, { delay, callback }); return () => { this.tasks.delete(id); };
  }
  public async step() {
    const entry = this.tasks.entries().next().value;
    if (entry) { this.tasks.delete(entry[0]); entry[1].callback(); }
    await pause();
  }
}

async function fixture(mode: "batched" | "off" | "immediate" = "batched", heartbeatMs = 3_600_000) {
  const base = await mkdtemp(join(tmpdir(), "runmesh-reporting-wire-"));
  const work = join(base, "work"); await mkdir(work); const root = await realpath(work);
  const full = { read: true, edit: true, shell: true, job_control: true };
  const raw = { schema_version: 1 as const, runner_id: "r", revision: 1, runner_permissions: full,
    workspaces: [{ workspace_id: "w", root_path: root, enabled: true, permissions: full }] };
  const policy = { ...raw, checksum: runnerPolicyChecksum(raw) };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing synthetic listener");
  const clock = new Clock(), frames: WireMessage[] = [];
  let peer: WebSocket | undefined, acknowledge = true, next = 0;
  server.on("connection", socket => { peer = socket; socket.on("message", bytes => {
    const frame = decodeWireFrame(String(bytes)); frames.push(frame);
    if (frame.type === "runner.hello") socket.send(encodeWireFrame({ type: "runner.welcome", protocol_version: 2,
      request_id: frame.request_id, session_id: "reporting-session", negotiated_protocol_version: 2,
      desired_policy: policy, extensions: { runmesh_job_reporting: 2,
        runmesh_job_history: { mode, interval_seconds: 60, retention_days: 7, local_retention_days: 0 } },
      worker: { worker_id: "test", worker_version: "test", capabilities: { filesystem: false, process_execution: false,
        workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1,
        supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "test" } } } }));
    if (frame.type === "runner.sync" && acknowledge) socket.send(encodeWireFrame({ type: "rpc.response", protocol_version: 2,
      request_id: `history-${frame.sync_sequence}`, result: { history_status: "recorded" } }));
  }); });
  const connection = new RunnerConnection({ config: { runnerId: "r", server: `ws://127.0.0.1:${address.port}`,
    token: "synthetic", stateDir: join(base, "state"), workspaces: [] }, historyClock: clock, heartbeatMs });
  let stoppedError: unknown;
  const running = connection.start().catch(error => { stoppedError = error; });
  await wait(() => frames.some(frame => frame.type === "runner.policy_ack" && frame.status === "applied") || stoppedError !== undefined);
  if (stoppedError !== undefined) throw stoppedError;
  await clock.step(); await clock.step();
  async function call(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const requestId = `test-${++next}`;
    peer!.send(encodeWireFrame({ type: "rpc.request", protocol_version: 2, request_id: requestId, method, policy_revision: 1, params }));
    await wait(() => frames.some(frame => (frame.type === "rpc.response" || frame.type === "rpc.error") && frame.request_id === requestId));
    const reply = frames.find(frame => (frame.type === "rpc.response" || frame.type === "rpc.error") && frame.request_id === requestId)!;
    if (reply.type !== "rpc.response") throw new Error("synthetic RPC did not succeed: " + JSON.stringify(reply));
    return reply.result as Record<string, any>;
  }
  return { clock, frames, call, acknowledge(value: boolean) { acknowledge = value; },
    syncs: () => frames.filter(frame => frame.type === "runner.sync"),
    launch: (owner: string, record: boolean, delay = 0) => call("exec.run", { workspace_id: "w", command: [process.execPath, "-e", `setTimeout(() => process.stdout.write('test-output'), ${delay})`],
      shell: false, created_by_client_id: owner, record_history: record, wait_ms: 4000 }),
    async close() { connection.stop(); await running; for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); },
  };
}

it("keeps control RPC responsive while two execution slots are occupied", async () => {
  const f = await fixture();
  try {
    const first = await f.call("exec.start", { workspace_id: "w", command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"], shell: false, created_by_client_id: "client-a", record_history: false });
    expect(first.status).toBe("running");
    const slow = f.launch("client-b", false, 1500);
    let control: any[] = [];
    const admissionDeadline = Date.now() + 1_500;
    while (Date.now() < admissionDeadline) {
      control = await Promise.race([
        f.call("job.list", { workspace_id: "w" }) as Promise<any[]>,
        pause(500).then(() => { throw new Error("control RPC was blocked behind execution"); }),
      ]);
      if (control.filter((job: any) => job.status === "running").length === 2) break;
      await pause(20);
    }
    expect(control.filter((job: any) => job.status === "running")).toHaveLength(2);
    const info = await f.call("env.info", { workspace_id: "w" });
    expect(info).toMatchObject({ runtime_capabilities: { max_concurrent_jobs: 2 }, job_scheduler: { running: 2, max_concurrent_jobs: 2, available_slots: 0 } });
    await f.call("job.cancel", { job_id: first.job_id, expected_workspace_id: "w" });
    await expect(slow).resolves.toMatchObject({ completed: true, job: { status: "succeeded" } });
  } finally { await f.close(); }
});

it("negotiated no-record execution and explicit log reads create no history traffic or sampling timer", async () => {
  const captures = vi.spyOn(RunnerRuntime.prototype, "syncJobs"); const f = await fixture();
  try {
    const initial = captures.mock.calls.length;
    const result = await f.launch("private-client", false); expect(result.job.status).toBe("succeeded");
    expect(await f.call("job.logs", { job_id: result.job.job_id, expected_workspace_id: "w", stream: "stdout" })).toMatchObject({ data: "test-output" });
    for (let i = 0; i < 288; i++) { for (const task of [...f.clock.tasks.values()]) task.callback(); }
    await pause(); expect(f.clock.tasks.size).toBe(0); expect(captures.mock.calls.length).toBe(initial); expect(f.syncs()).toHaveLength(0);
    console.log(JSON.stringify({ scenario: "no_record_and_log_read", periodic_opportunities: 288, additional_captures: 0, history_frames: 0 }));
  } finally { await f.close(); captures.mockRestore(); }
});

it("mixed-client batches include only recorded jobs; lost acknowledgements reuse captured metadata", async () => {
  const captures = vi.spyOn(RunnerRuntime.prototype, "syncJobs"); const f = await fixture();
  try {
    const privateJob = await f.launch("private-client", false), publicJob = await f.launch("recorded-client", true);
    expect(f.syncs()).toHaveLength(0); expect(f.clock.tasks.size).toBe(1);
    f.acknowledge(false); await f.clock.step(); await wait(() => f.syncs().length === 1);
    const afterCapture = captures.mock.calls.length;
    await f.clock.step(); await wait(() => f.syncs().length === 2);
    expect(captures.mock.calls.length).toBe(afterCapture);
    for (const frame of f.syncs()) {
      expect(frame.jobs.map(job => job.job_id)).toEqual([publicJob.job.job_id]);
      expect(JSON.stringify(frame)).not.toContain(privateJob.job.job_id);
      expect(JSON.stringify(frame)).not.toContain("test-output");
    }
    f.acknowledge(true); await f.clock.step(); await wait(() => f.clock.tasks.size === 0);
    expect(f.syncs()).toHaveLength(3);
  } finally { await f.close(); captures.mockRestore(); }
});

it("global off still permits live job results and logs without even a history bootstrap", async () => {
  const captures = vi.spyOn(RunnerRuntime.prototype, "syncJobs"); const f = await fixture("off");
  try {
    const result = await f.launch("recorded-client", true);
    expect(result.job.status).toBe("succeeded");
    expect(await f.call("job.logs", { job_id: result.job.job_id, expected_workspace_id: "w" })).toMatchObject({ data: "test-output" });
    expect(captures).not.toHaveBeenCalled(); expect(f.clock.tasks.size).toBe(0); expect(f.syncs()).toHaveLength(0);
  } finally { await f.close(); captures.mockRestore(); }
});

it("no-record jobs do not leak their active IDs through the independent heartbeat", async () => {
  const f = await fixture("batched", 50);
  try {
    const result = await f.launch("private-client", false, 250);
    const heartbeats = f.frames.filter(frame => frame.type === "runner.heartbeat");
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats.some(frame => frame.sent_at_ms >= result.job.created_at_ms && frame.sent_at_ms < result.job.completed_at_ms)).toBe(true);
    expect(heartbeats.every(frame => !frame.active_job_ids.includes(result.job.job_id))).toBe(true);
    expect(f.syncs()).toHaveLength(0); expect(f.clock.tasks.size).toBe(0);
  } finally { await f.close(); }
});
