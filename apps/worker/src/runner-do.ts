import {
  decodeWireFrame,
  encodeWireFrame,
  negotiateProtocolVersion,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  RpcRequestSchema,
  WORKER_BRIDGE_TIMEOUT_MS,
  runnerPolicyChecksum,
  type WireMessage,
} from "@aloneio/runmesh-protocol";
import { bearerToken, internalHeaders, verifyInternalRequest } from "./security.js";
import { PRODUCT_VERSION } from "./generated-version.js";

export interface WorkerEnv {
  REGISTRY: DurableObjectNamespace;
  RUNNER: DurableObjectNamespace;
  WORKER_ID?: string;
  ADMIN_TOKEN?: string;
  SETUP_TOKEN?: string;
  SETUP_TOKEN_HASH?: string;
  RUNNER_TOKEN_PEPPER?: string;
  INTERNAL_CONTROL_SECRET?: string;
  RUNMESH_RELEASE_VERSION?: string;
  RUNMESH_RELEASE_MANIFEST_URL?: string;
  RUNMESH_RELEASE_SIGNATURE_URL?: string;
  RUNMESH_RELEASE_SIGNATURE_DESCRIPTOR_URL?: string;
  RUNMESH_RELEASE_KEY_ID?: string;
  /** A stable, externally resolvable npm package@version or HTTPS .tgz package URL for the public bootstrap installers. */
  RUNNER_PACKAGE_SPEC?: string;
  /** Required with a URL package spec; otherwise inferred from an npm package@version spec. */
  RUNNER_PACKAGE_NAME?: string;
  RUNNER_PACKAGE_VERSION?: string;
  readonly RUNNER_ARTIFACT_SHA256?: string;
  /** Optional immutable per-platform release artifacts. */
  readonly RUNNER_ARTIFACTS_JSON?: string;
  /** Static assets served by the Worker asset binding. */
  ASSETS?: Fetcher;
}

interface ConnectionAttachment {
  runnerId: string;
  sessionId: string;
  epoch: number;
  credentialVersion: number;
  protocolVersion: number;
  authenticated: boolean;
  readonly helloDeadlineMs: number;
}

const HELLO_DEADLINE_MS = 10_000;
const BRIDGE_TIMEOUT_MS = WORKER_BRIDGE_TIMEOUT_MS;
const MAX_BRIDGE_IN_FLIGHT = 32;
const MAX_BRIDGE_BODY_BYTES = 1_048_576;
type BridgeReply = Extract<WireMessage, { type: "rpc.response" | "rpc.error" }>;
type BridgeWaiter = { readonly resolve: (value: BridgeReply) => void; readonly timer: ReturnType<typeof setTimeout>; readonly socket: WebSocket };


interface AdmissionState {
  readonly fenced: boolean;
  readonly reconciled: boolean;
  readonly runnerId: string | null;
  readonly activeRevision: number | null;
  readonly activeChecksum: string | null;
  readonly desiredRevision: number | null;
  readonly desiredChecksum: string | null;
  readonly connectionEpoch: number | null;
  readonly credentialVersion: number | null;
  readonly sessionId: string | null;
  readonly mutationId: string | null;
  readonly lastReconciledAtMs: number | null;
}
const ADMISSION_STATE_KEY = "policy-admission-v1";
const FENCED_ADMISSION: AdmissionState = {
  fenced: true, reconciled: false, runnerId: null, activeRevision: null, activeChecksum: null,
  desiredRevision: null, desiredChecksum: null, connectionEpoch: null, credentialVersion: null,
  sessionId: null, mutationId: null, lastReconciledAtMs: null,
};

export class RunnerDO {
  private readonly bridgeWaiters = new Map<string, BridgeWaiter>();
  private admissionState: AdmissionState | undefined;
  public constructor(
    private readonly ctx: DurableObjectState<unknown>,
    private readonly env: WorkerEnv,
  ) {
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.setHibernatableWebSocketEventTimeout(30_000);
  }

