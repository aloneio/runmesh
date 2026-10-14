import { cancelBody } from "../body.js";
import { RUNNER_HEARTBEAT_PERSISTENCE_INTERVAL_MS, type HeartbeatRetry, type HeartbeatRetryPolicy } from "../contracts/runner-heartbeat.js";
import { reportControlPlaneFailure } from "./control-plane-diagnostics.js";

/** Only heartbeat persistence uses this lane. Session checks, policy ACKs,
 * RPCs and command execution must never be skipped or retried through it. */
export class RunnerHeartbeatPersistence {
  private readonly inFlight = new WeakSet<WebSocket>();
  private readonly fallback = new WeakMap<WebSocket, HeartbeatRetry | undefined>();
  private readonly persisted = new WeakMap<WebSocket, number>();

  public constructor(private readonly policy: HeartbeatRetryPolicy, private readonly legacyReconnect = false) {}

  public async record(socket: WebSocket, request: () => Promise<Response>, reject: (response: Response) => void): Promise<boolean> {
    const attemptedAtMs = Date.now();
    const previous = this.readRetry(socket);
    const persistedAtMs = this.readPersistedAt(socket);
    // Only a completed persistence receipt advances this clock. Transport
    // pongs and skipped telemetry frames never establish authority or freshness.
    if (this.inFlight.has(socket) || (!this.legacyReconnect && this.policy.active(previous, attemptedAtMs))
      || (typeof persistedAtMs === "number" && Number.isSafeInteger(persistedAtMs) && persistedAtMs >= 0
        && attemptedAtMs >= persistedAtMs && attemptedAtMs - persistedAtMs < RUNNER_HEARTBEAT_PERSISTENCE_INTERVAL_MS)) return false;
    this.inFlight.add(socket);
    try {
      let response: Response;
      try { response = await request(); }
      catch (error) {
        reportControlPlaneFailure("runner_heartbeat", "exception", error);
        response = new Response(null, { status: 503 });
      }
      if (response.status === 204) {
        cancelBody(response);
        if (previous !== undefined) this.writeRetry(socket, undefined);
        this.writePersistedAt(socket, attemptedAtMs);
        return true;
      }
      if (response.ok) {
        // A deferred or malformed receipt is not proof of a Registry commit.
        reportControlPlaneFailure("runner_heartbeat", "invalid_receipt", undefined, response.status);
        cancelBody(response);
        response = new Response(null, { status: 503 });
      }
      if (this.legacyReconnect || !this.policy.temporaryFailure(response.status)) {
        // Explicit credential/session rejection and malformed nonretryable
        // receipts retain their original close semantics.
        reject(response);
        return false;
      }
      const retry = this.policy.next(previous, Date.now(), response.headers.get("retry-after"), Math.random());
      cancelBody(response);
      this.writeRetry(socket, retry);
      reportControlPlaneFailure("runner_heartbeat", "unexpected_status", undefined, response.status);
      // No socket close, success ACK, SQL write, Alarm, or RPC delivery.
      // Pending replies still undergo their independent current-session check.
      return false;
    } finally { this.inFlight.delete(socket); }
  }

  private readPersistedAt(socket: WebSocket): unknown {
    if (this.persisted.has(socket)) return this.persisted.get(socket);
    try { return socket.deserializeAttachment()?.heartbeatPersistedAtMs; }
    catch { return undefined; }
  }

  private writePersistedAt(socket: WebSocket, attemptedAtMs: number): void {
    this.persisted.set(socket, attemptedAtMs);
    try {
      const latest = socket.deserializeAttachment();
      if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return;
      socket.serializeAttachment({ ...latest, heartbeatPersistedAtMs: attemptedAtMs });
    } catch { /* Local coalescing remains active; reconstruction may probe once. */ }
  }

  private readRetry(socket: WebSocket): unknown {
    if (this.fallback.has(socket)) return this.fallback.get(socket);
    try { return socket.deserializeAttachment()?.heartbeatRetry; }
    catch { return undefined; }
  }

  private writeRetry(socket: WebSocket, retry: HeartbeatRetry | undefined): void {
    // A cleared local value must not revive stale attachment retry metadata.
    this.fallback.set(socket, retry);
    try {
      // Re-read after the await: never overwrite a concurrent identity/admission
      // update with the attachment captured before the Registry request.
      const latest = socket.deserializeAttachment();
      if (typeof latest !== "object" || latest === null || Array.isArray(latest)) return;
      if (retry === undefined) delete latest.heartbeatRetry;
      else latest.heartbeatRetry = retry;
      socket.serializeAttachment(latest);
    } catch {
      // Optional metadata must not recreate the outage-to-close coupling.
      // The isolate fallback still bounds attempts; a cold start may probe once.
    }
  }
}
