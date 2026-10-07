import { WebSocketServer, type WebSocket } from "ws";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_CURRENT_VERSION, decodeWireFrame, encodeWireFrame, runnerPolicyChecksum, type RunnerSync, type RunnerWelcome, type WireMessage } from "@aloneio/runmesh-protocol";
import { RunnerConnection } from "../src/connection.js";
import { enrollRunner } from "../src/enrollment.js";
import { ProfileStore } from "../src/profile.js";
import { PolicyStore } from "../src/policy-store.js";
import type { WorkspaceConfig } from "../src/config.js";
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
async function transport(options: { autoWelcome?: boolean; history?: "batched" | "off"; heartbeatMs?: number; runtime?: Partial<ConnectionRuntimePort> } = {}) {
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
    policyStore: connectionPolicyStore(), heartbeatMs: options.heartbeatMs ?? 86_400_000,
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

it.each([
  { cached: "legacy", change: "runner", injected: false },
  { cached: "legacy", change: "runner", injected: true },
  { cached: "bound", change: "runner", injected: false },
  { cached: "bound", change: "credential", injected: true },
  { cached: "bound", change: "server", injected: false },
])("accepts fresh policy after successful re-enrollment ($cached cache, $change change, injected=$injected)", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "runner-reenroll-handshake-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  const endpoint = `http://127.0.0.1:${address.port}/runner/enroll`;
  const serverUrl = `ws://127.0.0.1:${address.port}/runner/connect`;
  const stateDir = join(root, "state"), workspace = join(root, "new-workspace");
  const profiles = new ProfileStore({ filePath: join(root, "profile", "profile.json") });
  const policies = new PolicyStore(stateDir);
  const original = { version: 1 as const, server_url: scenario.change === "server" ? "ws://127.0.0.1:1/runner/connect" : serverUrl,
    runner_id: "runner-original", token: "synthetic-original-token", insecure_local: true,
    management_mode: "central" as const, execution_mode: "dedicated_user" as const, workspaces: [] };
  const oldIdentity = { server: original.server_url, runnerId: original.runner_id, token: original.token };
  const permissions = { read: true, edit: false, shell: false, job_control: false };
  const oldFields = { schema_version: 1 as const, runner_id: original.runner_id, revision: 99, runner_permissions: permissions,
    workspaces: [{ workspace_id: "old-workspace", root_path: workspace, enabled: true, permissions }] };
  const oldPolicy = { ...oldFields, checksum: runnerPolicyChecksum(oldFields) };
  const preserved = ["jobs/old-job/meta.json", "jobs/old-job/output.log", "context/old-record.json", "updates/journal.json"];
  const frames: WireMessage[] = [];
  let peer: WebSocket | undefined, failure: unknown, connection: RunnerConnection | undefined, running: Promise<void> | undefined;
  let livePolicy: readonly WorkspaceConfig[] = [];
  const applied: string[][] = [];
  server.on("connection", socket => { peer = socket; socket.on("message", bytes => frames.push(decodeWireFrame(String(bytes)))); });
  try {
    await mkdir(workspace);
    await profiles.save(original);
    await policies.activate(oldPolicy, scenario.cached === "bound" ? oldIdentity : undefined);
    for (const name of preserved) { const path = join(stateDir, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `preserve:${name}`); }
    const enrolled = await enrollRunner({ server: endpoint, code: "x".repeat(43), reEnroll: true, insecureLocal: true, store: profiles,
      fetch: async () => new Response(JSON.stringify({ runner_id: scenario.change === "runner" ? "runner-replaced" : original.runner_id,
        server_url: serverUrl, token: scenario.change === "server" ? original.token : "synthetic-replacement-token" }), { status: 200 }),
    });
    const saved = await profiles.load(); expect(saved).toEqual(enrolled.profile);
    const config = { runnerId: enrolled.profile.runner_id, server: enrolled.profile.server_url, token: enrolled.profile.token, workspaces: [], stateDir };
    const fields = { ...oldFields, runner_id: config.runnerId, revision: 1,
      workspaces: [{ workspace_id: "new-workspace", root_path: workspace, enabled: true, permissions }] };
    const desired = { ...fields, checksum: runnerPolicyChecksum(fields) };
    const runtime = connectionRuntime({ applyPolicy: workspaces => { livePolicy = workspaces; applied.push(workspaces.map(item => item.workspaceId)); } });
    connection = new RunnerConnection({ config, runtime, ...(scenario.injected ? { policyStore: policies } : {}),
      heartbeatMs: 86_400_000, sleep: async () => { connection?.stop(); },
    });
    running = connection.start().catch(error => { failure = error; });
    await waitFor(() => frames.some(frame => frame.type === "runner.hello") || failure !== undefined);
    expect(failure).toBeUndefined(); expect(peer).toBeDefined();
    expect(livePolicy).toEqual([]);
    expect(applied.flat()).not.toContain("old-workspace");
    const hello = frames.find(frame => frame.type === "runner.hello")!;
    expect(hello).toMatchObject({ runner: { runner_id: config.runnerId } });
    peer!.send(encodeWireFrame({ ...welcomeFrame(hello.request_id), desired_policy: desired }));
    await waitFor(() => frames.some(frame => frame.type === "runner.policy_ack" && frame.status === "applied"));
    expect(livePolicy.map(item => item.workspaceId)).toEqual(["new-workspace"]);
    expect(frames).toContainEqual(expect.objectContaining({ type: "runner.policy_ack", desired_revision: 1, applied_revision: 1, applied_checksum: desired.checksum }));
    await expect(policies.load(config.runnerId, config)).resolves.toEqual(desired);
    await expect(policies.load(oldIdentity.runnerId, oldIdentity)).resolves.toBeUndefined();
    // A normal restart can restore the authenticated cache before welcome.
    connection.stop(); await running; frames.length = 0; applied.length = 0; livePolicy = [];
    connection = new RunnerConnection({ config, runtime, heartbeatMs: 86_400_000, sleep: async () => { connection?.stop(); } });
    running = connection.start().catch(error => { failure = error; });
    await waitFor(() => frames.some(frame => frame.type === "runner.hello") || failure !== undefined);
    expect(failure).toBeUndefined(); expect(applied).toEqual([["new-workspace"]]);
    for (const name of preserved) expect(await readFile(join(stateDir, name), "utf8")).toBe(`preserve:${name}`);
  } finally {
    connection?.stop(); await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("heartbeat reads current active history IDs through the job projection port", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let ids = ["long-running-job"];
  const activeHistoryJobIds = vi.fn(() => [...ids]);
  const f = await transport({ history: "off", heartbeatMs: 50, runtime: { jobs: { activeHistoryJobIds } } });
  try {
    await waitFor(() => f.states.includes("online"));
    await vi.advanceTimersByTimeAsync(50);
    await waitFor(() => f.frames.some(frame => frame.type === "runner.heartbeat"));
    expect(f.frames.findLast(frame => frame.type === "runner.heartbeat")).toMatchObject({ active_job_ids: ids });
    const before = f.frames.filter(frame => frame.type === "runner.heartbeat").length;
    ids = [];
    await vi.advanceTimersByTimeAsync(50);
    await waitFor(() => f.frames.filter(frame => frame.type === "runner.heartbeat").length > before);
    expect(f.frames.findLast(frame => frame.type === "runner.heartbeat")).toMatchObject({ active_job_ids: [] });
    expect(activeHistoryJobIds).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

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
