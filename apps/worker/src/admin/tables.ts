import { message } from "../i18n/messages.js";
import type { ClientViewModel, RunnerSummaryViewModel } from "../contracts/admin-views.js";
import type { HistoryView } from "../history-ui.js";
import { adminJobUrl } from "./job-views.js";
import { escapeHtml, timeMarkup, statusClass } from "./format.js";

export function clientCredentialBadge(revoked: boolean, format: "full" | "compact" = "full"): string {
  const style = revoked ? "offline" : "online";
  const key = format === "compact" ? (revoked ? "text.revoked" : "client.credential.active.short") : (revoked ? "client.credential.revoked" : "client.credential.active");
  const label = message(key, "en");
  return '<span class="badge ' + style + (format === "compact" ? ' credential-badge' : '') + '"><span class="status-dot ' + style + '"></span>' + label + '</span>';
}

export function jobTable(jobs: readonly Record<string, unknown>[], runnerId?: string): string {
  if (jobs.length === 0) return '<p class="empty">No recent jobs.</p>';
  return `<div class="table-wrap"><table class="data-table job-table" aria-label="${message("text.recent.jobs", "en")}"><thead><tr><th scope="col">${message("text.job", "en")}</th><th scope="col">${message("text.workspace", "en")}</th><th scope="col">${message("text.mcp.client.2", "en")}</th><th scope="col">${message("text.status", "en")}</th><th scope="col">${message("text.updated", "en")}</th></tr></thead><tbody>${jobs.map((job) => {
    const status = String(job.status ?? "unknown");
    const safeStatus = statusClass(status);
    const clientId = typeof job.created_by_client_id === "string" && job.created_by_client_id.length > 0 ? job.created_by_client_id : "—";
    const href = adminJobUrl(job.runner_id ?? runnerId, job.job_id);
    const label = escapeHtml(String(job.job_id ?? "unknown"));
    const jobCell = href === undefined ? label : `<a href="${escapeHtml(href)}">${label}</a>`;
    return `<tr class="data-row"><td class="mono job-id-cell" data-no-i18n>${jobCell}</td><td><span class="workspace-pill" data-no-i18n>${escapeHtml(String(job.workspace_id ?? "unknown"))}</span></td><td class="mono font-12"><span data-no-i18n>${escapeHtml(clientId)}</span></td><td><span class="badge job-status ${safeStatus}"><span class="status-dot ${safeStatus}" aria-hidden="true"></span> ${escapeHtml(status)}</span></td><td class="time-cell">${timeMarkup(typeof job.updated_at_ms === "number" ? job.updated_at_ms : null)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export function mcpCallTable(calls: readonly Record<string, unknown>[]): string {
  if (calls.length === 0) return `<p class="empty">${message("text.no.mcp.calls.recorded.yet", "en")}</p>`;
  return `<div class="table-wrap"><table class="data-table mcp-call-table"><thead><tr><th scope="col">${message("text.method", "en")}</th><th scope="col">${message("text.mcp.client.2", "en")}</th><th scope="col">${message("text.workspace.job", "en")}</th><th scope="col">${message("text.status", "en")}</th><th scope="col">${message("text.duration", "en")}</th><th scope="col">${message("text.completed.2", "en")}</th></tr></thead><tbody>${calls.map((call) => {
    const status = call.status === "ok" ? "ok" : call.status === "error" ? "error" : "unknown";
    const safeStatus = status === "ok" ? "online" : status === "error" ? "offline" : "pending";
    const workspaceId = typeof call.workspace_id === "string" && call.workspace_id.length > 0 ? call.workspace_id : "—";
    const jobId = typeof call.job_id === "string" && call.job_id.length > 0 ? call.job_id : "—";
    const errorCode = typeof call.error_code === "string" && call.error_code.length > 0 ? call.error_code : "";
    const duration = typeof call.duration_ms === "number" && Number.isSafeInteger(call.duration_ms) && call.duration_ms >= 0 ? `${call.duration_ms} ms` : "—";
    return `<tr class="data-row"><td class="mono" data-no-i18n>${escapeHtml(String(call.method ?? "unknown"))}</td><td class="mono font-12" data-no-i18n>${escapeHtml(String(call.client_id ?? "unknown"))}</td><td><div class="activity-reference"><span class="workspace-pill"><span data-no-i18n>${escapeHtml(workspaceId)}</span></span><span class="mono font-12" data-no-i18n>${escapeHtml(jobId)}</span></div></td><td><div class="activity-reference"><span class="badge job-status ${safeStatus}"><span class="status-dot ${safeStatus}" aria-hidden="true"></span> ${escapeHtml(status)}</span>${errorCode ? `<span class="muted mono font-12" data-no-i18n>${escapeHtml(errorCode)}</span>` : ""}</div></td><td class="mono font-12">${escapeHtml(duration)}</td><td class="time-cell">${timeMarkup(typeof call.completed_at_ms === "number" ? call.completed_at_ms : null)}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export function statusBadge(state: string): string { const safe = ["online", "offline", "stale", "pending", "invalid"].includes(state) ? state : "offline"; return `<span class="badge ${safe}"><span class="status-dot ${safe}"></span>${safe}</span>`; }

export function safePlatform(runner: RunnerSummaryViewModel): string { return runner.public_info === null ? "Not enrolled" : `${runner.public_info.platform} / ${runner.public_info.architecture}`; }

export function runnerList(runners: readonly RunnerSummaryViewModel[]): string {
  if (runners.length === 0) return `<div class="empty-state-box resource-empty"><p class="empty">${message("text.no.runners.yet", "en")}</p><a class="button small secondary" href="/admin/runners">${message("text.add.runner", "en")}</a></div>`;
  return `<ul class="item-list">${runners.map((runner) => `<li><a href="/admin/runners/${encodeURIComponent(runner.runner_id)}" class="card-row"><div class="card-row-main"><span class="strong"><span data-no-i18n>${escapeHtml(runner.display_name)}</span></span><span class="card-row-sub"><span class="platform-meta">${escapeHtml(safePlatform(runner))}</span></span></div><div class="card-row-aside">${statusBadge(runner.state)}<span class="row-arrow" aria-hidden="true">→</span></div></a></li>`).join("")}</ul>`;
}

export function clientList(clients: readonly ClientViewModel[]): string {
  if (clients.length === 0) return `<div class="empty-state-box resource-empty"><p class="empty">${message("text.no.mcp.clients.yet", "en")}</p><a class="button small secondary" href="/admin/clients">${message("text.add.mcp.client", "en")}</a></div>`;
  return `<ul class="item-list">${clients.map((client) => `<li><a href="/admin/clients/${encodeURIComponent(client.client_id)}" class="card-row"><div class="card-row-main"><span class="strong"><span data-no-i18n>${escapeHtml(client.label)}</span></span><span class="card-row-sub"><span class="client-runner-meta">${client.active_runner_id === null ? message("text.not.selected", "en") : `<span data-no-i18n>${escapeHtml(client.active_runner_id)}</span>`}</span></span></div><div class="card-row-aside">${clientCredentialBadge(client.revoked_at_ms !== null)}<span class="row-arrow" aria-hidden="true">→</span></div></a><form class="hidden" method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input name="label" value="${escapeHtml(client.label)}"></form></li>`).join("")}</ul>`;
}

export function historyJobTable(jobs: Record<string,unknown>[], runnerId: string, view: HistoryView): string {
  const table = jobTable(jobs,runnerId);
  return view.scope === "live" ? table.replace(/(href="[^"?]+\/jobs\/[^"?]+)"/g,`$1?workspace_id=${encodeURIComponent(view.workspace ?? "")}"`) : table;
}
