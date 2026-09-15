export type LocalJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed" | "unknown" | "interrupted";

export interface RecoveryLiveness {
  readonly checked_at_ms: number;
  readonly alive: boolean;
  /** `null` means the platform could not safely compare a process-start fingerprint. */
  readonly fingerprint_matches: boolean | null;
}

export interface JobRecord {
  readonly job_id: string;
  readonly workspace_id: string;
  readonly cwd: string;
  readonly command: readonly string[];
  readonly shell: boolean;
  readonly status: LocalJobStatus;
  readonly pid: number | null;
  /** Linux /proc process starttime, when the host exposes it. */
  readonly process_start_fingerprint: string | null;
  /** One recovery-time liveness observation; it is not a claim that a job completed. */
  readonly recovery_liveness: RecoveryLiveness | null;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly updated_at_ms: number;
  readonly completed_at_ms: number | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  /** Recovery explanation safe to expose to MCP clients. */
  readonly recovery_note: string | null;
  /** True when the persisted output cap discarded one or more bytes. */
  readonly output_truncated: boolean;
  /** MCP client identity that initiated the job; it does not grant ownership. */
  readonly created_by_client_id: string | null;
  /** Optional caller-supplied idempotency key. It is metadata, never authorization. */
  readonly request_id?: string | null;
  /** Local-only hash binding request_id to the normalized launch input. */
  readonly request_fingerprint?: string | null;
  /** Persisted evidence that this Runner delivered a cancellation request. */
  readonly cancellation_delivered_at_ms: number | null;
}

export type JobEvent = { readonly type: "started" | "output" | "status" | "completed"; readonly job: JobRecord; readonly stream?: "stdout" | "stderr"; readonly data?: string };

export function isJobStatus(value: unknown): value is LocalJobStatus { return typeof value === "string" && ["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"].includes(value); }

export function isActive(job: JobRecord): boolean { return job.status === "queued" || job.status === "running" || job.status === "cancelling"; }

/** Immutable local-child identity used when merging a newer active snapshot. */
export function sameJobProcessIdentity(left: JobRecord, right: JobRecord): boolean {
  return left.job_id === right.job_id
    && left.pid === right.pid
    && left.process_start_fingerprint === right.process_start_fingerprint
    && left.started_at_ms === right.started_at_ms;
}

/** Unknown is a recovered live-process state and must occupy a start slot. */
export function occupiesProcessSlot(job: JobRecord): boolean { return isActive(job) || job.status === "unknown"; }

export function safeJobId(value: string): boolean { return /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value); }

export function normalizeJobRecord(value: unknown, expectedJobId?: string): JobRecord | undefined {
  if (!isRecord(value)) return undefined;
  const item = value as Record<string, unknown>;
  const jobId = item.job_id;
  if (typeof jobId !== "string" || !safeJobId(jobId) || (expectedJobId !== undefined && jobId !== expectedJobId)) return undefined;
  const workspaceId = item.workspace_id;
  if (typeof workspaceId !== "string" || !safeIdentifier(workspaceId)) return undefined;
  const cwd = item.cwd;
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4_096 || cwd.includes("\0") || isAbsoluteJobPath(cwd) || cwd.split(/[\\/]+/u).includes("..")) return undefined;
  const command = item.command;
  if (!Array.isArray(command) || command.length === 0 || command.length > 256 || command.some((part) => typeof part !== "string" || part.length > 8_192 || part.includes("\0"))) return undefined;
  if (typeof item.shell !== "boolean" || !isJobStatus(item.status)) return undefined;
  // These nullable fields predate the recovery metadata additions and may be
  // absent in a persisted record from an older Runner.  Treat omission as the
  // same value as an explicit null, while still rejecting malformed values
  // when a field is present.
  const pid = item.pid;
  if (pid !== undefined && pid !== null && (!Number.isSafeInteger(pid) || (pid as number) <= 0)) return undefined;
  const created = safeTimestamp(item.created_at_ms);
  const updated = safeTimestamp(item.updated_at_ms);
  if (created === undefined || updated === undefined) return undefined;
  const started = nullableTimestamp(item.started_at_ms);
  const completed = nullableTimestamp(item.completed_at_ms);
  if (started === undefined || completed === undefined) return undefined;
  const exitCode = item.exit_code;
  if (exitCode !== undefined && exitCode !== null && (!Number.isSafeInteger(exitCode) || Math.abs(exitCode as number) > 2 ** 31)) return undefined;
  const signal = item.signal;
  if (signal !== undefined && signal !== null && (typeof signal !== "string" || signal.length > 64 || /[\u0000-\u001f\u007f]/u.test(signal))) return undefined;
  const fingerprint = item.process_start_fingerprint;
  const normalizedFingerprint = typeof fingerprint === "string" && fingerprint.length <= 128 && /^\d+$/u.test(fingerprint) ? fingerprint : null;
  const recovery = item.recovery_liveness;
  const normalizedRecovery = validRecoveryLiveness(recovery) ? recovery : null;
  const deliveredValue = item.cancellation_delivered_at_ms;
  const delivered = deliveredValue === undefined || deliveredValue === null ? null : safeTimestamp(deliveredValue) ?? null;
  const client = item.created_by_client_id;
  const normalizedClient = typeof client === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(client) ? client : null;
  const requestId = item.request_id;
  const normalizedRequestId = typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId) ? requestId : null;
  const requestFingerprint = item.request_fingerprint;
  const normalizedRequestFingerprint = normalizedRequestId !== null && typeof requestFingerprint === "string" && /^[a-f0-9]{64}$/u.test(requestFingerprint) ? requestFingerprint : null;
  const note = item.recovery_note;
  const normalizedNote = typeof note === "string" && note.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(note) ? note : null;
  // Treat an absent or malformed marker as false. This avoids claiming that
  // output was truncated based on a truthy, non-boolean value in corrupt
  // metadata while preserving the record itself for recovery.
  const outputTruncated = typeof item.output_truncated === "boolean" ? item.output_truncated : false;
  return {
    job_id: jobId,
    workspace_id: workspaceId,
    cwd,
    command: [...command] as string[],
    shell: item.shell,
    status: item.status,
    pid: pid === undefined ? null : pid as number | null,
    process_start_fingerprint: normalizedFingerprint,
    recovery_liveness: normalizedRecovery,
    created_at_ms: created,
    started_at_ms: started,
    updated_at_ms: updated,
    completed_at_ms: completed,
    exit_code: exitCode === undefined ? null : exitCode as number | null,
    signal: signal === undefined ? null : signal as string | null,
    recovery_note: normalizedNote,
    output_truncated: outputTruncated,
    created_by_client_id: normalizedClient,
    request_id: normalizedRequestFingerprint === null ? null : normalizedRequestId,
    request_fingerprint: normalizedRequestFingerprint,
    cancellation_delivered_at_ms: delivered,
  };
}

export function validRecoveryLiveness(value: unknown): value is RecoveryLiveness {
  if (!isRecord(value)) return false;
  const item = value as Record<string, unknown>;
  return safeTimestamp(item.checked_at_ms) !== undefined && typeof item.alive === "boolean" && (item.fingerprint_matches === null || typeof item.fingerprint_matches === "boolean");
}

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function safeIdentifier(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }

export function safeTimestamp(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }

export function nullableTimestamp(value: unknown): number | null | undefined { return value === null || value === undefined ? null : safeTimestamp(value) ?? undefined; }

export function isAbsoluteJobPath(value: string): boolean { return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"); }
