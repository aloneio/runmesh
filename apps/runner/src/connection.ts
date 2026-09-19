import { jobEventMessage } from "./connection/job-events.js";
import { createHash } from "node:crypto";
import { HistoryUploadScheduler, type HistoryUploadClock } from "./history-upload.js";
import { QueueGrantSchema } from "@aloneio/runmesh-protocol";
import { parseRunnerJobHistory, type RunnerJobHistory } from "./job-history.js";
import {
  decodeWireFrame,
  encodeWireFrame,
  LOCAL_RUNNER_OPERATION_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  runnerPolicyChecksum,
  type RunnerMetadata,
  type RunnerPolicyAck,
  type RunnerWelcome,
  type RunnerSync,
  type RpcRequest,
  type WireMessage,
} from "@aloneio/runmesh-protocol";
import WebSocket from "ws";
import { reconnectDelayMs, serviceReconnectDelayMs, retryAfterDelayMs } from "./backoff.js";
import { PolicyStore } from "./policy-store.js";
import { validateCentralWorkspacePolicy, type CentralWorkspacePolicy } from "./policy-config.js";
import { effectiveMaxConcurrentJobs, type RunnerConfig } from "./config.js";
import { RunnerRuntime, RpcRuntimeError, rpcError } from "./runtime.js";
import { RUNNER_VERSION } from "./version.js";

import { RunnerAuthenticationError, RunnerServiceUnavailableError, RunnerSessionConflictError, classifyConnectionFailure } from "./connection/failures.js";
export { RunnerAuthenticationError, RunnerServiceUnavailableError, classifyConnectionFailure } from "./connection/failures.js";
import { candidateWorkspaces, effectivePolicyWorkspaces, validationContext } from "./connection/policy-candidate.js";
import { discoverCapabilities, currentProcessServiceIdentity, sanitizeServiceIdentity, processPrivilegeState } from "./connection/metadata.js";
export { discoverCapabilities, currentProcessServiceIdentity } from "./connection/metadata.js";
import type { ConnectionRuntimePort, ConnectionPolicyStorePort, ConnectionTransportFactory } from "./connection/ports.js";

const MAX_IN_FLIGHT_RPCS = 64;
const MAX_IN_FLIGHT_SYNC_CAPTURES = 2;
const RESERVED_CONTROL_RPCS = 4;
// Stdin can remain backpressured indefinitely, so it must not occupy the
// reserve needed to cancel the same unresponsive child.
const CONTROL_RPC_METHODS = new Set(["echo", "runner.info", "job.get", "job.cancel"]);

/** @internal Trusted composition only; no CLI, wire or deployment configuration. */
export interface RunnerConnectionDependencies {
  readonly runtime?: ConnectionRuntimePort;
  readonly policyStore?: ConnectionPolicyStorePort;
  readonly createSocket?: ConnectionTransportFactory;
}

export interface RunnerConnectionOptions {
  readonly config: RunnerConfig;
  readonly version?: string | undefined;
  readonly executionMode?: "dedicated_user" | "privileged_host";
  readonly serviceIdentity?: string;
  readonly heartbeatMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly syncMs?: number;
  /** Inject a finite scheduler clock for transport tests; not a deployment setting. */
  readonly historyClock?: HistoryUploadClock;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onStateChange?: (state: "connecting" | "online" | "offline") => void;
  readonly runtime?: RunnerRuntime;
  readonly policyStore?: PolicyStore;
}

