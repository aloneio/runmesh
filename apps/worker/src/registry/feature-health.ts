import type { RegistryFeatureKey, RegistryFeatureHealth, FeatureHealthRow } from "./records.js";
import type { RegistryStorage } from "./storage.js";
import { summarizeFeatureError } from "./feature-health-model.js";

/** Owns optional feature state only. Construction never reads/writes storage.
 * Alarm scheduling and cross-domain transactions remain in RegistryDO. */
export class RegistryFeatureHealthStore {
  private readonly states = new Map<RegistryFeatureKey, { readonly disabled_until_ms: number | null; readonly failure_count: number; readonly last_failure_at_ms: number | null; readonly last_error: string | null }>();
  public constructor(private readonly sql: RegistryStorage["sql"]) {}

  public load(nowMs = Date.now()): void {
    try {
      for (const row of this.sql.exec<FeatureHealthRow>("SELECT feature, disabled_until_ms, failure_count, last_failure_at_ms, last_error FROM feature_health").toArray()) {
        if (row.disabled_until_ms === null) continue;
        if (row.disabled_until_ms <= nowMs) continue;
        this.states.set(row.feature, row);
      }
    } catch { /* optional feature state must never make the Registry unavailable */ }
  }

  public snapshot(nowMs = Date.now()): RegistryFeatureHealth[] {
    const states: RegistryFeatureHealth[] = [];
    for (const [feature, state] of this.states.entries()) {
      if (state.disabled_until_ms !== null && state.disabled_until_ms <= nowMs) {
        this.states.delete(feature);
        continue;
      }
      states.push({ feature, ...state });
    }
    return states;
  }

  public clear(feature: RegistryFeatureKey): void {
    if (!this.states.delete(feature)) return;
    try { this.sql.exec("DELETE FROM feature_health WHERE feature = ?", feature); } catch { /* feature state cleanup is best-effort */ }
  }

  public disable(feature: RegistryFeatureKey, error: unknown, nowMs = Date.now(), cooldownMs = 15 * 60_000): number {
    const previous = this.states.get(feature);
    const failure_count = (previous?.failure_count ?? 0) + 1;
    const last_error = summarizeFeatureError(error);
    const disabled_until_ms = nowMs + cooldownMs;
    const state = {
      disabled_until_ms,
      failure_count,
      last_failure_at_ms: nowMs,
      last_error,
    };
    this.states.set(feature, state);
    try {
      this.sql.exec(
        `INSERT INTO feature_health (feature, disabled_until_ms, failure_count, last_failure_at_ms, last_error, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET disabled_until_ms = excluded.disabled_until_ms, failure_count = excluded.failure_count,
         last_failure_at_ms = excluded.last_failure_at_ms, last_error = excluded.last_error, updated_at_ms = excluded.updated_at_ms`,
        feature, state.disabled_until_ms, state.failure_count, state.last_failure_at_ms, state.last_error, nowMs,
      );
    } catch { /* in-memory breaker still prevents repeated optional writes in this DO instance */ }
    return disabled_until_ms;
  }

  public disabled(feature: RegistryFeatureKey, nowMs = Date.now()): boolean {
    const state = this.states.get(feature);
    if (state === undefined) return false;
    if (state.disabled_until_ms !== null && state.disabled_until_ms <= nowMs) {
      this.states.delete(feature);
      return false;
    }
    return state.disabled_until_ms !== null && state.disabled_until_ms > nowMs;
  }

}
