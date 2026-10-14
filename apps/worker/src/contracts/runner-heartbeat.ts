export { RUNNER_HEARTBEAT_PERSISTENCE_INTERVAL_MS } from "@aloneio/runmesh-protocol";

/** Non-authoritative retry metadata; never an authorization grant or usage meter. */
export interface HeartbeatRetry {
  readonly failures: number;
  readonly failedAtMs: number;
  readonly retryAtMs: number;
}

/** Composition supplies pure retry decisions to the transport adapter. */
export interface HeartbeatRetryPolicy {
  readonly active: (value: unknown, nowMs: number) => boolean;
  readonly next: (previous: unknown, nowMs: number, retryAfter: string | null, random: number) => HeartbeatRetry;
  readonly temporaryFailure: (status: number) => boolean;
}
