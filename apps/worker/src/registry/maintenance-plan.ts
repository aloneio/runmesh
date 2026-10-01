import { safeNonnegativeInteger } from "./values.js";

/** Pure planning only; SQL reads, cleanup writes and alarms stay with the DO. */
export function historyCleanupDue(next: unknown, nowMs: number, intervalMs: number): boolean {
  return !safeNonnegativeInteger(next) || next <= nowMs || next > nowMs + intervalMs;
}
export function nextHistoryCleanupDeadline(nowMs: number, nextExpiry: unknown, nextSweep: unknown, intervalMs: number): number | null {
  if (!safeNonnegativeInteger(nextExpiry)) return null;
  return Math.max(nextExpiry, historyCleanupDue(nextSweep, nowMs, intervalMs) ? nowMs : nextSweep as number);
}
export function nextMaintenanceDeadline(nowMs: number, nextStale: unknown, nextAudit: unknown, nextHistory?: unknown): number | null {
  const deadlines = [nextStale, nextAudit, nextHistory].filter((n): n is number => safeNonnegativeInteger(n));
  return deadlines.length === 0 ? null : Math.max(nowMs + 1_000, Math.min(...deadlines));
}
