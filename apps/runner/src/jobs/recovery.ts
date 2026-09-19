import type { JobRecord, RecoveryLiveness } from "./records.js";

export function terminalRecoveredJob(job: JobRecord, status: "cancelled" | "interrupted", recovery_liveness: RecoveryLiveness): JobRecord {
  return {
    ...job,
    status,
    updated_at_ms: Date.now(),
    completed_at_ms: Date.now(),
    exit_code: null,
    signal: null,
    recovery_liveness,
    recovery_note: status === "cancelled"
      ? "cancellation delivery was confirmed after Runner restart; the process exit code is unavailable"
      : "terminal outcome unavailable after Runner restart",
    output_truncated: job.output_truncated,
    cancellation_delivered_at_ms: job.cancellation_delivered_at_ms,
    created_by_client_id: job.created_by_client_id,
    request_id: job.request_id ?? null,
    request_fingerprint: job.request_fingerprint ?? null,
  };
}
