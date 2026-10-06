import { message } from "../i18n/messages.js";
import type { ClientViewModel, RunnerSummaryViewModel } from "../contracts/admin-views.js";
import type { AdminData } from "../contracts/admin-views.js";
import { record, escapeHtml, timeMarkup, displayScopeLabel } from "./format.js";
import { permissionSelect, scopeCheckboxes } from "./forms.js";
import { clientCredentialBadge } from "./tables.js";
import { responsiveTableCells, responsiveTableHead, type ResponsiveColumn } from "./responsive-table.js";

const clientColumns = [
  { key: "name", label: "text.label" },
  { key: "scopes", label: "text.scopes" },
  { key: "activeRunner", label: "text.active.runner" },
  { key: "lastUsed", label: "text.last.used" },
  { key: "status", label: "client.credential.status" },
  { key: "actions", label: "text.actions" },
] as const satisfies readonly ResponsiveColumn[];

function clientLifecycleActions(clientId: string, revoked: boolean, csrf: string): string {
  const base = '/admin/clients/' + encodeURIComponent(clientId);
  const token = '<input type="hidden" name="csrf_token" value="' + escapeHtml(csrf) + '">';
  return (revoked ? '' : '<form method="post" action="' + base + '/revoke" class="inline-action-form danger-action">' + token + '<button class="small danger" type="submit">' + message('text.revoke', 'en') + '</button></form>')
    + '<form method="post" action="' + base + '/delete" class="inline-action-form danger-action" data-client-delete>' + token + '<button class="small danger" type="submit">' + message('action.delete', 'en') + '</button></form>';
}

