import type { McpClientRecord, RunnerRecord } from "../registry.js";
import type { AdminData } from "./view-models.js";
import { record, escapeHtml, time, displayScopeLabel } from "./format.js";
import { permissionSelect, scopeCheckboxes } from "./forms.js";
import { statusBadge } from "./tables.js";

export function clientDetailPage(client: Record<string, unknown>, runners: readonly RunnerRecord[], overrides: readonly Record<string, unknown>[], csrf: string): string {
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
            <button class="small secondary">Save restriction</button>
            ${override === undefined ? "" : `<button class="small danger" formaction="/admin/clients/${encodeURIComponent(clientId)}/reset-override">Reset</button>`}
          </div>
        </form>
      </td>
    </tr>`;
  }).join("");
  const scopeValues = Array.isArray(client.scopes) ? client.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const scopeEditor = `<form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/scopes" class="scope-editor-form">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <fieldset class="scope-fieldset">
      <legend>Base scopes</legend>
      <div class="scope-selector-row">
        ${scopeCheckboxes(scopeValues)}
      </div>
    </fieldset>
    <div class="form-submit-wrap">
      <button class="button secondary">Save scopes</button>
    </div>
  </form>`;
  return `<section class="detail-header">
    <div class="detail-title-group">
      <div class="detail-title-row">
        <p class="eyebrow">MCP Client detail</p>
        <h1 class="detail-title" data-no-i18n>${escapeHtml(label)}</h1>
        ${statusBadge(isRevoked ? "offline" : "online")}
      </div>
      <p class="detail-id mono"><span data-no-i18n>${escapeHtml(clientId)}</span></p>
      <p class="lede">Runner-specific access can only further restrict the client's global scopes; it can never grant additional access.</p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/clients">Back to clients</a>
    </div>
  </section>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>Global permissions</h2>
      </div>
      <div class="active-scopes-box">
        <span class="form-stat-label">Effective Global Scopes</span>
        <p class="muted scope-line">${escapeHtml(scopeValues.map(displayScopeLabel).join(", "))}</p>
      </div>
      <p class="muted scope-help">Each base scope has a distinct ceiling: <span class="mono">Read</span> permits inspection, <span class="mono">Write</span> permits approved edits, and <span class="mono">Exec</span> permits Host shell and Job control. Runner and Workspace policy can only reduce these permissions.</p>
      ${scopeEditor}
      <form method="post" action="/admin/clients/${encodeURIComponent(clientId)}/recording" class="scope-editor-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <label for="record-jobs">Cloud Job history</label>
        <select id="record-jobs" name="record_jobs">
          <option value="true"${client.record_jobs !== false ? " selected" : ""}>Record new jobs</option>
          <option value="false"${client.record_jobs === false ? " selected" : ""}>Do not record new jobs</option>
        </select>
        <p class="muted">When disabled, new Job snapshots and Job tool audit entries are not stored in the cloud. Local Runner job metadata and logs remain. Existing cloud history is not deleted. Use workspace_id with Job operations (Runner 0.1.1+); offline history is unavailable for unrecorded jobs.</p>
        <button class="button secondary">Save recording preference</button>
      </form>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Client Routing &amp; Status</h2>
      </div>
      <dl class="details">
        <dt>Client ID</dt>
        <dd class="mono"><span data-no-i18n>${escapeHtml(clientId)}</span></dd>
        <dt>Active Runner</dt>
        <dd>${activeRunnerSelector(client as unknown as McpClientRecord, runners, csrf)}</dd>
        <dt>Last Used</dt>
        <dd class="time-cell">${escapeHtml(time(typeof client.last_used_at_ms === "number" ? client.last_used_at_ms : null))}</dd>
        <dt>Status</dt>
        <dd>${isRevoked ? "Revoked" : "Active"}</dd>
      </dl>
    </section>
  </div>
  <section class="panel">
    <div class="section-title">
      <h2>Client access on each Runner</h2>
      <span class="muted font-12">Use Global means no additional restriction. Effective access is still limited by Runner and Workspace policy.</span>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Runner</th>
            <th>Mode</th>
            <th colspan="4">Additional restriction</th>
          </tr>
        </thead>
        <tbody>${overrideRows || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>No runners registered.</p></div></td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

export function activeRunnerLabel(client: McpClientRecord, runners: readonly RunnerRecord[]): string { const runner = client.active_runner_id === null ? undefined : runners.find((item) => item.runner_id === client.active_runner_id); return runner === undefined ? "Not selected" : runner.display_name; }

export function activeRunnerSelector(client: McpClientRecord, runners: readonly RunnerRecord[], csrf: string): string {
  const current = activeRunnerLabel(client, runners);
  if (runners.length === 0) return `<span class="routing-badge">${escapeHtml(current)}</span><span class="muted"> · No runners available</span>`;
  const options = runners.map((runner) => `<option data-no-i18n value="${escapeHtml(runner.runner_id)}"${client.active_runner_id === runner.runner_id ? " selected" : ""}>${escapeHtml(runner.display_name)} (${escapeHtml(runner.runner_id)})</option>`).join("");
  const reset = client.active_runner_id === null ? "" : `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger" type="submit">Reset</button></form>`;
  return `<div class="runner-selection-controls"><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/active-runner" class="runner-selection-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><select name="runner_id" aria-label="Active Runner"><option value="" disabled${client.active_runner_id === null ? " selected" : ""}>Choose a Runner</option>${options}</select><label class="check"><input type="checkbox" name="confirm_switch" value="true"><span>Confirm switch</span></label><button class="small secondary">Save</button></form>${reset}</div>`;
}

export function clientsPage(data: AdminData, csrf: string): string {
  const rows = data.clients.map((client) => `<tr class="data-row"><td><div class="table-primary-cell"><a class="strong" href="/admin/clients/${encodeURIComponent(client.client_id)}"><span data-no-i18n>${escapeHtml(client.label)}</span></a><span class="sub-id mono" data-no-i18n>${escapeHtml(client.client_id)}</span></div></td><td><div class="scope-tags">${client.scopes.map((s) => `<span class="scope-pill">${escapeHtml(displayScopeLabel(s))}</span>`).join("")}</div></td><td>${activeRunnerSelector(client, data.runners, csrf)}</td><td class="time-cell">${escapeHtml(time(client.last_used_at_ms))}</td><td>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</td><td class="actions"><div class="action-btn-group"><a class="button small secondary" href="/admin/clients/${encodeURIComponent(client.client_id)}">View</a><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" aria-label="Client name" maxlength="256"><button class="small secondary">Rename</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate</button></form>` : ""}<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner" class="inline-action-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Reset Runner Selection</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Revoke</button></form>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>No MCP clients yet.</p></div></td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Integrations</p><h1>MCP Clients</h1><p class="lede">Manage labels, scopes, runner routing, and one-time client secrets.</p></div></section><section class="panel add-panel" id="add-client"><div class="section-title"><h2>Add MCP Client</h2></div><form method="post" action="/admin/clients" class="form-grid add-client-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Label<input name="label" maxlength="256" required placeholder="e.g. Cursor / Claude Desktop"></label><fieldset><legend>Scopes</legend><div class="scope-selector-row">${scopeCheckboxes()}</div></fieldset><div class="form-submit-wrap"><button class="button">Create one-time secret</button></div></form></section><section class="panel"><div class="table-wrap"><table class="data-table client-table"><caption class="sr-only">MCP clients</caption><thead><tr><th>Label</th><th>Scopes</th><th>Active runner</th><th>Last used</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
