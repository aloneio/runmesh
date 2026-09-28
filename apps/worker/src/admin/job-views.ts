import { message } from "../i18n/messages.js";
import { isSafeIdentifier } from "../security.js";

export const JOBS_EXPLANATION = "Command executions appear here. File reads, searches and edits appear in Recent MCP calls.";

export const JOBS_SNAPSHOT_NOTE = "Refresh this page to see the latest recorded status. Offline Runners show their last recorded status.";

export function jobSnapshotNote(): string {
  const loadedAt = new Date().toISOString();
  return `<p class="muted font-12">${JOBS_SNAPSHOT_NOTE}</p><p class="muted font-12"><span>${message("text.last.loaded", "en")}</span>: <time datetime="${loadedAt}">${loadedAt}</time></p>`;
}

export function adminJobUrl(runnerId: unknown, jobId: unknown): string | undefined {
  return typeof runnerId === "string" && isSafeIdentifier(runnerId) && typeof jobId === "string" && isSafeIdentifier(jobId)
    ? `/admin/runners/${encodeURIComponent(runnerId)}/jobs/${encodeURIComponent(jobId)}` : undefined;
}
