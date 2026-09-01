import {
  decodeWireFrame,
  encodeWireFrame,
  LOCAL_RUNNER_OPERATION_TIMEOUT_MS,
  RUNNER_DIAGNOSTICS_EXTENSION,
  RUNNER_POLICY_DIAGNOSTICS_EXTENSION,
  policyDiagnosticsExtension,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  runnerPolicyChecksum,
  runnerDiagnosticsExtension,
  stripRunnerDiagnostics,
  stripWorkspaceDiagnostics,
  supportsDirectPolicyDiagnostics,
  type RunnerMetadata,
  type RunnerPolicyAck,
  type RunnerWelcome,
  type RunnerSync,
  type RpcRequest,
  type WireMessage,
} from "@aloneio/runmesh-protocol";
import type { CapabilityMetadata } from "./protocol-types.js";
import WebSocket from "ws";
import { userInfo } from "node:os";
import { reconnectDelayMs } from "./backoff.js";
import { PolicyStore } from "./policy-store.js";
import { effectiveCentralPermissions, validateCentralWorkspacePolicy, type CentralWorkspacePolicy } from "./policy-config.js";
import type { RunnerConfig, WorkspaceConfig } from "./config.js";
import { RunnerRuntime, rpcError } from "./runtime.js";
import { RUNNER_VERSION } from "./version.js";

export class RunnerAuthenticationError extends Error {
  public constructor(message = "runner credentials were rejected") { super(message); this.name = "RunnerAuthenticationError"; }
}

/** Authentication failures must not enter normal network reconnect backoff. */
export function classifyConnectionFailure(input: { readonly statusCode?: number; readonly closeCode?: number; readonly reason?: string; readonly error?: unknown }): "authentication" | "network" {
  if (input.statusCode === 401 || input.statusCode === 403 || input.closeCode === 4001 || input.closeCode === 1002) return "authentication";
  const message = `${input.reason ?? ""} ${input.error instanceof Error ? input.error.message : ""}`.toLowerCase();
  return /credential|auth(?:entication|orization)?|revoked|forbidden|unauthorized|stale session|unsupported_protocol_version/.test(message) ? "authentication" : "network";
}

export interface RunnerConnectionOptions {
  readonly config: RunnerConfig;
  readonly version?: string | undefined;
  readonly executionMode?: "dedicated_user" | "privileged_host";
  readonly serviceIdentity?: string;
  readonly heartbeatMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly syncMs?: number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onStateChange?: (state: "connecting" | "online" | "offline") => void;
  readonly runtime?: RunnerRuntime;
  readonly policyStore?: PolicyStore;
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
  private readonly policyStore: PolicyStore;
  private socket: WebSocket | undefined;
  private stopped = false;
  private lifecycleGeneration = 0;
  private reconnectAttempt = 0;
  private syncSequence = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private appliedPolicyRevision: number | null = null;
  private desiredPolicyRevision = 0;
  private appliedPolicyChecksum: string | null = null;
  private desiredPolicyChecksum = "";
  private policyApplyGeneration = 0;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /**
   * Policy validation/activation can perform filesystem I/O and therefore may
   * remain pending for an arbitrary amount of time. Keep FIFO ordering for a
   * single WebSocket, but never let a stalled operation from a superseded
   * transport block policy delivery on the replacement socket.
   */
  private readonly policyApplyQueues = new WeakMap<WebSocket, Promise<void>>();
  /** Whether each peer explicitly opted into direct diagnostic fields. */
  private readonly directPolicyDiagnostics = new WeakMap<WebSocket, boolean>();
  /**
   * A sync snapshot is asynchronous (job recovery/persistence may yield), so
   * timer, welcome, and policy-apply triggers must share one FIFO. Without a
   * queue an older snapshot can finish after a newer one and receive the
   * larger sync_sequence, causing Registry to accept it as authoritative.
   */
  private syncQueue: Promise<void> = Promise.resolve();
  private syncQueueSocket: WebSocket | undefined;

