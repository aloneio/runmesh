import {
  decodeWireFrame,
  encodeWireFrame,
  LOCAL_RUNNER_OPERATION_TIMEOUT_MS,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  type CapabilityMetadata,
  type RunnerMetadata,
  type RunnerSync,
  type RpcRequest,
  type WireMessage,
} from "@remote-coding-runtime/protocol";
import WebSocket from "ws";
import { reconnectDelayMs } from "./backoff.js";
import type { RunnerConfig } from "./config.js";
import { RunnerRuntime, rpcError } from "./runtime.js";

export interface RunnerConnectionOptions {
  readonly config: RunnerConfig;
  readonly version?: string;
  readonly heartbeatMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly syncMs?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onStateChange?: (state: "connecting" | "online" | "offline") => void;
  readonly runtime?: RunnerRuntime;
}

export class RunnerConnection {
  private readonly config: RunnerConfig;
  private readonly metadata: RunnerMetadata;
  private readonly heartbeatMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly syncMs: number;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onStateChange: (state: "connecting" | "online" | "offline") => void;
  private readonly runtime: RunnerRuntime;
  private socket: WebSocket | undefined;
  private stopped = false;
  private reconnectAttempt = 0;
  private syncSequence = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  public constructor(options: RunnerConnectionOptions) {
    this.config = options.config;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? LOCAL_RUNNER_OPERATION_TIMEOUT_MS;
    this.syncMs = options.syncMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.runtime = options.runtime ?? new RunnerRuntime({ config: this.config, ...(this.config.stateDir === undefined ? {} : { stateDir: this.config.stateDir }), onJobEvent: (event) => this.forwardJobEvent(event) });
    this.metadata = {
      runner_id: this.config.runnerId,
      runner_version: options.version ?? "0.1.0",
      platform: process.platform,
      architecture: process.arch,
      capabilities: discoverCapabilities(this.config.maxConcurrentJobs ?? 1),
    };
  }