export class RunnerConnection {
  private queueNegotiated = false;
  private reportingNegotiated = false;
  private readonly historyUploads: HistoryUploadScheduler;
  private demandSnapshot: { revision: number; socket: WebSocket; jobs: RunnerSync["jobs"]; workspaces: RunnerSync["workspaces"]; snapshot: string } | undefined;
  private readonly config: RunnerConfig;
  private readonly metadata: RunnerMetadata;
  private readonly heartbeatMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly syncMs: number;
  private jobHistory: RunnerJobHistory | undefined;
  private historyPending: {requestId:string;snapshot:string;socket:WebSocket;revision?:number} | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private cleanupBusy = false;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onStateChange: (state: "connecting" | "online" | "offline") => void;
  private readonly runtime: ConnectionRuntimePort;
  private readonly policyStore: ConnectionPolicyStorePort;
  private readonly createSocket: ConnectionTransportFactory;
  private socket: WebSocket | undefined;
  /**
   * The socket that completed the `runner.welcome` handshake. A socket is
   * installed as `this.socket` before it is authorized, so outbound frames
   * that are not part of the handshake itself must additionally prove that the
   * current socket was welcomed. Pre-welcome frames are rejected; older
   * Workers misclassified that stale session as a permanent credential failure.
   */
  private welcomedSocket: WebSocket | undefined;
  private stopped = false;
  private cancelReconnectSleep: (() => void) | undefined;
  private lifecycleGeneration = 0;
  private reconnectAttempt = 0;
  private syncSequence = 0;
  private lastSyncSnapshot: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private appliedPolicyRevision: number | null = null;
  private desiredPolicyRevision = 0;
  private appliedPolicyChecksum: string | null = null;
  private desiredPolicyChecksum = "";
  private policyApplyGeneration = 0;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // Worker timeouts do not cancel already dispatched local work. Keep the
  // budget across reconnects so repeated expired bridge requests stay bounded.
  private inFlightRpcs = 0;
  /**
   * Policy validation/activation can perform filesystem I/O and therefore may
   * remain pending for an arbitrary amount of time. Keep FIFO ordering for a
   * single WebSocket, but never let a stalled operation from a superseded
   * transport block policy delivery on the replacement socket.
   */
  private readonly policyApplyQueues = new WeakMap<WebSocket, Promise<void>>();
  /**
   * A sync snapshot is asynchronous (job recovery/persistence may yield), so
   * timer, welcome, and policy-apply triggers must share one FIFO. Without a
   * queue an older snapshot can finish after a newer one and receive the
   * larger sync_sequence, causing Registry to accept it as authoritative.
   */
  private syncQueue: Promise<void> = Promise.resolve();
  private syncQueueSocket: WebSocket | undefined;
  private syncScheduled: { socket: WebSocket } | undefined;
  private inFlightSyncCaptures = 0;

