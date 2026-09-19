import { PROTOCOL_CURRENT_VERSION, type WireMessage } from "@aloneio/runmesh-protocol";
import type { JobEvent } from "../jobs/records.js";

/** Pure legacy wire projection; the caller retains session and recording fences. */
export function jobEventMessage(event: JobEvent, runnerId: string): WireMessage | undefined {
    const job = { job_id: event.job.job_id, workspace_id: event.job.workspace_id, status: event.job.status, created_at_ms: event.job.created_at_ms, updated_at_ms: event.job.updated_at_ms, ...(event.job.created_by_client_id === null ? {} : { created_by_client_id: event.job.created_by_client_id }), ...(event.job.request_id === undefined || event.job.request_id === null ? {} : { request_id: event.job.request_id }), runner_id: runnerId } as const;
      if (event.type === "started") {
        return { type: "job.started", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job, workspace: { workspace_id: event.job.workspace_id, persistence: "persistent", labels: {} }, started_at_ms: event.job.started_at_ms ?? event.job.updated_at_ms };
      } else if (event.type === "completed" && (event.job.status === "succeeded" || event.job.status === "failed" || event.job.status === "cancelled")) {
        return { type: "job.completed", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job, completed_at_ms: event.job.completed_at_ms ?? event.job.updated_at_ms, outcome: event.job.status, exit_code: event.job.exit_code };
      } else if (event.type === "status") {
        return { type: "job.status", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: event.job.job_id, job };
      }
  return undefined;
}