  public async fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/policy") {
      const body = await request.text();
      if (!await this.verifyInternalRequest(body, request)) return new Response("not found", { status: 404 });
      // Persist before any Registry or socket await: a concurrent protected RPC
      // observes this fence even while policy delivery is in flight.
      await this.fence("policy-update");
      const socket = await this.currentRunnerSocket();
      if (socket === undefined) return Response.json({ error: { code: "runner_offline", message: "runner is not connected" } }, { status: 503 });
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment === null || attachment.epoch === 0 || attachment.protocolVersion === 0) return Response.json({ error: { code: "runner_offline", message: "runner is not connected" } }, { status: 503 });
      const desired = await this.registryRequest(attachment.runnerId, "/desired-policy", { method: "GET" });
      if (desired.status === 404) return new Response(null, { status: 204 });
      if (!desired.ok) return Response.json({ error: { code: "registry_unavailable", message: "policy is unavailable" } }, { status: 503 });
      const policy = await desired.json() as unknown;
      if (!isPolicy(policy)) return Response.json({ error: { code: "invalid_policy", message: "registry returned an invalid policy" } }, { status: 502 });
      await this.persistAdmission({ ...(await this.admission()), desiredRevision: policy.revision, desiredChecksum: policy.checksum, mutationId: `policy-${policy.revision}`, fenced: true, reconciled: false });
      const message: WireMessage = { type: "runner.policy_update", protocol_version: attachment.protocolVersion, request_id: `policy-${crypto.randomUUID()}`, runner_id: attachment.runnerId, policy };
      try { socket.send(encodeWireFrame(message)); } catch { return Response.json({ error: { code: "runner_offline", message: "runner is not connected" } }, { status: 503 }); }
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/revoke") {
      const body = await request.text();
      if (!await this.verifyInternalRequest(body, request)) return new Response("not found", { status: 404 });
      await this.fence("credential-revoked");
      for (const socket of this.ctx.getWebSockets("runner")) {
        this.rejectBridgeWaiters(socket, "credentials revoked");
        socket.close(4001, "credentials revoked");
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/delete") {
      const body = await request.text();
      if (!await this.verifyInternalRequest(body, request)) return new Response("not found", { status: 404 });
      await this.fence("runner-deleted");
      for (const socket of this.ctx.getWebSockets("runner")) {
        this.rejectBridgeWaiters(socket, "runner deleted");
        socket.close(4001, "runner deleted");
      }
      await this.ctx.storage.delete(ADMISSION_STATE_KEY);
      this.admissionState = { ...FENCED_ADMISSION };
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return this.forwardInternalRpc(request);
    }
    const runnerId = parseRunnerPath(new URL(request.url).pathname);
    const token = bearerToken(request);
    if (runnerId === undefined || token === undefined || this.env.RUNNER_TOKEN_PEPPER === undefined) {
      return new Response("unauthorized", { status: 401 });
    }
    const authResponse = await this.registryRequest(runnerId, "/auth", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    if (!authResponse.ok) return new Response("unauthorized", { status: 401 });
    const authBody = await authResponse.json() as { credential_version?: unknown };
    if (typeof authBody.credential_version !== "number") return new Response("unauthorized", { status: 401 });

    const pair = new WebSocketPair();
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      runnerId,
      sessionId: crypto.randomUUID(),
      epoch: 0,
      credentialVersion: authBody.credential_version,
      protocolVersion: 0,
      authenticated: true,
      helloDeadlineMs: Date.now() + HELLO_DEADLINE_MS,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, ["runner"]);
    await this.scheduleHelloDeadline();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  public async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (attachment === null || !attachment.authenticated || (attachment.epoch === 0 && Date.now() > attachment.helloDeadlineMs)) {
      ws.close(1008, "hello timeout");
      return;
    }
    let message: WireMessage;
    try {
      message = decodeWireFrame(typeof raw === "string" ? raw : new Uint8Array(raw));
    } catch {
      this.rejectBridgeWaiters(ws, "invalid protocol frame");
      ws.close(1007, "invalid protocol frame");
      return;
    }
    if (message.type === "runner.hello") {
      if (message.runner.runner_id !== attachment.runnerId) {
        ws.close(1008, "runner id mismatch");
        return;
      }
      const negotiation = negotiateProtocolVersion(
        { min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION },
        { min_protocol_version: message.min_protocol_version, max_protocol_version: message.max_protocol_version },
      );
      if (!negotiation.ok) {
        ws.close(1002, negotiation.error.code);
        return;
      }
      const epochResponse = await this.registryRequest(attachment.runnerId, "/connect", {
        method: "POST",
        body: JSON.stringify({ metadata: message.runner, min_protocol_version: message.min_protocol_version, max_protocol_version: message.max_protocol_version, session_id: attachment.sessionId, credential_version: attachment.credentialVersion, now_ms: Date.now() }),
      });
      if (!epochResponse.ok) {
        ws.close(1008, "stale credentials");
        return;
      }
      const body = await epochResponse.json() as { epoch?: unknown; desired_policy?: unknown };
      if (typeof body.epoch !== "number") {
        ws.close(1011, "invalid registry response");
        return;
      }
      attachment.epoch = body.epoch;
      attachment.protocolVersion = negotiation.protocol_version;
      ws.serializeAttachment(attachment);
      await this.persistAdmission({
        ...(await this.admission()), fenced: true, reconciled: false, runnerId: attachment.runnerId,
        connectionEpoch: attachment.epoch, credentialVersion: attachment.credentialVersion, sessionId: attachment.sessionId,
        desiredRevision: isPolicy(body.desired_policy) ? body.desired_policy.revision : null,
        desiredChecksum: isPolicy(body.desired_policy) ? body.desired_policy.checksum : null,
        activeRevision: null, activeChecksum: null, mutationId: null, lastReconciledAtMs: null,
      });
      for (const existing of this.ctx.getWebSockets("runner")) {
        if (existing !== ws) {
          const old = existing.deserializeAttachment() as ConnectionAttachment | null;
          if (old?.runnerId === attachment.runnerId && old.epoch < attachment.epoch) existing.close(4000, "replaced by newer session");
        }
      }
      const welcome: WireMessage = {
        type: "runner.welcome", protocol_version: negotiation.protocol_version, request_id: message.request_id,
        session_id: attachment.sessionId, negotiated_protocol_version: negotiation.protocol_version,
        worker: {
          worker_id: this.env.WORKER_ID ?? "worker-local", worker_version: PRODUCT_VERSION,
          capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "cloudflare" } },
        },
        ...(isPolicy(body.desired_policy) ? { desired_policy: body.desired_policy } : {}),
      };
      ws.send(encodeWireFrame(welcome));
      return;
    }
    if (attachment.epoch === 0 || attachment.protocolVersion !== message.protocol_version || !(await this.isCurrent(attachment))) {
      this.rejectBridgeWaiters(ws, "credentials revoked");
      ws.close(4001, "credentials revoked");
      return;
    }
    if (message.type === "rpc.response" || message.type === "rpc.error") {
      const waiter = this.bridgeWaiters.get(message.request_id);
      if (waiter !== undefined && waiter.socket === ws) {
        clearTimeout(waiter.timer);
        this.bridgeWaiters.delete(message.request_id);
        waiter.resolve(message);
      }
      return;
    }
    if (message.type === "job.output") {
      // Output is intentionally not persisted upstream: it can be unbounded,
      // while complete logs remain in the local runner's files.
      return;
    }
    if (message.type === "job.started" || message.type === "job.status" || message.type === "job.completed") {
      const response = await this.registryRequest(attachment.runnerId, "/event", { method: "POST", body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion, message, now_ms: Date.now() }) });
      if (!response.ok) ws.close(4001, "stale session");
      return;
    }
    if (message.type === "runner.heartbeat") {
      if (message.runner_id !== attachment.runnerId) return ws.close(1008, "runner identity mismatch");
      const response = await this.registryRequest(attachment.runnerId, "/heartbeat", { method: "POST", body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion, now_ms: Date.now() }) });
      if (!response.ok) ws.close(4001, "credentials revoked");
      return;
    }
    if (message.type === "runner.policy_ack") {
      if (message.runner_id !== attachment.runnerId) return ws.close(1008, "runner identity mismatch");
      const response = await this.registryRequest(attachment.runnerId, "/policy-ack", { method: "POST", body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion, desired_revision: message.desired_revision, desired_checksum: message.desired_checksum, applied_revision: message.applied_revision, applied_checksum: message.applied_checksum, runner_reported_policy_revision: message.runner_reported_policy_revision, runner_reported_policy_checksum: message.runner_reported_policy_checksum, status: message.status, workspace_status: message.workspace_status }) });
      if (!response.ok && response.status !== 204) {
        // A stale but otherwise valid ACK is safe to ignore; Registry returns
        // 204 for it. Malformed/conflicting ACKs keep the fence in place.
        await this.fence("invalid-policy-ack");
        ws.close(4001, "stale policy acknowledgement");
        return;
      }
      if (message.status === "applied") await this.reconcileAdmission(attachment);
      else await this.fence("policy-not-applied");
      return;
    }
    if (message.type === "runner.sync") {
      if (message.runner_id !== attachment.runnerId) return ws.close(1008, "runner identity mismatch");
      const response = await this.registryRequest(attachment.runnerId, "/sync", { method: "POST", body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion, message, now_ms: Date.now() }) });
      if (!response.ok) ws.close(4001, "credentials revoked");
      return;
    }
    if (message.type === "rpc.request") {
      // Cloudflare only forwards a correlated frame to the connected local runner.
      // It never interprets filesystem or process RPCs; MCP-facing routing follows later.
      const result = message.method === "echo" ? message.params : message.method === "runner.info" ? { runner_id: attachment.runnerId, session_id: attachment.sessionId, state: "online" } : undefined;
      ws.send(encodeWireFrame(result === undefined ? { type: "rpc.error", protocol_version: message.protocol_version, request_id: message.request_id, error: { code: "method_not_found", message: `Unsupported method: ${message.method}` } } : { type: "rpc.response", protocol_version: message.protocol_version, request_id: message.request_id, result }));
    }
  }

  public async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets("runner")) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.epoch === 0 && attachment.helloDeadlineMs <= now) socket.close(1008, "hello timeout");
    }
    await this.scheduleHelloDeadline();
  }

  public async webSocketClose(ws: WebSocket): Promise<void> {
    this.rejectBridgeWaiters(ws, "runner connection closed");
    await this.markSocket(ws, "offline");
    await this.scheduleHelloDeadline();
  }
  public webSocketError(ws: WebSocket): Promise<void> {
    this.rejectBridgeWaiters(ws, "runner connection error");
    return this.markSocket(ws, "stale");
  }

  private async forwardInternalRpc(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("not found", { status: 404 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BRIDGE_BODY_BYTES || !await this.verifyInternalRequest(body, request)) return new Response("not found", { status: 404 });
    let input: { method?: unknown; params?: unknown; policy_revision?: unknown; expected_policy_revision?: unknown; expected_policy_checksum?: unknown };
    try { input = JSON.parse(body) as { method?: unknown; params?: unknown; policy_revision?: unknown; expected_policy_revision?: unknown; expected_policy_checksum?: unknown }; } catch { return Response.json({ error: { code: "invalid_request", message: "invalid JSON object" } }, { status: 400 }); }
    if (typeof input !== "object" || input === null || Array.isArray(input)) return Response.json({ error: { code: "invalid_request", message: "invalid JSON object" } }, { status: 400 });
    const socket = await this.currentRunnerSocket();
    const attachment = socket?.deserializeAttachment() as ConnectionAttachment | null;
    if (socket === undefined || attachment === null || attachment.epoch === 0 || attachment.protocolVersion === 0) return Response.json({ error: { code: "runner_offline", message: "runner is not connected" } }, { status: 503 });
    if (this.bridgeWaiters.size >= MAX_BRIDGE_IN_FLIGHT) return Response.json({ error: { code: "busy", message: "bridge concurrency limit reached" } }, { status: 429 });
    const requestPolicyRevision = typeof input.policy_revision === "number" && Number.isSafeInteger(input.policy_revision) && input.policy_revision > 0 ? input.policy_revision : undefined;
    const expectedPolicyRevision = typeof input.expected_policy_revision === "number" && Number.isSafeInteger(input.expected_policy_revision) && input.expected_policy_revision > 0 ? input.expected_policy_revision : undefined;
    const expectedPolicyChecksum = typeof input.expected_policy_checksum === "string" && /^[a-f0-9]{64}$/.test(input.expected_policy_checksum) ? input.expected_policy_checksum : undefined;
    const method = typeof input.method === "string" ? input.method : "";
    if (requestPolicyRevision === undefined && method !== "echo" && method !== "runner.info") {
      return Response.json({ error: { code: "stale_policy", message: "Protected RPC requires a policy revision" } }, { status: 409 });
    }
    if (requestPolicyRevision !== undefined && (expectedPolicyRevision !== requestPolicyRevision || expectedPolicyChecksum === undefined)) {
      return Response.json({ error: { code: "stale_policy", message: "Protected RPC requires a verified policy identity" } }, { status: 409 });
    }
    // This is deliberately the final asynchronous boundary before socket.send.
    // A concurrent mutation persists fenced=true before doing any Registry work.
    const admission = await this.admission();
    if (requestPolicyRevision !== undefined && expectedPolicyChecksum !== undefined && !this.admitsProtectedRpc(admission, attachment, requestPolicyRevision, expectedPolicyChecksum)) {
      return Response.json({ error: { code: "stale_policy", message: "Runner policy admission is fenced or stale" } }, { status: 409 });
    }
    const requestId = `bridge-${crypto.randomUUID()}`;
    const parsed = RpcRequestSchema.safeParse({ type: "rpc.request", protocol_version: attachment.protocolVersion, request_id: requestId, method: input.method, params: input.params, ...(requestPolicyRevision === undefined ? {} : { policy_revision: requestPolicyRevision }) });
    if (!parsed.success) return Response.json({ error: { code: "invalid_request", message: "invalid RPC request" } }, { status: 400 });
    const reply = await new Promise<BridgeReply>((resolve) => {
      const timer = setTimeout(() => {
        this.bridgeWaiters.delete(requestId);
        resolve({ type: "rpc.error", protocol_version: attachment.protocolVersion, request_id: requestId, error: { code: "timeout", message: "runner RPC timed out" } });
      }, BRIDGE_TIMEOUT_MS);
      this.bridgeWaiters.set(requestId, { resolve, timer, socket });
      try { socket.send(encodeWireFrame(parsed.data)); } catch {
        clearTimeout(timer); this.bridgeWaiters.delete(requestId);
        resolve({ type: "rpc.error", protocol_version: attachment.protocolVersion, request_id: requestId, error: { code: "runner_offline", message: "runner is not connected" } });
      }
    });
    return reply.type === "rpc.response" ? Response.json(reply) : Response.json(reply, { status: reply.error.code === "timeout" ? 504 : 502 });
  }

  private rejectBridgeWaiters(socket: WebSocket, message: string): void {
    for (const [requestId, waiter] of this.bridgeWaiters) {
      if (waiter.socket !== socket) continue;
      clearTimeout(waiter.timer);
      this.bridgeWaiters.delete(requestId);
      const attachment = waiter.socket.deserializeAttachment() as ConnectionAttachment | null;
      waiter.resolve({ type: "rpc.error", protocol_version: attachment?.protocolVersion ?? PROTOCOL_CURRENT_VERSION, request_id: requestId, error: { code: "runner_offline", message } });
    }
  }

  private async admission(): Promise<AdmissionState> {
    if (this.admissionState !== undefined) return this.admissionState;
    const stored = await this.ctx.storage.get<AdmissionState>(ADMISSION_STATE_KEY);
    // A restart/hibernation is an authorization boundary. Even a previously
    // reconciled value must be fenced until this session has rechecked the
    // Registry identity against its current socket epoch and credential.
    this.admissionState = validAdmissionState(stored)
      ? { ...stored, fenced: true, reconciled: false, activeRevision: null, activeChecksum: null, mutationId: "restart-reconcile", lastReconciledAtMs: null }
      : { ...FENCED_ADMISSION };
    return this.admissionState;
  }

  private async persistAdmission(next: AdmissionState): Promise<void> {
    this.admissionState = next;
    await this.ctx.storage.put(ADMISSION_STATE_KEY, next);
  }

  private async fence(mutationId: string): Promise<void> {
    const current = await this.admission();
    await this.persistAdmission({ ...current, fenced: true, reconciled: false, mutationId, activeRevision: null, activeChecksum: null, lastReconciledAtMs: null });
  }

  private async reconcileAdmission(attachment: ConnectionAttachment): Promise<void> {
    const response = await this.registryRequest(attachment.runnerId, "/policy-revision", { method: "GET" });
    if (!response.ok) { await this.fence("registry-reconcile-failed"); return; }
    const value = await response.json() as Record<string, unknown>;
    const revision = value.applied_policy_revision;
    const checksum = value.active_policy_checksum;
    const ready = value.policy_status === "applied"
      && value.desired_policy_revision === revision
      && value.runner_reported_policy_revision === revision
      && value.desired_policy_checksum === checksum
      && value.runner_reported_policy_checksum === checksum
      && typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0
      && typeof checksum === "string" && /^[a-f0-9]{64}$/.test(checksum);
    if (!ready) { await this.fence("registry-reconcile-stale"); return; }
    await this.persistAdmission({
      fenced: false, reconciled: true, runnerId: attachment.runnerId,
      activeRevision: revision, activeChecksum: checksum, desiredRevision: revision, desiredChecksum: checksum,
      connectionEpoch: attachment.epoch, credentialVersion: attachment.credentialVersion, sessionId: attachment.sessionId,
      mutationId: null, lastReconciledAtMs: Date.now(),
    });
  }

  private admitsProtectedRpc(state: AdmissionState, attachment: ConnectionAttachment, revision: number, checksum: string): boolean {
    return !state.fenced && state.reconciled
      && state.runnerId === attachment.runnerId
      && state.connectionEpoch === attachment.epoch
      && state.credentialVersion === attachment.credentialVersion
      && state.sessionId === attachment.sessionId
      && state.activeRevision === revision && state.activeChecksum === checksum
      && state.desiredRevision === revision && state.desiredChecksum === checksum;
  }

  private async currentRunnerSocket(): Promise<WebSocket | undefined> {
    for (const socket of this.ctx.getWebSockets("runner")) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.authenticated === true && attachment.epoch > 0 && attachment.protocolVersion > 0 && await this.isCurrent(attachment, true)) return socket;
    }
    return undefined;
  }
  private async markSocket(ws: WebSocket, state: "offline" | "stale"): Promise<void> {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;
    if (attachment === null || attachment.epoch === 0) return;
    await this.registryRequest(attachment.runnerId, "/disconnect", { method: "POST", body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion, state, now_ms: Date.now() }) });
  }

  private async scheduleHelloDeadline(): Promise<void> {
    let earliest: number | undefined;
    for (const socket of this.ctx.getWebSockets("runner")) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.epoch === 0 && (earliest === undefined || attachment.helloDeadlineMs < earliest)) earliest = attachment.helloDeadlineMs;
    }
    if (earliest !== undefined) await this.ctx.storage.setAlarm(earliest);
  }

  private async isCurrent(attachment: ConnectionAttachment, requireOnline = false): Promise<boolean> {
    const response = await this.registryRequest(attachment.runnerId, "/session", {
      method: "POST",
      body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion, require_online: requireOnline }),
    });
    return response.ok;
  }

  private async verifyInternalRequest(body: string, request: Request): Promise<boolean> {
    return verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, body, async (nonce, expiresAtMs) => {
      const payload = JSON.stringify({ nonce, expires_at_ms: expiresAtMs });
      const headers = await internalHeaders(this.env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/auth/internal-nonces", payload);
      const response = await this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry")).fetch(new Request("https://registry.internal/auth/internal-nonces", { method: "POST", headers, body: payload }));
      return response.status === 204;
    });
  }

  private registryRequest(runnerId: string, action: string, init: RequestInit): Promise<Response> {
    const id = this.env.REGISTRY.idFromName("registry");
    const path = `/runners/${encodeURIComponent(runnerId)}${action}`;
    const body = typeof init.body === "string" ? init.body : "";
    const headersPromise = internalHeaders(this.env.INTERNAL_CONTROL_SECRET ?? "", init.method ?? "GET", path, body);
    return headersPromise.then((headers) => this.env.REGISTRY.get(id).fetch(new Request(`https://registry.internal${path}`, { ...init, headers })));
  }
}