export function clientDetailPage(client: ClientViewModel, runners: readonly RunnerSummaryViewModel[], overrides: readonly Record<string, unknown>[], csrf: string): string {
  const clientId = client.client_id;
  const label = client.label;
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
        <form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/override" class="override-form-row">
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
  const scopeValues = client.scopes;
  if (scopeValues.length === 0) return `<section class="detail-header">
    <div class="detail-title-group">
      <p class="eyebrow">AI connection</p>
      <div class="detail-title-row"><h1 class="detail-title" data-no-i18n>${escapeHtml(label)}</h1>${clientCredentialBadge(isRevoked)}</div>
      <p class="detail-id mono" data-no-i18n>${escapeHtml(clientId)}</p>
    </div>
    <div class="detail-header-actions"><a class="button secondary" href="/admin/clients">Back to clients</a>${clientLifecycleActions(clientId, isRevoked, csrf)}</div>
  </section>
  <section class="panel client-library-panel">
    <div class="section-title"><h2>Available MCPs and Skills</h2></div>
    <p class="muted">Use all enabled MCPs and Skills with this connection.</p>
    <a class="button" href="/admin/central">Manage MCPs and Skills</a>
  </section>`;
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
      <p class="eyebrow">${message("text.mcp.client.detail", "en")}</p>
      <div class="detail-title-row">
        <h1 class="detail-title" data-no-i18n>${escapeHtml(label)}</h1>
        ${clientCredentialBadge(isRevoked)}
      </div>
      <p class="detail-id mono"><span data-no-i18n>${escapeHtml(clientId)}</span></p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/clients">${message("text.back.to.clients", "en")}</a>
      ${clientLifecycleActions(clientId, isRevoked, csrf)}
    </div>
  </section>
  <div class="grid-two client-settings-grid">
    <section class="panel client-permissions-panel">
      <div class="section-title">
        <h2>${message("text.global.permissions", "en")}</h2>
      </div>
      ${scopeEditor}
      <form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/recording" class="client-recording-form">
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
    <section class="panel client-routing-panel">
      <div class="section-title">
        <h2>Client Routing &amp; Status</h2>
      </div>
      <dl class="details">
        <dt>${message("text.client.id", "en")}</dt>
        <dd class="mono"><span data-no-i18n>${escapeHtml(clientId)}</span></dd>
        <dt>${message("text.active.runner.2", "en")}</dt>
        <dd>${activeRunnerSelector(client, runners, csrf)}</dd>
        <dt>${message("text.last.used.2", "en")}</dt>
        <dd class="time-cell">${timeMarkup(client.last_used_at_ms)}</dd>
        <dt>${message("client.credential.status", "en")}</dt>
        <dd>${message(isRevoked ? "client.credential.revoked" : "client.credential.active", "en")}</dd>
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
        <tbody>${overrideRows || `<tr><td colspan="${clientColumns.length}" class="empty"><div class="empty-state-box"><p>${message("text.no.runners.registered", "en")}</p></div></td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

export function activeRunnerLabel(client: ClientViewModel, runners: readonly RunnerSummaryViewModel[]): string { const runner = client.active_runner_id === null ? undefined : runners.find((item) => item.runner_id === client.active_runner_id); return runner === undefined ? "Not selected" : runner.display_name; }

export function activeRunnerSelector(client: ClientViewModel, runners: readonly RunnerSummaryViewModel[], csrf: string): string {
  if (client.scopes.length === 0) return '<span class="routing-badge">No Runner needed</span>';
  const current = activeRunnerLabel(client, runners);
  if (runners.length === 0) return `<span class="routing-badge">${escapeHtml(current)}</span><span class="muted"> · No runners available</span>`;
  const options = runners.map((runner) => `<option data-no-i18n value="${escapeHtml(runner.runner_id)}"${client.active_runner_id === runner.runner_id ? " selected" : ""}>${escapeHtml(runner.display_name)} (${escapeHtml(runner.runner_id)})</option>`).join("");
  const reset = client.active_runner_id === null ? "" : `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger" type="submit">${message("text.reset", "en")}</button></form>`;
  return `<div class="runner-selection-controls"><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/active-runner" class="runner-selection-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><select name="runner_id" aria-label="Active Runner"><option value="" disabled${client.active_runner_id === null ? " selected" : ""}>${message("text.choose.a.runner", "en")}</option>${options}</select><label class="check"><input type="checkbox" name="confirm_switch" value="true"><span>${message("text.confirm.switch", "en")}</span></label><button class="small secondary">${message("action.save", "en")}</button></form>${reset}</div>`;
}

export function clientsPage(data: AdminData, csrf: string, centralEnabled = true): string {
  const rows = data.clients.map((client) => `<tr class="data-row">${responsiveTableCells(clientColumns, {
    name: { html: `<div class="table-primary-cell"><a class="strong" href="/admin/clients/${encodeURIComponent(client.client_id)}"><span data-no-i18n>${escapeHtml(client.label)}</span></a><span class="sub-id mono" data-no-i18n>${escapeHtml(client.client_id)}</span></div>` },
    scopes: { html: `<div class="scope-tags">${client.scopes.map((scope) => `<span class="scope-pill">${escapeHtml(displayScopeLabel(scope))}</span>`).join("") || '<span class="scope-pill">MCP &amp; Skill</span>'}</div>` },
    activeRunner: { html: activeRunnerSelector(client, data.runners, csrf) },
    lastUsed: { html: timeMarkup(client.last_used_at_ms), className: "time-cell" },
    status: { html: clientCredentialBadge(client.revoked_at_ms !== null, "compact") },
    actions: { html: clientListActions(client, csrf), className: "actions" },
  })}</tr>`).join("") || `<tr><td colspan="${clientColumns.length}" class="empty"><div class="empty-state-box"><p>${message("text.no.mcp.clients.yet", "en")}</p></div></td></tr>`;
  return `<section class="page-heading">
    <div><p class="eyebrow">${message("text.integrations", "en")}</p><h1>${message("nav.clients", "en")}</h1><p class="lede">${message("text.manage.labels.scopes.runner.routing.and.one.time.client.secrets", "en")}</p></div>
    <a class="button" href="#add-client">${message("text.add.mcp.client", "en")}</a>
  </section>
  <section class="panel client-list-panel" aria-labelledby="client-list-title">
    <div class="section-title"><div><h2 id="client-list-title">${message("product.home.connections", "en")}</h2><span class="count-badge" data-no-i18n>${data.clients.length}</span></div></div>
    <div class="table-wrap"><table class="data-table client-table">
      <caption class="sr-only">${message("text.mcp.clients", "en")}</caption>
      ${responsiveTableHead(clientColumns)}
      <tbody>${rows}</tbody>
    </table></div>
  </section>
  <section class="panel add-panel client-create-panel" id="add-client" aria-labelledby="add-client-title">
    <div class="section-title"><h2 id="add-client-title">${message("text.add.mcp.client", "en")}</h2></div>
    <form method="post" action="/admin/clients" class="form-grid add-client-grid">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
      <label>${message("text.label", "en")}<input name="label" maxlength="256" required placeholder="e.g. Cursor / Claude Desktop"></label>
      <label>Access type<select name="access_mode">${centralEnabled ? '<option value="central">MCP and Skills</option>' : ''}<option value="native">MCP, Skills and computer access</option></select></label>
      <details data-client-computer-permissions${centralEnabled ? "" : " open"}>
        <summary>Computer permissions</summary>
        <fieldset><legend>${message("text.scopes", "en")}</legend><div class="scope-selector-row">${scopeCheckboxes()}</div></fieldset>
      </details>
      <p class="muted">Choose computer access to work with files and run commands through a Runner.</p>
      <div class="form-submit-wrap"><button class="button">${message("text.create.one.time.secret", "en")}</button></div>
    </form>
  </section>`;
}

function clientListActions(client: ClientViewModel, csrf: string): string {
  const base = '/admin/clients/' + encodeURIComponent(client.client_id);
  const token = '<input type="hidden" name="csrf_token" value="' + escapeHtml(csrf) + '">';
  return `<div class="client-row-actions">
    <a class="button small secondary" href="${base}">${message("text.view", "en")}</a>
    <details class="row-actions-disclosure">
      <summary>${message("text.actions", "en")}</summary>
      <div class="action-btn-group client-management-actions">
        <form method="post" action="${base}/rename" class="inline-action-form client-rename-form">
          ${token}<input name="label" value="${escapeHtml(client.label)}" aria-label="Client name" maxlength="256"><button class="small secondary">${message("action.rename", "en")}</button>
        </form>
        ${client.revoked_at_ms === null ? `<form method="post" action="${base}/rotate" class="inline-action-form">${token}<button class="small secondary">${message("text.rotate", "en")}</button></form>` : ''}
        ${client.scopes.length > 0 ? `<form method="post" action="${base}/reset-runner" class="inline-action-form">${token}<button class="small secondary">${message("text.reset.runner.selection", "en")}</button></form>` : ''}
        ${clientLifecycleActions(client.client_id, client.revoked_at_ms !== null, csrf)}
      </div>
    </details>
  </div>`;
}
