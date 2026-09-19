import { copyNullableTimestamp } from "./primitives.js";
import { copyRequiredTimestamp } from "./primitives.js";
import { isRecord } from "./primitives.js";
import { isSafeCursor } from "./primitives.js";
import { isSafeExitCode } from "./primitives.js";
import { isSafeNonnegativeInteger } from "./primitives.js";
import { projectBytePageMetadata } from "../byte-pages.js";
import { safeJobIdentifier } from "./primitives.js";
import { safeJobStatus } from "./primitives.js";
import { safeRunnerContext } from "./selection.js";
import { safeSignal } from "./primitives.js";

/**
 * Project only the stable, non-sensitive Job metadata contract exposed by
 * MCP.  Runner JobRecord objects also carry command/cwd/PID/process identity
 * fields that must never cross the MCP boundary.
 */
export function safeJobMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  // The allow-list is only the first boundary.  Runner records normally have
  // already passed their local schema, but Registry snapshots and old peers
  // are untrusted at this layer too.  Copy scalar values only; otherwise a
  // hostile object such as `{ job_id: { cwd: ... } }` could survive the key
  // filter and become an arbitrary nested MCP response.
  const jobId = safeJobIdentifier(value.job_id);
  if (jobId !== undefined) output.job_id = jobId;
  const workspaceId = safeJobIdentifier(value.workspace_id);
  if (workspaceId !== undefined) output.workspace_id = workspaceId;
  // Keep the originating MCP client attribution in the public job metadata.
  // It is a bounded identifier, and lets callers correlate shared jobs after
  // the original MCP request has completed.
  const createdByClientId = safeJobIdentifier(value.created_by_client_id);
  if (createdByClientId !== undefined) output.created_by_client_id = createdByClientId;
  const requestId = safeJobIdentifier(value.request_id);
  if (requestId !== undefined) output.request_id = requestId;
  if (typeof value.status === "string") output.status = safeJobStatus(value.status);
  copyRequiredTimestamp(value, output, "created_at_ms");
  copyNullableTimestamp(value, output, "started_at_ms");
  copyRequiredTimestamp(value, output, "updated_at_ms");
  copyNullableTimestamp(value, output, "completed_at_ms");
  const exitCode = value.exit_code;
  if (exitCode === null || isSafeExitCode(exitCode)) output.exit_code = exitCode;
  const signal = safeSignal(value.signal);
  if (signal !== undefined) output.signal = signal;
  // Recovery notes are Runner-authored free text and can contain raw process
  // errors, filesystem paths, or credential-adjacent details.  They are useful
  // to the authenticated administrator surface, but are intentionally not a
  // part of the public MCP Job contract; exposing a bounded string is still
  // an information leak, so omit it rather than attempting ad-hoc filtering.
  if (typeof value.output_truncated === "boolean") output.output_truncated = value.output_truncated;
  copyNullableTimestamp(value, output, "cancellation_delivered_at_ms");
  return output;
}

/**
 * Project the bounded log envelope returned by `job.logs`. Log `data` is
 * intentionally retained (it is the content the caller requested), while
 * arbitrary future fields—including a nested JobRecord—are discarded.
 */
export function safeJobLogResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const jobId = safeJobIdentifier(value.job_id);
  if (jobId !== undefined) output.job_id = jobId;
  if (value.stream === "stdout" || value.stream === "stderr") output.stream = value.stream;
  if (value.available === false && isRecord(value.error) && value.error.code === "log_unavailable") return { ...output, available: false, error: { code: "log_unavailable" } };
  if (typeof value.data === "string") output.data = value.data.slice(0, 65_536);
  if (isSafeNonnegativeInteger(value.offset)) output.offset = value.offset;
  if (value.next_cursor === null || isSafeCursor(value.next_cursor)) output.next_cursor = value.next_cursor;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
  if (isSafeNonnegativeInteger(value.size)) output.size = value.size;
  projectBytePageMetadata(value, output, "log");
  if (typeof value.source_truncated === "boolean") output.source_truncated = value.source_truncated;
  return output;
}

/** Project the acknowledgement returned by `job.input`; no JobRecord fields belong here. */
export function safeJobInputResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  if (isSafeNonnegativeInteger(value.accepted)) output.accepted = value.accepted;
  if (typeof value.eof === "boolean") output.eof = value.eof;
  return output;
}

/** Project the `exec.run` response, including its nested job and log envelopes. */
export function safeShellResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const job = isRecord(value.job) ? value.job : value;
  Object.assign(output, safeJobMetadata(job));
  if (typeof value.completed === "boolean") output.completed = value.completed;
  if (isRecord(value.queue)) {
    const info: Record<string,unknown> = {};
    for (const key of ["waiting","limit","per_client_limit","running"]) if (isSafeNonnegativeInteger(value.queue[key]) && (value.queue[key] as number)<=1000) info[key]=value.queue[key];
    output.queue=info;
  }
  if (isSafeNonnegativeInteger(value.wait_cap_ms)) output.wait_cap_ms = value.wait_cap_ms;
  if (value.stdout !== undefined) output.stdout = safeJobLogResult(value.stdout);
  if (value.stderr !== undefined) output.stderr = safeJobLogResult(value.stderr);
  if (value.runner_context !== undefined) output.runner_context = safeRunnerContext(value.runner_context);
  // A status is required by the shell contract even when an old/malformed
  // Runner omitted it. Normalize arbitrary strings to the stable enum so a
  // hostile RPC result cannot smuggle an unbounded status value downstream.
  if (Object.prototype.hasOwnProperty.call(output, "status")) output.status = safeJobStatus(output.status);
  return output;
}

/** Check an RPC job envelope against the Registry-authorized job/workspace pair. */
export function runnerJobResultMatches(value: unknown, jobId: string, workspaceId: string): boolean {
  if (!isRecord(value)) return false;
  const nested = isRecord(value.job) ? value.job : value;
  const returnedJobId = nested.job_id;
  if (returnedJobId !== undefined && returnedJobId !== jobId) return false;
  const returnedWorkspaceId = nested.workspace_id;
  if (returnedWorkspaceId !== undefined && returnedWorkspaceId !== workspaceId) return false;
  return true;
}
