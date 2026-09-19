import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { MAX_FRAME_BYTES, PROTOCOL_CURRENT_VERSION, decodeWireFrame, encodeWireFrame, runnerPolicyChecksum, type WireMessage } from "@aloneio/runmesh-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { RunnerConnection } from "../src/connection.js";
import type { ConnectionRuntimePort, ConnectionTransportFactory } from "../src/connection/ports.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly send = vi.fn();
  readonly terminate = vi.fn(() => this.close(1006));
  close(code = 1000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }
  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); }
}
const welcome: WireMessage = {
  type: "runner.welcome", protocol_version: PROTOCOL_CURRENT_VERSION,
  request_id: "hello", session_id: "session", negotiated_protocol_version: PROTOCOL_CURRENT_VERSION,
  worker: { worker_id: "worker", worker_version: "test", capabilities: {
    filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
    max_concurrent_jobs: 1, supported_rpc_methods: ["echo"], labels: {},
  } },
};
function setup(overrides: Partial<ConnectionRuntimePort> = {}, restorePolicy = false, reconnect = false) {
  const socket = new Socket();
  const sockets: Socket[] = [];
  const createSocket = vi.fn<ConnectionTransportFactory>(() => {
    const next = sockets.length === 0 ? socket : new Socket(); sockets.push(next);
    return next as unknown as WebSocket;
  });
  const runtime: ConnectionRuntimePort = {
    initialize: async () => {}, applyPolicy: () => {}, dispatch: async () => undefined,
    configureJobRetention: () => {}, cleanupJobs: async () => {}, needsHistoryReconciliation: () => false,
    syncJobs: async () => [], syncWorkspaceMetadata: () => [], jobs: { list: () => [] },
    ...overrides,
  };
  const policyFields = { schema_version: 1 as const, runner_id: "runner", revision: 1,
    runner_permissions: { read: true, edit: true, shell: true, job_control: true }, workspaces: [] };
  const policy = { ...policyFields, checksum: runnerPolicyChecksum(policyFields) };
  const sleep = vi.fn(async () => { if (!reconnect) connection.stop(); });
  const connection = new RunnerConnection({ config: { runnerId: "runner", server: "ws://127.0.0.1:1", token: "synthetic", workspaces: [] }, sleep }, {
    runtime, policyStore: { load: async () => restorePolicy ? policy : undefined, activate: async () => {} }, createSocket,
  });
  return { connection, socket, sockets, createSocket, sleep };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([false, true])("bounds a stalled %s welcome/upgrade handshake and resumes recovery", async open => {
  vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
  const { connection, socket, sleep } = setup();
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    if (open) socket.open();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
    await started;
    expect(vi.getTimerCount()).toBe(0);
  } finally { connection.stop(); await started; }
});

it("sets the wire limit before websocket buffering and disables unused compression", async () => {
  const { connection, createSocket } = setup();
  const started = connection.start();
  try {
    await vi.waitFor(() => expect(createSocket).toHaveBeenCalledOnce());
    expect(createSocket.mock.calls[0]?.[1]).toMatchObject({ maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  } finally { connection.stop(); await started; }
});

it("retires the handshake deadline once welcomed and clears timers on stop", async () => {
  vi.useFakeTimers();
  const { connection, socket, sleep } = setup();
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open();
    socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.terminate).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    connection.stop(); await started;
    expect(vi.getTimerCount()).toBe(0);
  } finally { connection.stop(); await started; }
});

it("does not send RPC frames before welcome", async () => {
  vi.useFakeTimers();
  const { connection, socket } = setup();
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open();
    const before = socket.send.mock.calls.length;
    const outcome = connection.rpc("echo", {}).then(() => "accepted", () => "rejected");
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.send).toHaveBeenCalledTimes(before);
    expect(await outcome).toBe("rejected");
  } finally { connection.stop(); await started; }
});

it("bounds outstanding runtime work while reserving capacity for job control", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dispatch = vi.fn(async () => { await blocked; return {}; });
  const { connection, socket } = setup({ dispatch }, true);
  const started = connection.start();
  const request = (id: string, method: string) => socket.emit("message", Buffer.from(encodeWireFrame({
    type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: id,
    method, policy_revision: 1, params: {},
  })));
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open(); socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    for (let index = 0; index < 96; index++) request(`read-${index}`, "fs.read");
    expect(dispatch).toHaveBeenCalledTimes(60);
    for (let index = 0; index < 5; index++) request(`cancel-${index}`, "job.cancel");
    expect(dispatch).toHaveBeenCalledTimes(64);
    const errors = socket.send.mock.calls.map(([frame]) => decodeWireFrame(frame)).filter(frame => frame.type === "rpc.error");
    expect(errors).toHaveLength(37);
    expect(errors.every(frame => frame.error.code === "busy" && frame.error.operation_state === "not_started")).toBe(true);
    release(); await vi.advanceTimersByTimeAsync(0);
    request("read-after-completion", "fs.read");
    expect(dispatch).toHaveBeenCalledTimes(65);
  } finally { release(); connection.stop(); await started; }
});

