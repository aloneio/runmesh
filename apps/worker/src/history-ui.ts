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
  <label>History to load / 手动加载<select name="history">${[["jobs","Saved Jobs / 已保存任务"],["live","Live Jobs / Runner 当前任务"],["audit","MCP audit / 工具审计"],["all","Saved Jobs and audit / 已保存任务及审计"]].map(([v,label]) => `<option value="${v}"${v === view.scope ? " selected" : ""}>${label}</option>`).join("")}</select></label>
  <label>Latest records / 最近条数<select name="limit">${HISTORY_LIMITS.map((n) => `<option${n === view.limit ? " selected" : ""}>${n}</option>`).join("")}</select></label>
  <label>Workspace for live Jobs / 实时任务工作区<input name="workspace_id" value="${escape(view.workspace)}" maxlength="128"></label>
  <button class="button secondary">Load / Refresh · 加载 / 刷新</button>
  <p class="muted">No background polling. Only the selected history and record count are queried. 日志正文仅在明确点击后读取。</p></form>`;
}
export function historySettingsForm(runnerId: string, csrf: string, settings: JobHistorySettings | undefined): string {
  if (settings === undefined) return '<p class="muted">History settings unavailable. / 历史设置暂不可用。</p>';
  const option = (v: number, selected: number, label = String(v)) => `<option value="${v}"${v === selected ? " selected" : ""}>${label}</option>`;
  return `<section class="panel"><h2>Job history and retention / 任务记录与保留</h2>
  <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/history-settings" class="stack">
  <input type="hidden" name="csrf_token" value="${escape(csrf)}">
  <label>Cloud recording / 云端记录<select name="mode">${[["off","Disabled / 不上传"],["batched","Batched / 定时合并"],["immediate","Immediate / 立即上传（较高消耗）"]].map(([v,label]) => `<option value="${v}"${v === settings.mode ? " selected" : ""}>${label}</option>`).join("")}</select></label>
  <label>Upload interval / 上传间隔<select name="interval_seconds">${HISTORY_INTERVALS.map((n) => option(n,settings.interval_seconds,`${n/60} min`)).join("")}</select></label>
  <label>Cloud terminal history retention / 云端已结束任务保留天数<select name="retention_days">${HISTORY_DAYS.map((n) => option(n,settings.retention_days,`${n} days`)).join("")}</select></label>
  <label>Local terminal Jobs and logs / 本地已结束任务及日志<select name="local_retention_days">${option(0,settings.local_retention_days,"Existing count/size limits only / 仅现有数量与容量限制")}${HISTORY_DAYS.map((n) => option(n,settings.local_retention_days,`${n} days`)).join("")}</select></label>
  <label><input type="checkbox" name="confirm_local_cleanup" value="true">I approve deleting expired terminal local Job metadata and logs; this cannot be undone. / 我确认删除过期已结束任务的本地记录和日志，此操作不可恢复。</label>
  <button class="button secondary">Save history settings / 保存记录设置</button>
  <p class="muted">Running, queued, cancelling and uncertain recovered processes are never deleted. 本地清理默认不开启。支持批量同步的 Runner 在重新连接后应用设置；云端记录最多保留最近 500 个任务，既受天数限制也受数量限制。</p></form></section>`;
}
