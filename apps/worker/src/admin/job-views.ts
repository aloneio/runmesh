import { message } from "../i18n/messages.js";
import { isSafeIdentifier } from "../security.js";
import { timeMarkup } from "./format.js";

export const JOBS_EXPLANATION = "Command executions appear here. File reads, searches and edits appear in Recent MCP calls.";

export const JOBS_SNAPSHOT_NOTE = "Refresh this page to see the latest recorded status. Offline Runners show their last recorded status.";

export function jobSnapshotNote(): string {
  return `<div class="snapshot-note"><p class="muted font-12">${JOBS_SNAPSHOT_NOTE}</p><p class="snapshot-loaded muted font-12"><span>${message("text.last.loaded", "en")}</span> ${timeMarkup(Date.now())}</p></div>`;
}

export function adminJobUrl(runnerId: unknown, jobId: unknown): string | undefined {
  return typeof runnerId === "string" && isSafeIdentifier(runnerId) && typeof jobId === "string" && isSafeIdentifier(jobId)
    ? `/admin/runners/${encodeURIComponent(runnerId)}/jobs/${encodeURIComponent(jobId)}` : undefined;
}