  public constructor(options: RunnerConnectionOptions) {
    this.config = options.config;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? LOCAL_RUNNER_OPERATION_TIMEOUT_MS;
    this.syncMs = options.syncMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.runtime = options.runtime ?? new RunnerRuntime({ config: this.config, ...(this.config.stateDir === undefined ? {} : { stateDir: this.config.stateDir }), onJobEvent: (event) => this.forwardJobEvent(event) });
    this.policyStore = options.policyStore ?? new PolicyStore(this.config.stateDir);
    const executionMode = options.executionMode;
    // Metadata is echoed through the authenticated control plane and later
    // shown in administrator diagnostics.  Treat an injected identity as
    // untrusted text just like the auto-discovered username; never carry
    // control characters or an unbounded value into a wire frame.
    // A profile without an execution mode is a legacy/migration state.  Do
    // not add an automatically discovered identity to its hello: older Worker
    // versions decode Runner metadata strictly and would reject the new field,
    // while the mode itself is not yet authoritative until migration.
    const serviceIdentity = executionMode === undefined ? undefined : sanitizeServiceIdentity(options.serviceIdentity ?? currentProcessServiceIdentity());
    this.metadata = {
      runner_id: this.config.runnerId,
      runner_version: options.version ?? RUNNER_VERSION,
      platform: process.platform,
      architecture: process.arch,
      ...(executionMode === undefined ? {} : { execution_mode: executionMode }),
      ...(serviceIdentity === undefined ? {} : { service_identity: serviceIdentity }),
      ...(executionMode === undefined ? {} : { privilege_state: processPrivilegeState(executionMode, serviceIdentity) }),
      capabilities: discoverCapabilities(this.config.maxConcurrentJobs ?? 1),
    };
  }

