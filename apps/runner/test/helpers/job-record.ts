import type { JobRecord } from "../../src/jobs/records.js";
export function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    job_id: "job-00000000-0000-0000-0000-000000000001",
    workspace_id: "workspace-1",
    cwd: ".",
    command: ["test-command"],
    shell: false,
    status: "running",
    pid: 100,
    process_start_fingerprint: "1000",
    recovery_liveness: null,
    created_at_ms: 1,
    started_at_ms: 2,
    updated_at_ms: 3,
    completed_at_ms: null,
    exit_code: null,
    signal: null,
    recovery_note: null,
    output_truncated: false,
    created_by_client_id: null,
    cancellation_delivered_at_ms: null,
    ...overrides
  };
}
