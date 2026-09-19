import { message } from "../i18n/messages.js";
import type { ClientViewModel, RunnerSummaryViewModel } from "../contracts/admin-views.js";
import type { AdminData } from "./view-models.js";
import { record, escapeHtml, time, displayScopeLabel } from "./format.js";
import { permissionSelect, scopeCheckboxes } from "./forms.js";
import { statusBadge } from "./tables.js";

export function clientDetailPage(client: Record<string, unknown>, runners: readonly RunnerSummaryViewModel[], overrides: readonly Record<string, unknown>[], csrf: string): string {
  const clientId = typeof client.client_id === "string" ? client.client_id : "unknown";
  const label = typeof client.label === "string" ? client.label : clientId;
  const isRevoked = client.revoked_at_ms !== null;
  const overrideRows = runners.map((runner) => {
    const override = overrides.find((item) => item.runner_id === runner.runner_id);
    const permissions = record(override?.permissions);
    const isCustom = override !== undefined;
    return `<tr class="data-row">
      <td>
        <div class="table-primary-cell">
          <span class="strong"><span data-no-i18n>${escapeHtml(runner.display_name)}</span></span>
          <span class="sub-id mono" data-no-i18n>${escapeHtml(runner.runner_id)}</span>
        </div>
      </td>
      <td>
        <span class="mode-pill ${isCustom ? "custom" : "global"}">${isCustom ? "Additional restriction" : "Use global"}</span>
      </td>
      <td colspan="4">
        <form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/${override === undefined ? "override" : "override"}" class="override-form-row">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
          <input type="hidden" name="runner_id" value="${escapeHtml(runner.runner_id)}">
          <div class="perm-selects-wrap">
            ${permissionSelect("read", permissions?.read === true)}
            ${permissionSelect("edit", permissions?.edit === true)}
            ${permissionSelect("shell", permissions?.shell === true)}
            ${permissionSelect("job_control", permissions?.job_control === true)}
          </div>
          <div class="override-actions">
            <button class="small secondary">${message("text.save.restriction", "en")}</button>
            ${override === undefined ? "" : `<button class="small danger" formaction="/admin/clients/${encodeURIComponent(clientId)}/reset-override">${message("text.reset", "en")}</button>`}
          </div>
        </form>
      </td>
    </tr>`;
  }).join("");
  const scopeValues = Array.isArray(client.scopes) ? client.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const scopeEditor = `<form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/scopes" class="scope-editor-form">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <fieldset class="scope-fieldset">
      <legend>${message("text.base.scopes", "en")}</legend>
      <div class="scope-selector-row">
        ${scopeCheckboxes(scopeValues)}
      </div>
    </fieldset>
    <div class="form-submit-wrap">
      <button class="button secondary">${message("text.save.scopes", "en")}</button>
    </div>
  </form>`;
  return `<section class="detail-header">
    <div class="detail-title-group">
      <div class="detail-title-row">
        <p class="eyebrow">${message("text.mcp.client.detail", "en")}</p>
        <h1 class="detail-title" data-no-i18n>${escapeHtml(label)}</h1>
        ${statusBadge(isRevoked ? "offline" : "online")}
      </div>
      <p class="detail-id mono"><span data-no-i18n>${escapeHtml(clientId)}</span></p>
      <p class="lede">${message("text.runner.specific.access.can.only.further.restrict.the.client.s.global.scopes.it.can.never.g", "en")}</p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/clients">${message("text.back.to.clients", "en")}</a>
    </div>
  </section>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.global.permissions", "en")}</h2>
      </div>
      <div class="active-scopes-box">
        <span class="form-stat-label">${message("text.effective.global.scopes", "en")}</span>
        <p class="muted scope-line">${escapeHtml(scopeValues.map(displayScopeLabel).join(", "))}</p>
      </div>
      <p class="muted scope-help">${message("text.each.base.scope.has.a.distinct.ceiling", "en")}<span class="mono">${message("text.read.2", "en")}</span>${message("text.permits.inspection", "en")}<span class="mono">${message("text.write", "en")}</span>${message("text.permits.approved.edits.and", "en")}<span class="mono">${message("text.exec", "en")}</span>${message("text.permits.host.shell.and.job.control.runner.and.workspace.policy.can.only.reduce.these.permi", "en")}</p>
      ${scopeEditor}
      <form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/recording" class="scope-editor-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <label for="record-jobs">${message("text.cloud.job.history", "en")}</label>
        <select id="record-jobs" name="record_jobs">
          <option value="true"${client.record_jobs !== false ? " selected" : ""}>${message("text.record.new.jobs", "en")}</option>
          <option value="false"${client.record_jobs === false ? " selected" : ""}>${message("text.do.not.record.new.jobs", "en")}</option>
        </select>
        <p class="muted">${message("text.when.disabled.new.job.snapshots.and.job.tool.audit.entries.are.not.stored.in.the.cloud.loc", "en")}</p>
        <button class="button secondary">${message("text.save.recording.preference", "en")}</button>
      </form>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Client Routing &amp; Status</h2>
      </div>
      <dl class="details">
        <dt>${message("text.client.id", "en")}</dt>
        <dd class="mono"><span data-no-i18n>${escapeHtml(clientId)}</span></dd>
        <dt>${message("text.active.runner.2", "en")}</dt>
        <dd>${activeRunnerSelector(client as unknown as ClientViewModel, runners, csrf)}</dd>
        <dt>${message("text.last.used.2", "en")}</dt>
        <dd class="time-cell">${escapeHtml(time(typeof client.last_used_at_ms === "number" ? client.last_used_at_ms : null))}</dd>
        <dt>${message("text.status", "en")}</dt>
        <dd>${isRevoked ? "Revoked" : "Active"}</dd>
      </dl>
    </section>
  </div>
  <section class="panel">
    <div class="section-title">
      <h2>${message("text.client.access.on.each.runner", "en")}</h2>
      <span class="muted font-12">${message("text.use.global.means.no.additional.restriction.effective.access.is.still.limited.by.runner.and", "en")}</span>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Runner</th>
            <th>${message("text.mode", "en")}</th>
            <th colspan="4">${message("text.additional.restriction", "en")}</th>
          </tr>
        </thead>
        <tbody>${overrideRows || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>${message("text.no.runners.registered", "en")}</p></div></td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

export function activeRunnerLabel(client: ClientViewModel, runners: readonly RunnerSummaryViewModel[]): string { const runner = client.active_runner_id === null ? undefined : runners.find((item) => item.runner_id === client.active_runner_id); return runner === undefined ? "Not selected" : runner.display_name; }

export function activeRunnerSelector(client: ClientViewModel, runners: readonly RunnerSummaryViewModel[], csrf: string): string {
  const current = activeRunnerLabel(client, runners);
  if (runners.length === 0) return `<span class="routing-badge">${escapeHtml(current)}</span><span class="muted"> · No runners available</span>`;
  const options = runners.map((runner) => `<option data-no-i18n value="${escapeHtml(runner.runner_id)}"${client.active_runner_id === runner.runner_id ? " selected" : ""}>${escapeHtml(runner.display_name)} (${escapeHtml(runner.runner_id)})</option>`).join("");
  const reset = client.active_runner_id === null ? "" : `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger" type="submit">${message("text.reset", "en")}</button></form>`;
  return `<div class="runner-selection-controls"><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/active-runner" class="runner-selection-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><select name="runner_id" aria-label="Active Runner"><option value="" disabled${client.active_runner_id === null ? " selected" : ""}>${message("text.choose.a.runner", "en")}</option>${options}</select><label class="check"><input type="checkbox" name="confirm_switch" value="true"><span>${message("text.confirm.switch", "en")}</span></label><button class="small secondary">${message("action.save", "en")}</button></form>${reset}</div>`;
}