  public async start(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.stopped = false;
    await this.runtime.initialize();
    // `stop()` may be called while local state/policy is loading. Do not
    // blindly clear that stop request after the await and open a socket anyway.
    if (this.stopped || generation !== this.lifecycleGeneration) return;
    const persisted = await this.policyStore.load(this.config.runnerId);
    if (this.stopped || generation !== this.lifecycleGeneration) return;
    if (persisted !== undefined) {
      try {
        const restored = await candidateWorkspaces(persisted, this.metadata.execution_mode, this.metadata.service_identity);
        this.runtime.applyPolicy(restored);
        this.appliedPolicyRevision = persisted.revision;
        this.appliedPolicyChecksum = persisted.checksum;
      } catch {
        // Keep the live policy fail-closed but continue to the authenticated
        // transport.  The Worker can then receive an explicit `invalid` ACK
        // (including os_access_denied diagnostics) and deliver a corrected
        // policy after an operator fixes the service identity/ACL; aborting
        // here would leave the Runner permanently offline and hide the cause.
        this.runtime.applyPolicy([]);
      }
      this.desiredPolicyRevision = persisted.revision;
      this.desiredPolicyChecksum = persisted.checksum;
    }
    while (!this.stopped && generation === this.lifecycleGeneration) {
      this.onStateChange("connecting");
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
      } catch (error) {
        this.onStateChange("offline");
        if (this.stopped) break;
        if (error instanceof RunnerAuthenticationError || classifyConnectionFailure({ error }) === "authentication") {
          this.stopped = true;
          throw error;
        }
        await this.sleep(reconnectDelayMs(this.reconnectAttempt, this.random()));
        this.reconnectAttempt += 1;
      }
    }
  }

  public stop(): void {
    this.lifecycleGeneration += 1;
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
  public rpc(method: string, params: unknown, policyRevision?: number): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("runner is not connected"));
    }
    const requestId = `rpc-${crypto.randomUUID()}`;
    const request: RpcRequest = policyRevision === undefined
      ? { type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: requestId, method: method as "echo" | "runner.info", params: params as RpcRequest["params"] }
      : { type: "rpc.request", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: requestId, method, params: params as RpcRequest["params"], policy_revision: policyRevision };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC request timed out: ${method}`));
      }, this.rpcTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(encodeWireFrame(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error("failed to send RPC request"));
      }
    });
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.server);
      if (!url.pathname.replace(/\/+$/, "").endsWith("/runner/connect")) {
        url.pathname = url.pathname.endsWith("/") ? `${url.pathname}runner/connect` : `${url.pathname}/runner/connect`;
      }
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
      socket.once("unexpected-response", (_request, response) => {
        const statusCode = response.statusCode;
        const error = classifyConnectionFailure(statusCode === undefined ? {} : { statusCode }) === "authentication"
          ? new RunnerAuthenticationError(`runner authentication failed (${response.statusCode})`)
          : new Error(`runner connection failed (${response.statusCode})`);
        socket.terminate();
        fail(error);
      });
      socket.once("open", () => {
        // Keep the initial hello in the legacy direct shape.  Optional
        // diagnostics travel under the long-supported envelope extension so
        // a pre-diagnostics Worker with a strict RunnerMetadata schema can
        // still accept this frame.
        const diagnostics = runnerDiagnosticsExtension(this.metadata);
        const hello: WireMessage = {
          type: "runner.hello",
          protocol_version: PROTOCOL_CURRENT_VERSION,
          request_id: `hello-${crypto.randomUUID()}`,
          runner: stripRunnerDiagnostics(this.metadata),
          min_protocol_version: PROTOCOL_MIN_VERSION,
          max_protocol_version: PROTOCOL_CURRENT_VERSION,
          ...(diagnostics === undefined ? {} : { extensions: { [RUNNER_DIAGNOSTICS_EXTENSION]: diagnostics } }),
        };
        try { socket.send(encodeWireFrame(hello)); }
        catch (error) { fail(error instanceof Error ? error : new Error("failed to send runner hello")); }
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
          // A delayed welcome from a superseded socket must never promote the
          // old transport back to online or install timers that belong to the
          // current session. This can happen when a pre-welcome socket errors
          // while the reconnect loop is already opening a replacement.
          if (this.socket !== socket || this.stopped) {
            socket.close(4000, "stale connection");
            return;
          }
          // A welcome is a one-shot handshake. Accepting a duplicate would
          // install another heartbeat/sync timer on the same socket and could
          // advance the Registry sync sequence out of order.
          if (welcomed) {
            socket.close(1008, "duplicate welcome");
            return;
          }
          welcomed = true;
          this.directPolicyDiagnostics.set(socket, supportsDirectPolicyDiagnostics(message.extensions));
          this.onStateChange("online");
          if (message.desired_policy !== undefined) this.queueDesiredPolicy(socket, message.desired_policy);
          void this.sendSync(socket).catch(() => undefined);
          this.heartbeatTimer = setInterval(() => {
            if (this.socket !== socket || this.stopped) return;
            try { this.sendHeartbeat(socket); } catch { /* close handler drives reconnect */ }
          }, this.heartbeatMs);
          this.syncTimer = setInterval(() => {
            if (this.socket !== socket || this.stopped) return;
            void this.sendSync(socket).catch(() => undefined);
          }, this.syncMs);
          // Stay pending until close so start() reconnects only after a real session ends.
          return;
        }
        // A socket is not authorized until its welcome handshake has completed
        // and it is still the connection tracked by this Runner.  In
        // particular, do not let a pre-welcome or superseded socket issue an
        // `rpc.request` against a policy restored from a previous session.
        if (!welcomed || this.socket !== socket || this.stopped) {
          socket.close(4000, "stale connection");
          return;
        }
        if (message.type === "runner.policy_update") {
          if (message.runner_id !== this.config.runnerId) { socket.close(1008, "runner identity mismatch"); return; }
          this.queueDesiredPolicy(socket, message.policy);
          return;
        }
        if (message.type === "rpc.request") {
          void this.respondToRpc(socket, message, () => welcomed && this.socket === socket && !this.stopped);
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
      socket.once("close", (code: number, reason: Buffer) => {
        // A socket that failed before `open` can emit `close` after the
        // reconnect loop has already installed a newer socket. Never clear
        // the newer session's heartbeat/sync timers from that stale event.
        const currentSocket = this.socket === socket;
        if (currentSocket) {
          if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
          if (this.syncTimer !== undefined) clearInterval(this.syncTimer);
          this.heartbeatTimer = undefined;
          this.syncTimer = undefined;
        }
        this.rejectPendingForSocket(socket, new Error("runner connection closed"));
        if (currentSocket) this.socket = undefined;
        const closeReason = reason.toString("utf8");
        const failure = classifyConnectionFailure({ closeCode: code, reason: closeReason }) === "authentication"
          ? new RunnerAuthenticationError("runner credentials were revoked or rejected")
          : new Error(welcomed ? "connection closed" : "connection closed before welcome");
        if (!this.stopped) fail(failure);
        else if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  private queueDesiredPolicy(socket: WebSocket, policy: NonNullable<RunnerWelcome["desired_policy"]>): void {
    const previous = this.policyApplyQueues.get(socket) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.applyDesiredPolicy(socket, policy));
    // Consume failures so one bad policy candidate cannot poison later updates
    // on this socket. `next` is still returned nowhere by design: policy
    // application is best-effort and the ACK is the observable result.
    this.policyApplyQueues.set(socket, next.catch(() => undefined));
  }

  private async applyDesiredPolicy(socket: WebSocket, policy: NonNullable<RunnerWelcome["desired_policy"]>): Promise<void> {
    // A policy can sit behind an older candidate in the per-socket queue. If
    // that transport is replaced before the candidate reaches the front, do
    // not let the stale candidate advance the global desired revision; doing
    // so could fence a valid lower revision received on the new session.
    if (this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
    if (policy.runner_id !== this.config.runnerId || policy.checksum !== runnerPolicyChecksum({ schema_version: policy.schema_version, runner_id: policy.runner_id, revision: policy.revision, runner_permissions: policy.runner_permissions, workspaces: policy.workspaces })) {
      return;
    }
    if (policy.revision < this.desiredPolicyRevision) return;
    if (policy.revision === this.desiredPolicyRevision && policy.checksum !== this.desiredPolicyChecksum) return;
    // The desired fields record what the control plane asked for; they do not
    // prove that this process ever activated the same snapshot. A socket can
    // close after PolicyStore.activate() but before runtime.applyPolicy(),
    // leaving live authorization behind the persisted desired revision.
    // Re-apply an unchanged desired snapshot until the live applied identity
    // matches it; otherwise a reconnect would short-circuit forever.
    if (policy.revision === this.desiredPolicyRevision
      && policy.checksum === this.desiredPolicyChecksum
      && this.appliedPolicyRevision === policy.revision
      && this.appliedPolicyChecksum === policy.checksum) {
      // Registry marks a reconnecting runner as `pending` until it receives a
      // fresh acknowledgement for the current transport epoch.  The local
      // policy is already active in this case, so re-activating it would add
      // unnecessary disk churn; still validate and re-ack the immutable
      // snapshot, otherwise the Registry can remain pending forever.
      const generation = ++this.policyApplyGeneration;
      const validation = await validateCentralWorkspacePolicy(policy.workspaces as CentralWorkspacePolicy[], validationContext(this.metadata));
      if (generation !== this.policyApplyGeneration || this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN
        || policy.revision !== this.desiredPolicyRevision || policy.checksum !== this.desiredPolicyChecksum) return;
      const invalid = validation.status.some((item) => item.status !== "valid");
      this.sendPolicyAck(socket, invalid ? "invalid" : "applied", validation.status);
      await this.sendSync(socket);
      return;
    }
    const generation = this.policyApplyGeneration + 1;
    this.policyApplyGeneration = generation;
    this.desiredPolicyRevision = policy.revision;
    this.desiredPolicyChecksum = policy.checksum;
    const validation = await validateCentralWorkspacePolicy(policy.workspaces as CentralWorkspacePolicy[], validationContext(this.metadata));
    if (generation !== this.policyApplyGeneration || this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN || policy.revision !== this.desiredPolicyRevision) return;
    const invalid = validation.status.some((item) => item.status !== "valid");
    if (invalid) {
      this.sendPolicyAck(socket, "invalid", validation.status);
      await this.sendSync(socket);
      return;
    }
    try {
      const effective = effectivePolicyWorkspaces(policy, validation.workspaces);
      await this.policyStore.activate(policy);
      if (generation !== this.policyApplyGeneration || this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN || policy.revision !== this.desiredPolicyRevision) return;
      // Disk activation is complete before changing the live authorization policy.
      this.runtime.applyPolicy(effective);
      this.appliedPolicyRevision = policy.revision;
      this.appliedPolicyChecksum = policy.checksum;
      this.sendPolicyAck(socket, "applied", validation.status);
    } catch {
      this.sendPolicyAck(socket, "invalid", validation.status.map((item) => item.status === "valid" ? { ...item, status: "invalid_path" as const } : item));
    }
    await this.sendSync(socket);
  }

  private sendPolicyAck(socket: WebSocket, status: RunnerPolicyAck["status"], workspaceStatus: RunnerPolicyAck["workspace_status"]): void {
    if (socket !== this.socket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    const reportedRevision = this.appliedPolicyRevision;
    const reportedChecksum = this.appliedPolicyChecksum;
    const directDiagnostics = this.directPolicyDiagnostics.get(socket) === true;
    const extensionDiagnostics = policyDiagnosticsExtension(workspaceStatus);
    const ack: RunnerPolicyAck = {
      type: "runner.policy_ack",
      protocol_version: PROTOCOL_CURRENT_VERSION,
      runner_id: this.config.runnerId,
      desired_revision: this.desiredPolicyRevision,
      desired_checksum: this.desiredPolicyChecksum,
      applied_revision: this.appliedPolicyRevision,
      applied_checksum: this.appliedPolicyChecksum,
      runner_reported_policy_revision: reportedRevision,
      runner_reported_policy_checksum: reportedChecksum,
      status,
      workspace_status: directDiagnostics ? workspaceStatus : stripWorkspaceDiagnostics(workspaceStatus),
      ...(!directDiagnostics && extensionDiagnostics !== undefined ? { extensions: { [RUNNER_POLICY_DIAGNOSTICS_EXTENSION]: extensionDiagnostics } } : {}),
    };
    try {
      socket.send(encodeWireFrame(ack));
    } catch { /* close handler drives reconnect */ }
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket !== this.socket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(encodeWireFrame({
        type: "runner.heartbeat",
        protocol_version: PROTOCOL_CURRENT_VERSION,
        runner_id: this.config.runnerId,
        sent_at_ms: Date.now(),
        active_job_ids: this.runtime.jobs.list().filter((job) => ["queued", "running", "cancelling"].includes(job.status)).map((job) => job.job_id),
      }));
    } catch { /* close handler drives reconnect */ }
  }

  private sendSync(socket: WebSocket): Promise<void> {
    // Never let a stalled snapshot from a dead socket block the first sync on
    // a replacement connection. The old promise may still settle eventually,
    // but its sendSyncNow identity checks make it a no-op for the new session.
    if (this.syncQueueSocket !== socket) {
      this.syncQueueSocket = socket;
      this.syncQueue = Promise.resolve();
    }
    const next = this.syncQueue.catch(() => undefined).then(() => this.sendSyncNow(socket));
    // Keep the queue alive after an individual snapshot failure while still
    // returning the failure to the caller for its normal best-effort handling.
    this.syncQueue = next.catch(() => undefined);
    return next;
  }

  private async sendSyncNow(socket: WebSocket): Promise<void> {
    if (socket !== this.socket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    const jobs = await this.runtime.syncJobs();
    if (socket !== this.socket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    const sync: RunnerSync = {
      type: "runner.sync",
      protocol_version: PROTOCOL_CURRENT_VERSION,
      runner_id: this.config.runnerId,
      sync_sequence: this.syncSequence++,
      sent_at_ms: Date.now(),
      workspaces: this.runtime.syncWorkspaceMetadata(),
      jobs,
    };
    try { socket.send(encodeWireFrame(sync)); } catch { /* close handler drives reconnect */ }
  }

  private async respondToRpc(socket: WebSocket, request: RpcRequest, sessionCurrent: () => boolean): Promise<void> {
    try {
      if (!sessionCurrent()) return;
      const expectedRevision = this.appliedPolicyRevision;
      if (request.method !== "echo" && request.method !== "runner.info" && (expectedRevision === null || request.policy_revision === undefined || request.policy_revision !== expectedRevision)) throw new Error("stale_policy");
      const result = request.method === "echo" ? request.params : request.method === "runner.info" ? this.metadata : await this.runtime.dispatch(request.method, request.params);
      if (sessionCurrent() && socket.readyState === WebSocket.OPEN) socket.send(encodeWireFrame({ type: "rpc.response", protocol_version: request.protocol_version, request_id: request.request_id, result: result as RpcRequest["params"] }));
    } catch (error) {
      const details = rpcError(error);
      if (sessionCurrent() && socket.readyState === WebSocket.OPEN) {
        try { socket.send(encodeWireFrame({ type: "rpc.error", protocol_version: request.protocol_version, request_id: request.request_id, error: { code: details.code, message: details.message, ...(details.details === undefined ? {} : { details: details.details as RpcRequest["params"] }) } })); } catch { /* close handler drives reconnect */ }
      }
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
      } else if (event.type === "completed" && (event.job.status === "succeeded" || event.job.status === "failed" || event.job.status === "cancelled")) {
        socket.send(encodeWireFrame({ type: "job.completed", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job, completed_at_ms: event.job.completed_at_ms ?? event.job.updated_at_ms, outcome: event.job.status, exit_code: event.job.exit_code }));
      } else if (event.type === "status") {
        socket.send(encodeWireFrame({ type: "job.status", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job }));
      }
    } catch { /* local persistence remains authoritative; transport is best effort */ }
  }
}

function effectivePolicyWorkspaces(policy: NonNullable<RunnerWelcome["desired_policy"]>, workspaces: readonly WorkspaceConfig[]): WorkspaceConfig[] {
  return workspaces.map((workspace) => {
    const source = policy.workspaces.find((item) => item.workspace_id === workspace.workspaceId);
    if (source === undefined) throw new Error("policy validation lost a workspace");
    const permissions = effectiveCentralPermissions(policy.runner_permissions, source.permissions);
    return { ...workspace, permissions, readonly: !permissions.edit, shell: permissions.shell };
  });
}

async function candidateWorkspaces(policy: NonNullable<RunnerWelcome["desired_policy"]>, executionMode?: "dedicated_user" | "privileged_host", serviceIdentity?: string): Promise<WorkspaceConfig[]> {
  const validation = await validateCentralWorkspacePolicy(policy.workspaces as CentralWorkspacePolicy[], {
    ...(executionMode === undefined ? {} : { executionMode }),
    ...(serviceIdentity === undefined ? {} : { serviceIdentity }),
  });
  if (validation.status.some((item) => item.status !== "valid")) throw new Error("persisted active policy is not locally valid");
  return effectivePolicyWorkspaces(policy, validation.workspaces);
}
export function discoverCapabilities(maxConcurrentJobs = 1): CapabilityMetadata {
  return {
    filesystem: true,
    process_execution: true,
    workspace_sync: true,
    pty: false,
    network_access: true,
    max_concurrent_jobs: maxConcurrentJobs,
    supported_rpc_methods: ["echo", "runner.info", "workspace.list", "env.info", "fs.read", "fs.stat", "fs.list", "fs.search", "fs.apply_patch", "fs.patch", "git.status", "git.diff", "exec.start", "exec.run", "job.list", "job.get", "job.logs", "job.cancel", "job.input"],
    labels: { runtime: "node" },
  };
}

/** Return the local process identity without invoking a shell or exposing a path. */
export function currentProcessServiceIdentity(): string | undefined {
  try {
    if (process.platform !== "win32" && process.getuid?.() === 0) return "root";
    const username = userInfo().username.trim();
    return username.length > 0 && username.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(username) ? username : undefined;
  } catch {
    const username = process.platform === "win32" ? process.env.USERNAME : undefined;
    return typeof username === "string" && username.length > 0 && username.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(username) ? username : undefined;
  }
}

function sanitizeServiceIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? trimmed : undefined;
}

function validationContext(metadata: RunnerMetadata): { readonly executionMode?: "dedicated_user" | "privileged_host"; readonly serviceIdentity?: string } {
  return {
    ...(metadata.execution_mode === undefined ? {} : { executionMode: metadata.execution_mode }),
    ...(metadata.service_identity === undefined ? {} : { serviceIdentity: metadata.service_identity }),
  };
}

function processPrivilegeState(mode: "dedicated_user" | "privileged_host", identity: string | undefined): "privileged" | "restricted" | "mismatch" | "unknown" {
  if (identity === undefined) return "unknown";
  const normalized = identity.trim().replaceAll("/", "\\").toLowerCase();
  const privileged = process.platform === "win32"
    ? normalized === "system" || normalized === "nt authority\\system" || normalized === "s-1-5-18"
    : normalized === "root";
  if (mode === "privileged_host") return privileged ? "privileged" : "mismatch";
  return privileged ? "mismatch" : "restricted";
}
