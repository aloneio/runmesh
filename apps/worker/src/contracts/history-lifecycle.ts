import { IdentifierSchema } from "@aloneio/runmesh-protocol";

export const HISTORY_LIFECYCLE_BATCH_SIZE = 20;
/** A complete, authoritative point-in-time snapshot. Omitted IDs are not absences. */
export type HistoryLifecycleReader = (runnerIds: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;

export function validHistoryRunnerIds(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.length <= HISTORY_LIFECYCLE_BATCH_SIZE
    && new Set(ids).size === ids.length && ids.every(id => IdentifierSchema.safeParse(id).success);
}

export function parseHistoryLifecycles(value: unknown, runnerIds: readonly string[]): ReadonlyMap<string, string | null> | undefined {
  if (!Array.isArray(value) || value.length !== runnerIds.length || !validHistoryRunnerIds(runnerIds)) return undefined;
  const result = new Map<string, string | null>();
  for (const row of value) {
    if (typeof row !== "object" || row === null || Array.isArray(row)
      || !runnerIds.includes(row.runner_id) || result.has(row.runner_id)
      || (row.lifecycle_id !== null && (typeof row.lifecycle_id !== "string" || row.lifecycle_id.length < 16
        || row.lifecycle_id.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(row.lifecycle_id)))) return undefined;
    result.set(row.runner_id, row.lifecycle_id);
  }
  return result;
}
