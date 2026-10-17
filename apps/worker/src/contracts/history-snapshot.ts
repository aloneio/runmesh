import { JobMetadataSchema, type JobMetadata } from "@aloneio/runmesh-protocol";
import { z } from "zod";

export const HISTORY_MAX_JOBS = 500;
export const HISTORY_MAX_BYTES = 768 * 1024;
export const HISTORY_DAY_MS = 86_400_000;
export const HISTORY_QUARANTINE_MAX_DAYS = 7;
export class JobHistoryUnavailableError extends Error {
  public constructor() { super("Job history is unavailable; use workspace-bound live queries."); }
}
export type HistoryCorruptionReason = "invalid_json" | "invalid_shape" | "invalid_job" | "identity_mismatch" | "oversized" | "invalid_metadata" | "expired";
export class HistorySnapshotCorruptError extends JobHistoryUnavailableError {
  public constructor(public readonly reason: HistoryCorruptionReason) { super(); }
}
export class HistoryInputError extends JobHistoryUnavailableError {}
export class HistoryConflictError extends JobHistoryUnavailableError {}

// Persisted timestamps predate wire-range restrictions. Keep them readable;
// never silently discard neighboring Jobs during schema validation.
const timestamp = z.number().int().nonnegative();
const storedJob = JobMetadataSchema.extend({ created_at_ms: timestamp, updated_at_ms: timestamp });

/** Pure bounded parser. It does not choose a dependency circuit or write data. */
export function decodeHistorySnapshot(body: string, runnerId?: string): JobMetadata[] {
  if (new TextEncoder().encode(body).byteLength > HISTORY_MAX_BYTES) throw new HistorySnapshotCorruptError("oversized");
  let values: unknown;
  try { values = JSON.parse(body); }
  catch { throw new HistorySnapshotCorruptError("invalid_json"); }
  if (!Array.isArray(values)) throw new HistorySnapshotCorruptError("invalid_shape");
  if (values.length > HISTORY_MAX_JOBS) throw new HistorySnapshotCorruptError("oversized");
  const ids = new Set<string>();
  return values.map(value => {
    const parsed = storedJob.safeParse(value);
    if (!parsed.success) throw new HistorySnapshotCorruptError("invalid_job");
    const job = parsed.data;
    if (ids.has(job.job_id) || (runnerId !== undefined && job.runner_id !== undefined && job.runner_id !== runnerId))
      throw new HistorySnapshotCorruptError("identity_mismatch");
    ids.add(job.job_id);
    return job;
  });
}
