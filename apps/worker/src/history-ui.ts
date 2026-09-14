import { HISTORY_DAYS, HISTORY_INTERVALS, HISTORY_LIMITS, type JobHistorySettings } from "./job-history-settings.js";
export type HistoryView = { scope: "none" | "jobs" | "live" | "audit" | "all"; limit: number; workspace?: string };
export function historyView(url: URL): HistoryView | undefined {
  for (const k of ["history","limit","workspace_id"]) if (url.searchParams.getAll(k).length > 1) return undefined;
  const scope = url.searchParams.get("history") ?? "none";
  const rawLimit = url.searchParams.get("limit") ?? "10";
  const workspace = url.searchParams.get("workspace_id") || undefined;
  if (!["none","jobs","live","audit","all"].includes(scope) || !/^[0-9]+$/.test(rawLimit) || !HISTORY_LIMITS.some((n) => n === Number(rawLimit))) return undefined;
  if (workspace !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspace)) return undefined;
  if (scope === "live" && workspace === undefined) return undefined;
  return {scope:scope as HistoryView["scope"],limit:Number(rawLimit),...(workspace === undefined ? {} : {workspace})};
}
const escape = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g,(c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
export function historyControls(runnerId: string, view: HistoryView): string {
  return `<form method="get" action="/admin/runners/${encodeURIComponent(runnerId)}" class="scope-editor-form">
  <label>History to load<select name="history">${[["jobs","Saved Jobs"],["live","Live Jobs"],["audit","MCP audit"],["all","Saved Jobs and audit"]].map(([v,label]) => `<option value="${v}"${v === view.scope ? " selected" : ""}>${label}</option>`).join("")}</select></label>
  <label>Latest records<select name="limit">${HISTORY_LIMITS.map((n) => `<option${n === view.limit ? " selected" : ""}>${n}</option>`).join("")}</select></label>
  <label>Workspace for live Jobs<input name="workspace_id" value="${escape(view.workspace)}" maxlength="128"></label>
  <button class="button secondary">Load / Refresh</button>
  <p class="muted">No background polling. Only the selected history and record count are queried. Log content is read only on explicit request.</p></form>`;
}
export function historySettingsForm(runnerId: string, csrf: string, settings: JobHistorySettings | undefined): string {
  if (settings === undefined) return '<p class="muted">History settings unavailable.</p>';
  const option = (v: number, selected: number, label = String(v)) => `<option value="${v}"${v === selected ? " selected" : ""}>${label}</option>`;
  return `<section class="panel"><h2>Job history and retention</h2>
  <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/history-settings" class="stack">
  <input type="hidden" name="csrf_token" value="${escape(csrf)}">
  <label>Cloud recording<select name="mode">${[["off","Disabled"],["batched","Batched"],["immediate","Immediate (higher usage)"]].map(([v,label]) => `<option value="${v}"${v === settings.mode ? " selected" : ""}>${label}</option>`).join("")}</select></label>
  <label>Upload interval<select name="interval_seconds">${HISTORY_INTERVALS.map((n) => option(n,settings.interval_seconds,`${n/60} min`)).join("")}</select></label>
  <label>Cloud terminal history retention<select name="retention_days">${HISTORY_DAYS.map((n) => option(n,settings.retention_days,`${n} days`)).join("")}</select></label>
  <label>Local terminal Jobs and logs<select name="local_retention_days">${option(0,settings.local_retention_days,"Existing count/size limits only")}${HISTORY_DAYS.map((n) => option(n,settings.local_retention_days,`${n} days`)).join("")}</select></label>
  <label><input type="checkbox" name="confirm_local_cleanup" value="true">I approve deleting expired terminal local Job metadata and logs; this cannot be undone.</label>
  <button class="button secondary">Save history settings</button>
  <p class="muted">Running, queued, cancelling and uncertain recovered processes are never deleted. Local cleanup is disabled by default. Compatible Runners apply settings on reconnect. Cloud history keeps at most 500 recent jobs, subject to both age and count limits.</p></form></section>`;
}
