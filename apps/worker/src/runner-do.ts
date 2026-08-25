import {
  decodeWireFrame,
  encodeWireFrame,
  negotiateProtocolVersion,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  RpcRequestSchema,
  type WireMessage,
} from "@remote-coding-runtime/protocol";
import { bearerToken, internalHeaders, verifyInternalRequest } from "./security.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface WorkerEnv {
  REGISTRY: DurableObjectNamespace;
  RUNNER: DurableObjectNamespace;
  /** OAuthProvider persistence binding. Configure a real KV namespace in production. */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider for authorization UI flows. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Owner-controlled secret for the explicit password + consent authorization UI. */
  MCP_OWNER_PASSWORD?: string;
  /** Test/development-only static bearer gate; disabled when this secret is unset. */
  MCP_STATIC_TOKEN?: string;
  WORKER_ID?: string;
  WORKER_VERSION?: string;
  ADMIN_TOKEN?: string;
  RUNNER_TOKEN_PEPPER?: string;
  INTERNAL_CONTROL_SECRET?: string;
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
const BRIDGE_TIMEOUT_MS = 8_000;
const MAX_BRIDGE_IN_FLIGHT = 32;
const MAX_BRIDGE_BODY_BYTES = 1_048_576;
type BridgeReply = Extract<WireMessage, { type: "rpc.response" | "rpc.error" }>;
type BridgeWaiter = { readonly resolve: (value: BridgeReply) => void; readonly timer: ReturnType<typeof setTimeout>; readonly socket: WebSocket };


export class RunnerDO {
  private readonly bridgeWaiters = new Map<string, BridgeWaiter>();
  public constructor(
    private readonly ctx: DurableObjectState<unknown>,
    private readonly env: WorkerEnv,
  ) {
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.setHibernatableWebSocketEventTimeout(30_000);
  }

  public async fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/revoke") {
      const body = await request.text();
      if (!await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, body)) return new Response("not found", { status: 404 });
      for (const socket of this.ctx.getWebSockets("runner")) socket.close(4001, "credentials revoked");
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
        body: JSON.stringify({ metadata: message.runner, session_id: attachment.sessionId, credential_version: attachment.credentialVersion, now_ms: Date.now() }),
      });
      if (!epochResponse.ok) {
        ws.close(1008, "stale credentials");
        return;
      }
      const body = await epochResponse.json() as { epoch?: unknown };
      if (typeof body.epoch !== "number") {
        ws.close(1011, "invalid registry response");
        return;
      }
      attachment.epoch = body.epoch;
      attachment.protocolVersion = negotiation.protocol_version;
      ws.serializeAttachment(attachment);
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
          worker_id: this.env.WORKER_ID ?? "worker-local", worker_version: this.env.WORKER_VERSION ?? "0.1.0",
          capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "cloudflare" } },
        },
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
  public async webSocketError(ws: WebSocket): Promise<void> {
    this.rejectBridgeWaiters(ws, "runner connection error");
    await this.markSocket(ws, "stale");
  }

  private async forwardInternalRpc(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") return new Response("not found", { status: 404 });
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BRIDGE_BODY_BYTES || !await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, body)) return new Response("not found", { status: 404 });
    let input: { method?: unknown; params?: unknown };
    try { input = JSON.parse(body) as { method?: unknown; params?: unknown }; } catch { return Response.json({ error: { code: "invalid_request", message: "invalid JSON object" } }, { status: 400 }); }
    if (typeof input !== "object" || input === null || Array.isArray(input)) return Response.json({ error: { code: "invalid_request", message: "invalid JSON object" } }, { status: 400 });
    const socket = await this.currentRunnerSocket();
    const attachment = socket?.deserializeAttachment() as ConnectionAttachment | null;
    if (socket === undefined || attachment === null || attachment.epoch === 0 || attachment.protocolVersion === 0) return Response.json({ error: { code: "runner_offline", message: "runner is not connected" } }, { status: 503 });
    if (this.bridgeWaiters.size >= MAX_BRIDGE_IN_FLIGHT) return Response.json({ error: { code: "busy", message: "bridge concurrency limit reached" } }, { status: 429 });
    const requestId = `bridge-${crypto.randomUUID()}`;
    const parsed = RpcRequestSchema.safeParse({ type: "rpc.request", protocol_version: attachment.protocolVersion, request_id: requestId, method: input.method, params: input.params });
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
      waiter.resolve({ type: "rpc.error", protocol_version: 1, request_id: requestId, error: { code: "runner_offline", message } });
    }
  }

  private async currentRunnerSocket(): Promise<WebSocket | undefined> {
    for (const socket of this.ctx.getWebSockets("runner")) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.authenticated === true && attachment.epoch > 0 && attachment.protocolVersion > 0 && await this.isCurrent(attachment)) return socket;
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

  private async isCurrent(attachment: ConnectionAttachment): Promise<boolean> {
    const response = await this.registryRequest(attachment.runnerId, "/session", {
      method: "POST",
      body: JSON.stringify({ epoch: attachment.epoch, credential_version: attachment.credentialVersion }),
    });
    return response.ok;
  }

  private registryRequest(runnerId: string, action: string, init: RequestInit): Promise<Response> {
    const id = this.env.REGISTRY.idFromName("registry");
    const path = `/runners/${encodeURIComponent(runnerId)}${action}`;
    const body = typeof init.body === "string" ? init.body : "";
    const headersPromise = internalHeaders(this.env.INTERNAL_CONTROL_SECRET ?? "", init.method ?? "GET", path, body);
    return headersPromise.then((headers) => this.env.REGISTRY.get(id).fetch(new Request(`https://registry.internal${path}`, { ...init, headers })));
  }
}

function parseRunnerPath(pathname: string): string | undefined {
  const value = pathname.split("/").filter(Boolean).pop();
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(decoded) ? decoded : undefined;
  } catch { return undefined; }
}
