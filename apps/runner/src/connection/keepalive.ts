import { RUNNER_HEARTBEAT_PERSISTENCE_INTERVAL_MS } from "@aloneio/runmesh-protocol";

/** Only a Worker that negotiates independent ping/pong may slow persistence.
 * Older Workers retain their 30s heartbeat compatibility path. */
export function negotiatedHeartbeatInterval(extensions: Record<string, unknown> | undefined): number {
  return extensions?.runmesh_transport_ping === 1 && extensions.runmesh_heartbeat_interval_ms === RUNNER_HEARTBEAT_PERSISTENCE_INTERVAL_MS
    ? RUNNER_HEARTBEAT_PERSISTENCE_INTERVAL_MS : 30_000;
}

export const TRANSPORT_PING_INTERVAL_MS = 25_000;
export const TRANSPORT_PONG_TIMEOUT_MS = 75_000;

/** Internal monotonic clock; never a remote or deployment setting. */
export interface TransportKeepaliveClock {
  now(): number;
  every(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
const clock: TransportKeepaliveClock = {
  now: () => performance.now(),
  every: (callback, milliseconds) => { const timer = setInterval(callback, milliseconds); timer.unref(); return timer; },
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** One outstanding transport probe, tied to one welcomed socket. A pong is
 * evidence of transport only, never of current credentials or policy. */
export class RunnerTransportKeepalive {
  private timer: unknown;
  private running = false;
  private pendingSince: number | undefined;
  public constructor(private readonly current: () => boolean, private readonly ping: () => void,
    private readonly expired: () => void, private readonly time: TransportKeepaliveClock = clock) {}

  public start(): void {
    this.stop(); this.running = true; this.tick();
    if (this.running) this.timer = this.time.every(() => this.tick(), TRANSPORT_PING_INTERVAL_MS);
  }
  public stop(): void {
    this.running = false; this.pendingSince = undefined;
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
  }
  public acknowledge(): boolean {
    if (!this.running || !this.current() || this.pendingSince === undefined) return false;
    this.pendingSince = undefined;
    return true;
  }
  private tick(): void {
    if (!this.running || !this.current()) { this.stop(); return; }
    const now = this.time.now();
    if (this.pendingSince !== undefined) {
      if (now - this.pendingSince >= TRANSPORT_PONG_TIMEOUT_MS) this.lose();
      return;
    }
    this.pendingSince = now;
    try { this.ping(); } catch { this.lose(); }
  }
  private lose(): void {
    this.stop();
    try { this.expired(); } catch { /* Retired transport cleanup is best effort. */ }
  }
}