export function clientsPage(data: AdminData, csrf: string): string {
  const rows = data.clients.map((client) => `<tr class="data-row"><td><div class="table-primary-cell"><a class="strong" href="/admin/clients/${encodeURIComponent(client.client_id)}"><span data-no-i18n>${escapeHtml(client.label)}</span></a><span class="sub-id mono" data-no-i18n>${escapeHtml(client.client_id)}</span></div></td><td><div class="scope-tags">${client.scopes.map((s) => `<span class="scope-pill">${escapeHtml(displayScopeLabel(s))}</span>`).join("")}</div></td><td>${activeRunnerSelector(client, data.runners, csrf)}</td><td class="time-cell">${escapeHtml(time(client.last_used_at_ms))}</td><td>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</td><td class="actions"><div class="action-btn-group"><a class="button small secondary" href="/admin/clients/${encodeURIComponent(client.client_id)}">${message("text.view", "en")}</a><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" aria-label="Client name" maxlength="256"><button class="small secondary">${message("action.rename", "en")}</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">${message("text.rotate", "en")}</button></form>` : ""}<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">${message("text.reset.runner.selection", "en")}</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">${message("text.revoke", "en")}</button></form>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>${message("text.no.mcp.clients.yet", "en")}</p></div></td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">${message("text.integrations", "en")}</p><h1>${message("nav.clients", "en")}</h1><p class="lede">${message("text.manage.labels.scopes.runner.routing.and.one.time.client.secrets", "en")}</p></div></section><section class="panel add-panel" id="add-client"><div class="section-title"><h2>${message("text.add.mcp.client", "en")}</h2></div><form method="post" action="/admin/clients" class="form-grid add-client-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>${message("text.label", "en")}<input name="label" maxlength="256" required placeholder="e.g. Cursor / Claude Desktop"></label><fieldset><legend>${message("text.scopes", "en")}</legend><div class="scope-selector-row">${scopeCheckboxes()}</div></fieldset><div class="form-submit-wrap"><button class="button">${message("text.create.one.time.secret", "en")}</button></div></form></section><section class="panel"><div class="table-wrap"><table class="data-table client-table"><caption class="sr-only">${message("text.mcp.clients", "en")}</caption><thead><tr><th>${message("text.label", "en")}</th><th>${message("text.scopes", "en")}</th><th>${message("text.active.runner", "en")}</th><th>${message("text.last.used", "en")}</th><th>${message("text.status", "en")}</th><th>${message("text.actions", "en")}</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
