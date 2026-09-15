import type { RunnerRecord, RunnerExecutionMode } from "../registry.js";
import type { AdminData } from "./view-models.js";
import { escapeHtml, time } from "./format.js";
import { statusBadge, safePlatform } from "./tables.js";
import { executionModeFormFields, windowFields, PRIVILEGED_HOST_WARNING } from "./runner-fields.js";
export interface RunnerListPresentation {
  readonly configuredModes: ReadonlyMap<string, RunnerExecutionMode | null>;
  readonly maxValidityDays: number;
}

function runnerActionCell(presentation: RunnerListPresentation, runner: RunnerRecord, modeFields: string, csrf: string): string {
  const runnerId = encodeURIComponent(runner.runner_id);
  const displayName = escapeHtml(runner.display_name);
  // Keep the administrator's mode choice in one place. Once a Runner has a
  // trusted configured mode, install/reinstall carries that server-owned
  // value as a hidden expectation instead of asking the operator to confirm
  // the same choice again from the list row.
  const rotateModeFields = executionModeFormFields(presentation.configuredModes.get(runner.runner_id) ?? undefined, csrf, false);
  return '<td class="actions"><div class="runner-actions">'
    + '<a class="button small secondary" href="/admin/runners/' + runnerId + '">View</a>'
    + '<form method="post" action="/admin/runners/' + runnerId + '/rename" class="inline-action-form runner-rename-form"><input type="hidden" name="csrf_token" value="' + escapeHtml(csrf) + '"><input name="display_name" value="' + displayName + '" aria-label="Rename ' + displayName + '" maxlength="256"><button class="small secondary">Rename</button></form>'
    + '<details class="row-actions-more"><summary>More actions</summary><div class="row-actions-menu">'
    + '<form method="post" action="/admin/runners/' + runnerId + '/rotate" class="inline-action-form">' + rotateModeFields + '<button class="small secondary">Rotate Credential</button></form>'
    + '<form method="post" action="/admin/runners/' + runnerId + '/enrollment" class="inline-action-form">' + modeFields + windowFields("code", presentation.maxValidityDays) + '<button class="small secondary">Install / Reinstall</button></form>'
    + '<form method="post" action="/admin/runners/' + runnerId + '/delete" class="inline-action-form danger-action"><input type="hidden" name="csrf_token" value="' + escapeHtml(csrf) + '"><label>Type Runner ID to confirm<input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required></label><div class="danger-action-buttons"><button class="small danger" type="submit" formaction="/admin/runners/' + runnerId + '/revoke">Revoke</button><button class="small danger" type="submit">Delete</button></div></form>'
    + '</div></details></div></td>';
}

export function runnersPage(presentation: RunnerListPresentation, data: AdminData, csrf: string): string {
  const table = data.runners.map((runner) => {
    const configuredMode = presentation.configuredModes.get(runner.runner_id) ?? null;
    const mode = configuredMode ?? undefined;
    const modeLabel = configuredMode ?? "not configured";
    // Existing Runners already carry the administrator-confirmed mode. Keep
    // that value read-only in action forms; only records without a trusted
    // mode need an explicit choice before reinstalling.
    const modeFields = configuredMode === null
      ? executionModeFormFields(undefined, csrf, true)
      : executionModeFormFields(mode, csrf, false);
    return `<tr class="data-row"><td><div class="table-primary-cell"><a class="strong" href="/admin/runners/${encodeURIComponent(runner.runner_id)}"><span data-no-i18n>${escapeHtml(runner.display_name)}</span></a><span class="sub-id mono">${escapeHtml(runner.runner_id)}</span></div></td><td>${statusBadge(runner.state)}</td><td><span class="platform-tag">${escapeHtml(safePlatform(runner))}</span></td><td><span class="mono font-12">${escapeHtml(modeLabel)}</span>${configuredMode === null ? "<span class=\"warning-text\"> · selection required</span>" : ""}</td><td class="time-cell">${escapeHtml(time(runner.last_heartbeat_ms))}</td>${runnerActionCell(presentation, runner, modeFields, csrf)}</tr>`;
  }).join("") || `<tr><td colspan="6" class="empty"><div class="empty-state-box"><p>No runners yet.</p></div></td></tr>`;
  const warning = PRIVILEGED_HOST_WARNING;
  return `<section class="page-heading"><div><p class="eyebrow">Infrastructure</p><h1>Runners</h1><p class="lede">Manage safe runner metadata, authorization windows, and one-time registration.</p></div></section><section class="panel add-panel" id="add-runner"><div class="section-title"><h2>Add Runner</h2><span class="muted font-12">You can set both Runner authorization and enrollment-code timing.</span></div><form method="post" action="/admin/runners" class="form-grid add-form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Display name<input name="display_name" maxlength="256" required autocomplete="off" placeholder="e.g. Production Runner 01"></label><label>Safe runner ID <span class="muted font-11">optional</span><input name="runner_id" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="generated-id"></label>${windowFields("runner", presentation.maxValidityDays)}${windowFields("code", presentation.maxValidityDays)}<fieldset class="execution-mode-fieldset"><legend>System Runner execution mode</legend><label class="check"><input type="radio" name="execution_mode" value="dedicated_user" checked data-execution-mode="dedicated_user"><span><strong>Restricted service account (dedicated_user, recommended)</strong><small>Use a dedicated restricted service identity for narrower host access.</small></span></label><label class="check"><input type="radio" name="execution_mode" value="privileged_host" data-execution-mode="privileged_host"><span><strong>Full host control (advanced, explicit authorization required)</strong><small>Linux root · macOS root LaunchDaemon · Windows SYSTEM / HighestAvailable</small></span></label><p class="warning privileged-host-warning" hidden>${escapeHtml(warning)}</p><label class="check"><input type="checkbox" name="confirm_privileged_host" value="true" data-privileged-confirmation><span>I understand and authorize this one-time high-privilege installation acknowledgement.</span></label></fieldset><div class="form-submit-wrap"><button class="button">Create enrollment</button></div></form></section><section class="panel"><div class="table-wrap"><table class="data-table runner-table"><caption class="sr-only">Registered runners</caption><thead><tr><th>Display name</th><th>Status</th><th>Platform / architecture</th><th>Execution mode</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>${table}</tbody></table></div></section>`;
}
