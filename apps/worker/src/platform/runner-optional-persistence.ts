import { cancelBody } from "../body.js";
import type { HeartbeatRetry, HeartbeatRetryPolicy } from "../contracts/runner-heartbeat.js";
import { reportControlPlaneFailure } from "./control-plane-diagnostics.js";

type Lane = "sync" | "event";

/** Optional telemetry only. A skipped/failed request produces no success receipt
 * and grants no session, policy, execution or result-delivery authority. */
export class RunnerOptionalPersistence {
  private readonly inFlight = new WeakMap<WebSocket, Set<Lane>>();
  private readonly fallback = new WeakMap<WebSocket, Map<Lane, HeartbeatRetry | undefined>>();

  public constructor(private readonly policy: HeartbeatRetryPolicy) {}

  public async request(socket: WebSocket, lane: Lane, request: () => Promise<Response>, reject: (response: Response) => void): Promise<Response | undefined> {
    const previous = this.readRetry(socket, lane);
    let busy = this.inFlight.get(socket);
    if (busy?.has(lane) || this.policy.active(previous, Date.now())) return undefined;
    if (busy === undefined) { busy = new Set(); this.inFlight.set(socket, busy); }
    busy.add(lane);
    const stage = lane === "sync" ? "runner_history_sync" : "runner_history_event";
    try {
      let response: Response;
      try { response = await request(); }
      catch (error) {
        reportControlPlaneFailure(stage, "exception", error);
        response = new Response(null, { status: 503 });
      }
      if (response.ok) {
        if (previous !== undefined) this.writeRetry(socket, lane, undefined);
        return response;
      }
      if (!this.policy.temporaryFailure(response.status)) {
        reject(response);
        return undefined;
      }
      const retry = this.policy.next(previous, Date.now(), response.headers.get("retry-after"), Math.random());
      cancelBody(response);
      this.writeRetry(socket, lane, retry);
      reportControlPlaneFailure(stage, "unexpected_status", undefined, response.status);
      return undefined;
    } finally { busy.delete(lane); }
  }

  private readRetry(socket: WebSocket, lane: Lane): unknown {
    const local = this.fallback.get(socket);
    if (local?.has(lane)) return local.get(lane);
    try { return socket.deserializeAttachment()?.optionalPersistenceRetry?.[lane]; }
    catch { return undefined; }
  }

  private writeRetry(socket: WebSocket, lane: Lane, retry: HeartbeatRetry | undefined): void {
    let local = this.fallback.get(socket);
    if (local === undefined) { local = new Map(); this.fallback.set(socket, local); }
    local.set(lane, retry);
    try {
      // Preserve concurrent identity/admission updates across the Registry await.
      const latest = socket.deserializeAttachment();
      if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return;
      const retries = latest.optionalPersistenceRetry;
      const next = typeof retries === "object" && retries !== null && !Array.isArray(retries) ? { ...retries } : {};
      if (retry === undefined) delete next[lane];
      else next[lane] = retry;
      if (Object.keys(next).length === 0) delete latest.optionalPersistenceRetry;
      else latest.optionalPersistenceRetry = next;
      socket.serializeAttachment(latest);
    } catch { /* Optional metadata never turns an outage into a socket close. */ }
  }
}