function validAdmissionState(value: unknown): value is AdmissionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.fenced === "boolean" && typeof state.reconciled === "boolean"
    && (state.runnerId === null || typeof state.runnerId === "string")
    && (state.activeRevision === null || Number.isSafeInteger(state.activeRevision))
    && (state.activeChecksum === null || typeof state.activeChecksum === "string")
    && (state.desiredRevision === null || Number.isSafeInteger(state.desiredRevision))
    && (state.desiredChecksum === null || typeof state.desiredChecksum === "string")
    && (state.connectionEpoch === null || Number.isSafeInteger(state.connectionEpoch))
    && (state.credentialVersion === null || Number.isSafeInteger(state.credentialVersion))
    && (state.sessionId === null || typeof state.sessionId === "string")
    && (state.mutationId === null || typeof state.mutationId === "string")
    && (state.lastReconciledAtMs === null || Number.isSafeInteger(state.lastReconciledAtMs));
}

function isPolicy(value: unknown): value is { schema_version: 1; runner_id: string; revision: number; checksum: string; runner_permissions: { read: boolean; edit: boolean; shell: boolean; job_control: boolean }; workspaces: Array<{ workspace_id: string; root_path: string; enabled: boolean; permissions: { read: boolean; edit: boolean; shell: boolean; job_control: boolean } }> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>; const permissions = policy.runner_permissions as Record<string, unknown> | undefined;
  if (policy.schema_version !== 1 || typeof policy.runner_id !== "string" || !Number.isSafeInteger(policy.revision) || (policy.revision as number) <= 0 || typeof policy.checksum !== "string" || !/^[a-f0-9]{64}$/.test(policy.checksum) || !Array.isArray(policy.workspaces) || permissions === undefined || !["read", "edit", "shell", "job_control"].every((key) => typeof permissions[key] === "boolean")) return false;
  const unsigned = { schema_version: 1 as const, runner_id: policy.runner_id, revision: policy.revision as number, runner_permissions: permissions as { read: boolean; edit: boolean; shell: boolean; job_control: boolean }, workspaces: policy.workspaces };
  if (runnerPolicyChecksum(unsigned) !== policy.checksum) return false;
  return (policy.workspaces as unknown[]).every((workspace) => {
    if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return false;
    const item = workspace as Record<string, unknown>; const workspacePermissions = item.permissions;
    return typeof item.workspace_id === "string" && typeof item.root_path === "string" && typeof item.enabled === "boolean" && typeof workspacePermissions === "object" && workspacePermissions !== null && !Array.isArray(workspacePermissions) && ["read", "edit", "shell", "job_control"].every((key) => typeof (workspacePermissions as Record<string, unknown>)[key] === "boolean");
  });
}

function parseRunnerPath(pathname: string): string | undefined {
  const value = pathname.split("/").filter(Boolean).pop();
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decoded) ? decoded : undefined;
  } catch { return undefined; }
}
