export type AuthThrottleState = {
  readonly failed_attempts: number;
  readonly blocked_until_ms: number;
  readonly updated_at_ms: number;
};
export interface AuthThrottleStore {
  read(key: string): AuthThrottleState | undefined;
  write(key: string, state: AuthThrottleState): void;
}
export const AUTH_SOURCE_RETENTION_MS = 60 * 60_000;
export const MAX_AUTH_THROTTLE_KEYS = 2_048;
const GLOBAL_KDF_WINDOW_MS = 60_000;
const GLOBAL_KDF_ATTEMPTS = 120;

/** Additive upgrade for the existing v2 namespace; do not rewrite its tables. */
export function ensureAuthSourceThrottleSchema(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_source_throttle'").toArray().length > 0) return;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS auth_source_throttle (
      id TEXT PRIMARY KEY, failed_attempts INTEGER NOT NULL DEFAULT 0,
      blocked_until_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_auth_source_throttle_updated ON auth_source_throttle(updated_at_ms);
  `);
}

/** Call within one synchronous storage transaction; no raw source address is used. */
export function reserveSourceAuthAttempt(store: AuthThrottleStore, kind: "login" | "setup", sourceHash: string, nowMs: number): { allowed: boolean; retry_after_ms: number } {
  const sourceKey = `${kind}:${sourceHash}`; const globalKey = `${kind}:global`;
  const source = store.read(sourceKey);
  if (source !== undefined && source.blocked_until_ms > nowMs) return { allowed: false, retry_after_ms: source.blocked_until_ms - nowMs };
  const priorGlobal = store.read(globalKey);
  const activeGlobal = priorGlobal !== undefined && priorGlobal.blocked_until_ms > nowMs ? priorGlobal : undefined;
  if (activeGlobal !== undefined && activeGlobal.failed_attempts >= GLOBAL_KDF_ATTEMPTS) return { allowed: false, retry_after_ms: activeGlobal.blocked_until_ms - nowMs };
  const attempts = (source?.failed_attempts ?? 0) + 1;
  const delay = attempts < 5 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts - 5, 30));
  store.write(sourceKey, { failed_attempts: attempts, blocked_until_ms: delay === 0 ? 0 : nowMs + delay, updated_at_ms: nowMs });
  store.write(globalKey, { failed_attempts: (activeGlobal?.failed_attempts ?? 0) + 1, blocked_until_ms: activeGlobal?.blocked_until_ms ?? nowMs + GLOBAL_KDF_WINDOW_MS, updated_at_ms: nowMs });
  return { allowed: true, retry_after_ms: 0 };
}
