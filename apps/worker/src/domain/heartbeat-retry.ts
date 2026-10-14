import type { HeartbeatRetry } from "../contracts/runner-heartbeat.js";

const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 300_000;
const MAX_RETRY_AFTER_MS = 900_000;

function validRetry(value: unknown): value is HeartbeatRetry {
  if (typeof value !== "object" || value === null) return false;
  const retry = value as HeartbeatRetry;
  return Number.isSafeInteger(retry.failures) && retry.failures >= 1 && retry.failures <= 16
    && Number.isSafeInteger(retry.failedAtMs) && retry.failedAtMs >= 0
    && Number.isSafeInteger(retry.retryAtMs) && retry.retryAtMs >= retry.failedAtMs + MIN_DELAY_MS
    && retry.retryAtMs <= retry.failedAtMs + MAX_RETRY_AFTER_MS;
}

export function heartbeatRetryActive(value: unknown, nowMs: number): boolean {
  // A rolled-back clock must not turn a bounded cooldown into an indefinite one.
  return validRetry(value) && nowMs >= value.failedAtMs && nowMs < value.retryAtMs;
}

export function nextHeartbeatRetry(previous: unknown, nowMs: number, retryAfter: string | null, random: number): HeartbeatRetry {
  const failures = validRetry(previous) ? Math.min(16, previous.failures + 1) : 1;
  const upper = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** Math.min(failures - 1, 4) * 1.25);
  const lower = Math.max(MIN_DELAY_MS, upper * 0.8);
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  let delay = Math.floor(lower + (upper - lower) * jitter);
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const text = retryAfter.trim();
    const milliseconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000
      : /[A-Za-z]/.test(text) ? Date.parse(text) - nowMs : Number.NaN;
    if (Number.isFinite(milliseconds) && milliseconds > 0) delay = Math.max(delay, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(milliseconds)));
  }
  return { failures, failedAtMs: nowMs, retryAtMs: nowMs + delay };
}

export function isTemporaryHeartbeatFailure(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