  public constructor(options: RunnerConnectionOptions);
  /** @internal Internal ports preserve the published single-argument constructor. */
  public constructor(options: RunnerConnectionOptions, dependencies: RunnerConnectionDependencies);
  public constructor(options: RunnerConnectionOptions, dependencies: RunnerConnectionDependencies = {}) {
    this.createSocket = dependencies.createSocket ?? ((url, options) => new WebSocket(url, options));
    this.config = options.config;
    // Heartbeats keep an online Runner lease alive in RegistryDO. A 30s
    // cadence stays below the 45s stale threshold while cutting steady
    // Durable Object traffic for idle runners in half.
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? LOCAL_RUNNER_OPERATION_TIMEOUT_MS;
    this.syncMs = options.syncMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        if (this.cancelReconnectSleep === finish) this.cancelReconnectSleep = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      this.cancelReconnectSleep = finish;
    }));
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.runtime = dependencies.runtime ?? options.runtime ?? new RunnerRuntime({ config: this.config, ...(this.config.stateDir === undefined ? {} : { stateDir: this.config.stateDir }), onJobEvent: (event) => this.forwardJobEvent(event) });
    this.policyStore = dependencies.policyStore ?? options.policyStore ?? new PolicyStore(this.config.stateDir);
    this.historyUploads = new HistoryUploadScheduler(async revision => {
      const socket = this.socket;
      if (socket !== undefined) await this.sendDemandSync(socket, revision);
    }, options.historyClock);
    const executionMode = options.executionMode;
    // Metadata is echoed through the authenticated control plane and later
    // shown in administrator diagnostics.  Treat an injected identity as
    // untrusted text just like the auto-discovered username; never carry
    // control characters or an unbounded value into a wire frame.
    // A missing execution mode is an invalid profile state and is rejected by
    // profile validation before a production connection is constructed. Keep
    // the optional shape here for injected test/runtime callers, but never
    // synthesize or transport a second compatibility representation.
    const serviceIdentity = executionMode === undefined ? undefined : sanitizeServiceIdentity(options.serviceIdentity ?? currentProcessServiceIdentity());
    const capabilities = discoverCapabilities(effectiveMaxConcurrentJobs(this.config.maxConcurrentJobs));
    this.metadata = {
      runner_id: this.config.runnerId,
      runner_version: options.version ?? RUNNER_VERSION,
      platform: process.platform,
      architecture: process.arch,
      ...(executionMode === undefined ? {} : { execution_mode: executionMode }),
      ...(serviceIdentity === undefined ? {} : { service_identity: serviceIdentity }),
      ...(executionMode === undefined ? {} : { privilege_state: processPrivilegeState(executionMode, serviceIdentity) }),
      capabilities: { ...capabilities, labels: { ...capabilities.labels, job_history_protocol: "1", job_queue_protocol: "1", job_reporting_protocol: "2" } },
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
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.length > 0) console.error(`runner connection error: ${detail}`);
        this.onStateChange("offline");
        if (this.stopped) break;
        if (error instanceof RunnerAuthenticationError || classifyConnectionFailure({ error }) === "authentication") {
          this.stopped = true;
          this.queueNegotiated = false;
          throw error;
        }
        const delayMs = error instanceof RunnerServiceUnavailableError
          ? serviceReconnectDelayMs(this.reconnectAttempt, this.random(), error.retryAfterMs)
          : reconnectDelayMs(this.reconnectAttempt, this.random());
        console.error(`runner reconnect scheduled: class=${error instanceof RunnerServiceUnavailableError ? "service_unavailable" : error instanceof RunnerSessionConflictError ? "session_conflict" : "network"} delay_ms=${delayMs}`);
        await this.sleep(delayMs);
        this.reconnectAttempt += 1;
      }
    }
  }

  public stop(): void {
    this.lifecycleGeneration += 1;
    this.stopped = true;
    this.queueNegotiated = false;
    this.historyUploads.stop(); this.reportingNegotiated = false; this.demandSnapshot = undefined;
    this.cancelReconnectSleep?.();
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.syncTimer !== undefined) clearInterval(this.syncTimer);
    this.welcomedSocket = undefined;
    this.socket?.close(1000, "runner stopped");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("runner stopped"));
    }
    this.pending.clear();
  }

  private async authorizeQueuedJob(input: Record<string,unknown>, jobId: string, clientId: string | null): Promise<boolean> {
    const parsed=QueueGrantSchema.safeParse(input.queue_grant);
    const socket=this.socket;
    if (!this.queueNegotiated || !parsed.success || this.stopped || socket===undefined || socket!==this.welcomedSocket || socket.readyState!==WebSocket.OPEN) return false;
    const grant=parsed.data;
    const canonical=JSON.stringify({workspace_id:input.workspace_id,command:input.command,args:input.args??null,shell:input.shell,cwd:input.cwd??".",request_id:input.request_id??null,...(typeof input.record_history === "boolean" ? {record_history:input.record_history} : {})});
    if (grant.payload.client_id!==clientId || grant.payload.runner_id!==this.config.runnerId || grant.payload.workspace_id!==input.workspace_id
      || grant.payload.policy_revision!==this.appliedPolicyRevision || grant.payload.expires_at_ms<=Date.now()
      || grant.payload.launch_digest!==createHash("sha256").update(canonical).digest("hex")) return false;
    const requestId=`queue-${crypto.randomUUID()}`;
    try {
      const result=await new Promise<unknown>((resolve,reject)=>{
        const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error("Queue authorization timed out"));},5000);
        this.pending.set(requestId,{resolve,reject,timer});
        try {socket.send(encodeWireFrame({type:"runner.queue_check",protocol_version:PROTOCOL_CURRENT_VERSION,request_id:requestId,runner_id:this.config.runnerId,job_id:jobId,grant}));}
        catch(error){clearTimeout(timer);this.pending.delete(requestId);reject(error);}
      });
      const allowed = this.socket===socket && this.welcomedSocket===socket && !this.stopped && socket.readyState===WebSocket.OPEN
        && typeof result==="object" && result!==null && !Array.isArray(result) && "authorized" in result && result.authorized===true;
      if (allowed && this.reportingNegotiated && (!("record_history" in result) || result.record_history !== true)) input.record_history = false;
      return allowed;
    } catch { return false; }
  }

  /** Test/operator control: close only the transport; local JobManager continues. */
  public disconnectForTest(): void {
    this.socket?.close(4002, "controlled transport disconnect");
  }
  public rpc(method: string, params: unknown, policyRevision?: number): Promise<unknown> {
    const socket = this.socket;
    if (this.stopped || socket === undefined || socket !== this.welcomedSocket || socket.readyState !== WebSocket.OPEN) {
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
      // Enforce the protocol limit in the WebSocket receiver, before it
      // buffers/reassembles a frame. Compression is unnecessary for bounded
      // control messages and would add a separate decompression budget.
      const socket = this.createSocket(url, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
      this.socket = socket;
      // A replacement socket is unauthorized until its own welcome arrives.
      this.welcomedSocket = undefined;
      let welcomed = false;
      let welcomedAtMs = 0;
      let settled = false;
      const fail = (error: Error): void => {
        clearTimeout(handshakeTimer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      // Cover both an HTTP upgrade that never completes and a peer that opens
      // the socket but never sends welcome. Neither produces a close/error
      // by itself, so without this deadline the reconnect loop stalls forever.
      const handshakeTimer = setTimeout(() => {
        if (welcomed || settled) return;
        fail(new Error("runner welcome handshake timed out"));
        socket.terminate();
      }, 30_000);
      handshakeTimer.unref();
      socket.once("unexpected-response", (_request, response) => {
        const statusCode = response.statusCode;
        const error = classifyConnectionFailure(statusCode === undefined ? {} : { statusCode }) === "authentication"
          ? new RunnerAuthenticationError(`runner authentication failed (${response.statusCode})`)
          : statusCode === 429 || (statusCode !== undefined && statusCode >= 500)
            ? new RunnerServiceUnavailableError(`runner service temporarily unavailable (${statusCode})`, retryAfterDelayMs(response.headers["retry-after"]))
            : new Error(`runner connection failed (${response.statusCode})`);
        fail(error);
        response.resume();
        socket.terminate();
      });
      socket.once("open", () => {
        const hello: WireMessage = {
          type: "runner.hello",
          protocol_version: PROTOCOL_CURRENT_VERSION,
          request_id: `hello-${crypto.randomUUID()}`,
          runner: this.metadata,
          min_protocol_version: PROTOCOL_MIN_VERSION,
          max_protocol_version: PROTOCOL_CURRENT_VERSION,
        };
        try { socket.send(encodeWireFrame(hello)); }
        catch (error) { fail(error instanceof Error ? error : new Error("failed to send runner hello")); socket.terminate(); }
      });
      socket.on("message", (value: WebSocket.RawData) => {
        let message: WireMessage;
        try {
          message = decodeWireFrame(Array.isArray(value) ? Buffer.concat(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : value);
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
          const rawHistory = message.extensions?.runmesh_job_history;
          const history = rawHistory === undefined ? undefined : parseRunnerJobHistory(rawHistory);
          if (rawHistory !== undefined && history === undefined) { socket.close(1008,"invalid history settings"); return; }
          const priorHistory = this.jobHistory;
          this.jobHistory = history;
          this.reportingNegotiated = message.extensions?.runmesh_job_reporting === 2 && history !== undefined;
          this.historyUploads.stop(); this.demandSnapshot = undefined;
          this.historyPending = undefined;
          if (this.cleanupTimer !== undefined) { clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
          if (history !== undefined || priorHistory !== undefined) this.runtime.configureJobRetention(history?.local_retention_days ?? 0);
          if ((history?.local_retention_days ?? 0) > 0) {
            this.cleanupTimer = setInterval(() => {
              if (this.stopped || this.cleanupBusy) return;
              this.cleanupBusy = true;
              void this.runtime.cleanupJobs().catch(() => undefined).finally(() => { this.cleanupBusy = false; });
            },900_000);
            this.cleanupTimer.unref();
          }
          welcomed = true;
          clearTimeout(handshakeTimer);
          welcomedAtMs = Date.now();
          this.welcomedSocket = socket;
          this.queueNegotiated = message.extensions?.runmesh_job_queue === 1;
          this.runtime.jobs?.setQueueAuthorizer?.(this.queueNegotiated ? (input,job) => this.authorizeQueuedJob(input,job.job_id,job.created_by_client_id) : undefined);
          this.onStateChange("online");
          this.lastSyncSnapshot = undefined;
          if (message.desired_policy !== undefined) this.queueDesiredPolicy(socket, message.desired_policy);
          if (this.reportingNegotiated && history !== undefined) {
            if (history.mode !== "off") this.historyUploads.start(history.interval_seconds * 1000, history.mode === "immediate");
          } else void this.sendSync(socket).catch(() => undefined);
          this.heartbeatTimer = setInterval(() => {
            if (this.socket !== socket || this.stopped) return;
            try { this.sendHeartbeat(socket); } catch { /* close handler drives reconnect */ }
          }, this.heartbeatMs);
          if (!this.reportingNegotiated && this.jobHistory?.mode !== "off") this.syncTimer = setInterval(() => {
            if (this.socket !== socket || this.stopped) return;
            void this.sendSync(socket).catch(() => undefined);
          }, this.jobHistory === undefined ? this.syncMs : this.jobHistory.interval_seconds * 1000);
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
        if (message.type === "rpc.response" && this.historyPending?.socket === socket && message.request_id === this.historyPending.requestId) {
          const result = message.result;
          if (typeof result === "object" && result !== null && !Array.isArray(result)
            && ["recorded","unchanged","disabled"].includes(String(result.history_status))) {
            this.lastSyncSnapshot = this.historyPending.snapshot;
            if (this.historyPending.revision !== undefined) {
              if (result.history_status === "disabled") this.historyUploads.stop();
              else this.historyUploads.acknowledge(this.historyPending.revision);
            }
          }
          this.historyPending = undefined;
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
        if (!welcomed) { fail(error); socket.terminate(); }
      });
      socket.once("close", (code: number, reason: Buffer) => {
        clearTimeout(handshakeTimer);
        // A socket that failed before `open` can emit `close` after the
        // reconnect loop has already installed a newer socket. Never clear
        // the newer session's heartbeat/sync timers from that stale event.
        const currentSocket = this.socket === socket;
        if (currentSocket) {
          this.historyUploads.stop(); this.reportingNegotiated = false; this.demandSnapshot = undefined;
          if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
          if (this.syncTimer !== undefined) clearInterval(this.syncTimer);
          this.heartbeatTimer = undefined;
          this.syncTimer = undefined;
        }
        this.rejectPendingForSocket(socket, new Error("runner connection closed"));
        if (currentSocket) {
          this.socket = undefined;
          this.welcomedSocket = undefined;
        }
        const closeReason = reason.toString("utf8");
        const failure = classifyConnectionFailure({ closeCode: code, reason: closeReason }) === "authentication"
          ? new RunnerAuthenticationError("runner credentials were revoked or rejected")
          : code === 4000 ? new RunnerSessionConflictError()
          : code === 1013 || code === 1011
            ? new RunnerServiceUnavailableError(`runner service temporarily unavailable (close ${code})`)
            : new Error(welcomed ? "connection closed" : "connection closed before welcome");
        // A brief welcome during an outage must not reset the retry budget.
        if (welcomed && Date.now() - welcomedAtMs >= 60_000) this.reconnectAttempt = 0;
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
      workspace_status: workspaceStatus,
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
        active_job_ids: this.runtime.jobs.list().filter((job) => job.record_history !== false && ["queued", "running", "cancelling"].includes(job.status)).map((job) => job.job_id),
      }));
    } catch { /* close handler drives reconnect */ }
  }

  private sendSync(socket: WebSocket): Promise<void> {
    if (this.reportingNegotiated) {
      if (socket === this.socket && socket === this.welcomedSocket && !this.stopped) this.historyUploads.changed();
      return Promise.resolve();
    }
    // Never let a stalled snapshot from a dead socket block the first sync on
    // a replacement connection. The old promise may still settle eventually,
    // but its sendSyncNow identity checks make it a no-op for the new session.
    if (this.syncQueueSocket !== socket) {
      this.syncQueueSocket = socket;
      this.syncQueue = Promise.resolve();
    }
    // A slow snapshot needs at most one follow-up to capture intervening
    // changes. Coalesce timer/event triggers while that follow-up is queued;
    // otherwise a stalled disk accumulates an unbounded promise/scan backlog.
    // Do not return the same pending promise to every periodic trigger: each
    // caller's catch/await would itself retain an unbounded reaction backlog.
    if (this.syncScheduled?.socket === socket) return Promise.resolve();
    const scheduled = { socket };
    const next = this.syncQueue.catch(() => undefined).then(() => {
      if (this.syncScheduled === scheduled) this.syncScheduled = undefined;
      return this.sendSyncNow(socket);
    });
    this.syncScheduled = scheduled;
    // Keep the queue alive after an individual snapshot failure while still
    // returning the failure to the caller for its normal best-effort handling.
    this.syncQueue = next.catch(() => undefined);
    return next;
  }

  private async captureSyncJobs(limit: number): Promise<RunnerSync["jobs"] | undefined> {
    // Permit a replacement connection to proceed past one stalled old read,
    // but repeated reconnects must not accumulate unlimited filesystem work.
    // Existing sync/upload retry opportunities try again when capacity frees.
    if (this.inFlightSyncCaptures >= MAX_IN_FLIGHT_SYNC_CAPTURES) return undefined;
    this.inFlightSyncCaptures++;
    try { return await this.runtime.syncJobs(limit); }
    finally { this.inFlightSyncCaptures--; }
  }

  /** Reuse an unacknowledged payload rather than rescanning local records
   * on every retry. A newer change has a different scheduler generation. */
  private async sendDemandSync(socket: WebSocket, revision: number): Promise<void> {
    const current = (): boolean => this.reportingNegotiated && socket === this.socket && socket === this.welcomedSocket && !this.stopped && socket.readyState === WebSocket.OPEN;
    if (!current() || this.jobHistory?.mode === "off") return;
    let captured = this.demandSnapshot;
    if (captured?.socket !== socket || captured.revision !== revision) {
      const jobs = await this.captureSyncJobs(500);
      if (jobs === undefined || !current()) return;
      const workspaces = this.runtime.syncWorkspaceMetadata();
      captured = { revision, socket, jobs, workspaces, snapshot: JSON.stringify({ workspaces, jobs }) };
      this.demandSnapshot = captured;
      this.historyUploads.setRecoveryPending(this.runtime.needsHistoryReconciliation?.() === true);
    }
    if (captured.jobs.length === 0 || captured.snapshot === this.lastSyncSnapshot) {
      this.historyUploads.acknowledge(revision); return;
    }
    const sync: RunnerSync = { type: "runner.sync", protocol_version: PROTOCOL_CURRENT_VERSION, runner_id: this.config.runnerId,
      sync_sequence: this.syncSequence++, sent_at_ms: Date.now(), workspaces: captured.workspaces, jobs: captured.jobs,
      extensions: { runmesh_history_ack: true } };
    this.historyPending = { requestId: `history-${sync.sync_sequence}`, snapshot: captured.snapshot, socket, revision };
    // The scheduler retains this generation until a matching receipt arrives.
    socket.send(encodeWireFrame(sync));
  }

  private async sendSyncNow(socket: WebSocket): Promise<void> {
    if (socket !== this.socket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    if (this.jobHistory?.mode === "off") return;
    const jobs = await this.captureSyncJobs(this.jobHistory === undefined ? 100 : 500);
    if (jobs === undefined || socket !== this.socket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    const workspaces = this.runtime.syncWorkspaceMetadata();
    const snapshot = JSON.stringify({ workspaces, jobs });
    if (snapshot === this.lastSyncSnapshot) return;
    const sync: RunnerSync = {
      type: "runner.sync",
      protocol_version: PROTOCOL_CURRENT_VERSION,
      runner_id: this.config.runnerId,
      sync_sequence: this.syncSequence++,
      ...(this.jobHistory === undefined ? {} : {extensions:{runmesh_history_ack:true}}),
      sent_at_ms: Date.now(),
      workspaces,
      jobs,
    };
    try {
      if (this.jobHistory !== undefined) this.historyPending = {requestId:`history-${sync.sync_sequence}`,snapshot,socket};
      socket.send(encodeWireFrame(sync));
      if (this.jobHistory === undefined) this.lastSyncSnapshot = snapshot;
    } catch { /* close handler drives reconnect */ }
  }

  private async respondToRpc(socket: WebSocket, request: RpcRequest, sessionCurrent: () => boolean): Promise<void> {
    let admitted = false;
    try {
      if (!sessionCurrent()) return;
      const expectedRevision = this.appliedPolicyRevision;
      if (request.method !== "echo" && request.method !== "runner.info" && (expectedRevision === null || request.policy_revision === undefined || request.policy_revision !== expectedRevision)) throw new Error("stale_policy");
      const limit = CONTROL_RPC_METHODS.has(request.method) ? MAX_IN_FLIGHT_RPCS : MAX_IN_FLIGHT_RPCS - RESERVED_CONTROL_RPCS;
      if (this.inFlightRpcs >= limit) throw new RpcRuntimeError("busy", "Runner RPC concurrency limit reached; this request was not started");
      this.inFlightRpcs++; admitted = true;
      const result = request.method === "echo" ? request.params : request.method === "runner.info" ? this.metadata : await this.runtime.dispatch(request.method, request.params);
      if (sessionCurrent() && socket.readyState === WebSocket.OPEN) socket.send(encodeWireFrame({ type: "rpc.response", protocol_version: request.protocol_version, request_id: request.request_id, result: result as RpcRequest["params"] }));
    } catch (error) {
      const details = rpcError(error);
      if (sessionCurrent() && socket.readyState === WebSocket.OPEN) {
        try { socket.send(encodeWireFrame({ type: "rpc.error", protocol_version: request.protocol_version, request_id: request.request_id, error: { code: details.code, message: details.message, failure_class: details.failure_class, operation_state: details.operation_state, ...(details.retry_after_ms === undefined ? {} : { retry_after_ms: details.retry_after_ms }), next_action: details.next_action, ...(details.details === undefined ? {} : { details: details.details as RpcRequest["params"] }) } })); } catch { /* close handler drives reconnect */ }
      }
    } finally {
      if (admitted) this.inFlightRpcs--;
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
    // Job lifecycle frames are only valid on an authorized session. Emitting one
    // before `runner.welcome`, or on a superseded socket, closes that transport.
    // Older Workers misclassified it as a permanent credential rejection. The welcome handler
    // and the periodic sync reconcile any lifecycle event dropped here.
    if (socket === undefined || socket !== this.welcomedSocket || this.stopped || socket.readyState !== WebSocket.OPEN) return;
    // Log reads and output bytes do not dirty metadata. A no-record Job
    // never starts an upload timer and remains available to local live tools.
    if (event.job.record_history === false) return;
    if (this.reportingNegotiated) {
      if (event.type !== "output") this.historyUploads.changed();
      return;
    }
    // Batched/off modes do not emit lifecycle frames or event-triggered full
    // snapshots. The local durable Job store is sampled by the sync timer.
    if (this.jobHistory !== undefined && this.jobHistory.mode !== "immediate") return;
    try {
      const message = jobEventMessage(event, this.config.runnerId);
      if (message !== undefined) socket.send(encodeWireFrame(message));
    } catch { /* local persistence remains authoritative; transport is best effort */ }
    // Event delivery is intentionally best effort, while the periodic sync is
    // the durable reconciliation path.  Push a snapshot after lifecycle
    // boundaries so an MCP job is visible to Registry immediately even when
    // the event frame races the next job/list request.
    if (event.type !== "output") void this.sendSync(socket).catch(() => undefined);
  }
}
