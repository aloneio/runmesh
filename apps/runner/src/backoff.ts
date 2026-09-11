export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export function reconnectDelayMs(attempt: number, random = Math.random()): number {
  const index = Math.min(Math.max(0, attempt), RECONNECT_DELAYS_MS.length - 1);
  const base = RECONNECT_DELAYS_MS[index] ?? RECONNECT_DELAYS_MS[0];
  // Jitter spreads reconnect storms while never exceeding the advertised cap.
  const jitterFactor = 0.75 + Math.min(1, Math.max(0, random)) * 0.25;
  return Math.round(base * jitterFactor);
}

/** Overload/storage outages use a slower lane than an ordinary broken socket. */
export function serviceReconnectDelayMs(attempt: number, random = Math.random(), retryAfterMs = 30_000): number {
  const index = Number.isFinite(attempt) ? Math.min(4, Math.max(0, Math.floor(attempt))) : 4;
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
  const base = Math.min(300_000, 30_000 * 2 ** index);
  const requested = Number.isFinite(retryAfterMs) ? Math.min(900_000, Math.max(30_000, retryAfterMs)) : 30_000;
  return Math.max(requested, Math.min(300_000, Math.round(base * (1 + jitter * 0.25))));
}

export function retryAfterDelayMs(value: string | undefined, nowMs = Date.now()): number {
  if (value === undefined) return 30_000;
  const duration = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - nowMs;
  return Number.isFinite(duration) ? Math.min(900_000, Math.max(30_000, duration)) : 30_000;
}
