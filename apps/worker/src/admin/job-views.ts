import { message } from "../i18n/messages.js";
import { isSafeIdentifier } from "../security.js";

export const JOBS_EXPLANATION = "Shell jobs are command executions, not all MCP calls. Read, search and edit operations appear in Recent MCP calls.";

export const JOBS_SNAPSHOT_NOTE = "Database snapshot; refreshed only when you open or refresh this page. Stored status may be stale while the Runner is offline.";

export function jobSnapshotNote(): string {
  const loadedAt = new Date().toISOString();
  return `<p class="muted font-12">${JOBS_SNAPSHOT_NOTE}</p><p class="muted font-12"><span>${message("text.last.loaded", "en")}</span>: <time datetime="${loadedAt}">${loadedAt}</time></p>`;
}

export function adminJobUrl(runnerId: unknown, jobId: unknown): string | undefined {
  return typeof runnerId === "string" && isSafeIdentifier(runnerId) && typeof jobId === "string" && isSafeIdentifier(jobId)
    ? `/admin/runners/${encodeURIComponent(runnerId)}/jobs/${encodeURIComponent(jobId)}` : undefined;
}
