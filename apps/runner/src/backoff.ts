export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export function reconnectDelayMs(attempt: number, random = Math.random()): number {
  const index = Math.min(Math.max(0, attempt), RECONNECT_DELAYS_MS.length - 1);
  const base = RECONNECT_DELAYS_MS[index] ?? RECONNECT_DELAYS_MS[0];
  // Jitter spreads reconnect storms while never exceeding the advertised cap.
  const jitterFactor = 0.75 + Math.min(1, Math.max(0, random)) * 0.25;
  return Math.round(base * jitterFactor);
}