it("coalesces repeated legacy sync triggers behind one slow snapshot", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let captures = 0;
  const syncJobs = vi.fn(async () => { if (++captures === 1) await blocked; return []; });
  const { connection, socket } = setup({ syncJobs });
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open(); socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    await vi.advanceTimersByTimeAsync(3_000_000);
    expect(syncJobs).toHaveBeenCalledOnce();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(syncJobs).toHaveBeenCalledTimes(2);
  } finally { release(); connection.stop(); await started; }
});

it("backpressured stdin cannot consume the cancellation reserve", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dispatch = vi.fn(async (method: string) => { if (method === "job.input") await blocked; return {}; });
  const { connection, socket } = setup({ dispatch }, true);
  const started = connection.start();
  const request = (id: string, method: string) => socket.emit("message", Buffer.from(encodeWireFrame({
    type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: id,
    method, policy_revision: 1, params: {},
  })));
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open(); socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    for (let index = 0; index < 64; index++) request(`input-${index}`, "job.input");
    expect(dispatch).toHaveBeenCalledTimes(60);
    request("cancel-blocked-child", "job.cancel"); await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenLastCalledWith("job.cancel", {});
    expect(dispatch).toHaveBeenCalledTimes(61);
    const replies = socket.send.mock.calls.map(([frame]) => decodeWireFrame(frame)).filter(frame => frame.type === "rpc.response");
    expect(replies.map(frame => frame.request_id)).toEqual(["cancel-blocked-child"]);
  } finally { release(); connection.stop(); await started; }
});

it("preserves the RPC budget across reconnect and discards stale-session replies", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dispatch = vi.fn(async () => { await blocked; return {}; });
  const { connection, socket, sockets } = setup({ dispatch }, true, true);
  const started = connection.start();
  const request = (target: Socket, id: string) => target.emit("message", Buffer.from(encodeWireFrame({
    type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: id,
    method: "fs.read", policy_revision: 1, params: {},
  })));
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open(); socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    for (let index = 0; index < 60; index++) request(socket, `old-${index}`);
    socket.close(1006); await vi.advanceTimersByTimeAsync(0);
    const replacement = sockets[1]!; expect(replacement).toBeDefined();
    replacement.open(); replacement.emit("message", Buffer.from(encodeWireFrame(welcome)));
    request(replacement, "new-busy"); expect(dispatch).toHaveBeenCalledTimes(60);
    release(); await vi.advanceTimersByTimeAsync(0);
    request(replacement, "new-admitted"); await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(61);
    const replies = replacement.send.mock.calls.map(([frame]) => decodeWireFrame(frame)).filter(frame => frame.type === "rpc.response");
    expect(replies.map(frame => frame.request_id)).toEqual(["new-admitted"]);
  } finally { release(); connection.stop(); await started; }
});

it("a stalled old sync does not block a replacement socket or publish its stale snapshot", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let captures = 0;
  const syncJobs = vi.fn(async () => { if (++captures === 1) await blocked; return []; });
  const { connection, socket, sockets } = setup({ syncJobs }, false, true);
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open(); socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    await vi.advanceTimersByTimeAsync(0); expect(syncJobs).toHaveBeenCalledOnce();
    socket.close(1006); await vi.advanceTimersByTimeAsync(0);
    const replacement = sockets[1]!; replacement.open(); replacement.emit("message", Buffer.from(encodeWireFrame(welcome)));
    await vi.advanceTimersByTimeAsync(0); expect(syncJobs).toHaveBeenCalledTimes(2);
    release(); await vi.advanceTimersByTimeAsync(0);
    const syncs = replacement.send.mock.calls.map(([frame]) => decodeWireFrame(frame)).filter(frame => frame.type === "runner.sync");
    expect(syncs).toHaveLength(1);
  } finally { release(); connection.stop(); await started; }
});

it("rejects invalid UTF-8 binary frames before dispatch instead of repairing their contents", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
  const { connection, socket } = setup();
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0); socket.open(); socket.emit("message", Buffer.from(encodeWireFrame(welcome)));
    const prefix = Buffer.from('{"type":"rpc.request","protocol_version":2,"request_id":"invalid-utf8","method":"echo","params":{"value":"');
    socket.emit("message", Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}}')]));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    const replies = socket.send.mock.calls.map(([frame]) => decodeWireFrame(frame)).filter(frame => frame.type === "rpc.response");
    expect(replies).toHaveLength(0);
  } finally { connection.stop(); await started; }
});

it("bounds snapshot captures across repeated replacement sockets and recovers on the next sync opportunity", async () => {
  vi.useFakeTimers(); vi.spyOn(console, "error").mockImplementation(() => {});
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const syncJobs = vi.fn(async () => { await blocked; return []; });
  const { connection, sockets } = setup({ syncJobs }, false, true);
  const started = connection.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 5; index++) {
      const current = sockets[index]!; current.open(); current.emit("message", Buffer.from(encodeWireFrame(welcome)));
      await vi.advanceTimersByTimeAsync(0);
      if (index < 4) { current.close(1006); await vi.advanceTimersByTimeAsync(0); }
    }
    expect(syncJobs).toHaveBeenCalledTimes(2);
    release(); await vi.advanceTimersByTimeAsync(30_000);
    expect(syncJobs).toHaveBeenCalledTimes(3);
    const syncs = sockets[4]!.send.mock.calls.map(([frame]) => decodeWireFrame(frame)).filter(frame => frame.type === "runner.sync");
    expect(syncs).toHaveLength(1);
  } finally { release(); connection.stop(); await started; }
});