  public async start(): Promise<void> {
    await this.runtime.initialize();
    this.stopped = false;
    while (!this.stopped) {
      this.onStateChange("connecting");
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
      } catch {
        this.onStateChange("offline");
        if (this.stopped) break;
        await this.sleep(reconnectDelayMs(this.reconnectAttempt, this.random()));
        this.reconnectAttempt += 1;
      }
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.syncTimer !== undefined) clearInterval(this.syncTimer);
    this.socket?.close(1000, "runner stopped");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("runner stopped"));
    }
    this.pending.clear();
  }

  /** Test/operator control: close only the transport; local JobManager continues. */
  public disconnectForTest(): void {
    this.socket?.close(4002, "controlled transport disconnect");
  }
  public rpc(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("runner is not connected"));
    }
    const requestId = `rpc-${crypto.randomUUID()}`;
    const request: RpcRequest = {
      type: "rpc.request",
      protocol_version: PROTOCOL_CURRENT_VERSION,
      request_id: requestId,
      method,
      params: params as RpcRequest["params"],
    };
    socket.send(encodeWireFrame(request));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC request timed out: ${method}`));
      }, this.rpcTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.server);
      url.pathname = url.pathname.endsWith("/") ? `${url.pathname}runner/connect` : `${url.pathname}/runner/connect`;
      url.searchParams.set("runner_id", this.config.runnerId);
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` } });
      this.socket = socket;
      let welcomed = false;
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      socket.once("open", () => {
        const hello: WireMessage = {
          type: "runner.hello",
          protocol_version: PROTOCOL_CURRENT_VERSION,
          request_id: `hello-${crypto.randomUUID()}`,
          runner: this.metadata,
          min_protocol_version: PROTOCOL_MIN_VERSION,
          max_protocol_version: PROTOCOL_CURRENT_VERSION,
        };
        socket.send(encodeWireFrame(hello));
      });
      socket.on("message", (value: WebSocket.RawData) => {
        let message: WireMessage;
        try {
          message = decodeWireFrame(value.toString());
        } catch {
          socket.close(1007, "invalid protocol frame");
          return;
        }
        if (message.type === "runner.welcome") {
          welcomed = true;
          this.onStateChange("online");
          void this.sendSync(socket);
          this.heartbeatTimer = setInterval(() => this.sendHeartbeat(socket), this.heartbeatMs);
          this.syncTimer = setInterval(() => { void this.sendSync(socket); }, this.syncMs);
          // Stay pending until close so start() reconnects only after a real session ends.
          return;
        }
        if (message.type === "rpc.request") {
          void this.respondToRpc(socket, message);
          return;
        }
        if (message.type === "rpc.response" || message.type === "rpc.error") {
          const pending = this.pending.get(message.request_id);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.request_id);
          if (message.type === "rpc.response") pending.resolve(message.result);
          else pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        }
      });
      socket.once("error", (error: Error) => {
        this.rejectPendingForSocket(socket, error);
        if (!welcomed) fail(error);
      });
      socket.once("close", () => {
        if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
        if (this.syncTimer !== undefined) clearInterval(this.syncTimer);
        this.heartbeatTimer = undefined;
        this.syncTimer = undefined;
        this.rejectPendingForSocket(socket, new Error("runner connection closed"));
        if (this.socket === socket) this.socket = undefined;
        if (!this.stopped) fail(new Error(welcomed ? "connection closed" : "connection closed before welcome"));
        else if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeWireFrame({
      type: "runner.heartbeat",
      protocol_version: PROTOCOL_CURRENT_VERSION,
      runner_id: this.config.runnerId,
      sent_at_ms: Date.now(),
      active_job_ids: this.runtime.jobs.list().filter((job) => ["queued", "running", "cancelling"].includes(job.status)).map((job) => job.job_id),
    }));
  }

  private async sendSync(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    const jobs = await this.runtime.syncJobs();
    if (socket.readyState !== WebSocket.OPEN) return;
    const sync: RunnerSync = {
      type: "runner.sync",
      protocol_version: PROTOCOL_CURRENT_VERSION,
      runner_id: this.config.runnerId,
      sync_sequence: this.syncSequence++,
      sent_at_ms: Date.now(),
      workspaces: this.config.workspaces.map((workspace) => ({
        workspace_id: workspace.workspaceId,
        persistence: "persistent",
        labels: {},
      })),
      jobs,
    };
    socket.send(encodeWireFrame(sync));
  }

  private async respondToRpc(socket: WebSocket, request: RpcRequest): Promise<void> {
    try {
      const result = request.method === "echo" ? request.params : request.method === "runner.info" ? this.metadata : await this.runtime.dispatch(request.method, request.params);
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeWireFrame({ type: "rpc.response", protocol_version: request.protocol_version, request_id: request.request_id, result: result as RpcRequest["params"] }));
    } catch (error) {
      const details = rpcError(error);
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeWireFrame({ type: "rpc.error", protocol_version: request.protocol_version, request_id: request.request_id, error: { code: details.code, message: details.message, ...(details.details === undefined ? {} : { details: details.details as RpcRequest["params"] }) } }));
    }
  }

  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }

  private forwardJobEvent(event: import("./jobs.js").JobEvent): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    const job = { job_id: event.job.job_id, workspace_id: event.job.workspace_id, status: event.job.status, created_at_ms: event.job.created_at_ms, updated_at_ms: event.job.updated_at_ms, ...(event.job.created_by_client_id === null ? {} : { created_by_client_id: event.job.created_by_client_id }), runner_id: this.config.runnerId } as const;
    try {
      if (event.type === "started") {
        socket.send(encodeWireFrame({ type: "job.started", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job, workspace: { workspace_id: event.job.workspace_id, persistence: "persistent", labels: {} }, started_at_ms: event.job.started_at_ms ?? event.job.updated_at_ms }));
      } else if (event.type === "output" && event.stream !== undefined && event.data !== undefined) {
        socket.send(encodeWireFrame({ type: "job.output", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job_id: event.job.job_id, workspace_id: event.job.workspace_id, sequence: event.job.updated_at_ms, stream: event.stream, encoding: "utf-8", data: event.data }));
      } else if (event.type === "completed" && (event.job.status === "succeeded" || event.job.status === "failed" || event.job.status === "cancelled")) {
        socket.send(encodeWireFrame({ type: "job.completed", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job, completed_at_ms: event.job.completed_at_ms ?? event.job.updated_at_ms, outcome: event.job.status, exit_code: event.job.exit_code }));
      } else {
        socket.send(encodeWireFrame({ type: "job.status", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job }));
      }
    } catch { /* local persistence remains authoritative; transport is best effort */ }
  }
}

export function discoverCapabilities(maxConcurrentJobs = 1): CapabilityMetadata {
  return {
    filesystem: true,
    process_execution: true,
    workspace_sync: true,
    pty: false,
    network_access: true,
    max_concurrent_jobs: maxConcurrentJobs,
    supported_rpc_methods: ["echo", "runner.info", "workspace.list", "env.info", "fs.read", "fs.list", "fs.search", "fs.apply_patch", "fs.patch", "git.status", "git.diff", "exec.start", "exec.run", "job.list", "job.get", "job.logs", "job.cancel", "job.input"],
    labels: { runtime: "node" },
  };
}
