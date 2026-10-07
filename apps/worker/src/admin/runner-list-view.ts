import { message } from "../i18n/messages.js";
import type { RunnerExecutionMode } from "../contracts/administration.js";
import type { RunnerSummaryViewModel } from "../contracts/admin-views.js";
import type { AdminData } from "../contracts/admin-views.js";
import { escapeHtml, timeMarkup } from "./format.js";
import { statusBadge, safePlatform } from "./tables.js";
import { executionModeFormFields, windowFields, PRIVILEGED_HOST_WARNING } from "./runner-fields.js";
import { IDENTIFIER_INPUT_PATTERN } from "./forms.js";
import { responsiveTableCells, responsiveTableHead, type ResponsiveColumn } from "./responsive-table.js";

const runnerColumns = [
  { key: "name", label: "text.display.name" },
  { key: "status", label: "text.status" },
  { key: "platform", label: "text.platform.architecture" },
  { key: "executionMode", label: "text.execution.mode" },
  { key: "lastSeen", label: "text.last.seen" },
  { key: "actions", label: "text.actions" },
] as const satisfies readonly ResponsiveColumn[];
export interface RunnerListPresentation {
  readonly configuredModes: ReadonlyMap<string, RunnerExecutionMode | null>;
  readonly maxValidityDays: number;
}

function runnerActions(presentation: RunnerListPresentation, runner: RunnerSummaryViewModel, modeFields: string, csrf: string): string {
  const runnerId = encodeURIComponent(runner.runner_id);
  const displayName = escapeHtml(runner.display_name);
  // Keep the administrator's mode choice in one place. Once a Runner has a
  // trusted configured mode, install/reinstall carries that server-owned
  // value as a hidden expectation instead of asking the operator to confirm
  // the same choice again from the list row.
  const rotateModeFields = executionModeFormFields(presentation.configuredModes.get(runner.runner_id) ?? undefined, csrf, false);
  return '<div class="runner-actions">'
    + '<a class="button small secondary" href="/admin/runners/' + runnerId + '">View</a>'
    + '<details class="row-actions-more"><summary>More actions</summary><div class="row-actions-menu">'
    + '<form method="post" action="/admin/runners/' + runnerId + '/rename" class="inline-action-form runner-rename-form"><input type="hidden" name="csrf_token" value="' + escapeHtml(csrf) + '"><input name="display_name" value="' + displayName + '" aria-label="Rename ' + displayName + '" maxlength="256"><button class="small secondary">Rename</button></form>'
    + '<form method="post" action="/admin/runners/' + runnerId + '/rotate" class="inline-action-form">' + rotateModeFields + '<button class="small secondary">Rotate Credential</button></form>'
    + '<form method="post" action="/admin/runners/' + runnerId + '/enrollment" class="inline-action-form">' + modeFields + windowFields("code", presentation.maxValidityDays) + '<button class="small secondary">Install / Reinstall</button></form>'
    + '<form method="post" action="/admin/runners/' + runnerId + '/delete" class="inline-action-form danger-action" data-runner-danger-action><input type="hidden" name="csrf_token" value="' + escapeHtml(csrf) + '"><label>Type Runner ID to confirm<input name="confirmation" pattern="' + IDENTIFIER_INPUT_PATTERN + '" required></label><div class="danger-action-buttons"><button class="small danger" type="submit" formaction="/admin/runners/' + runnerId + '/revoke">Revoke</button><button class="small danger" type="submit">Delete</button></div><p class="warning" data-runner-action-feedback role="alert" hidden></p></form>'
    + '</div></details></div>';
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
    return `<tr class="data-row">${responsiveTableCells(runnerColumns, {
      name: { html: `<div class="table-primary-cell"><a class="strong" href="/admin/runners/${encodeURIComponent(runner.runner_id)}"><span data-no-i18n>${escapeHtml(runner.display_name)}</span></a><span class="sub-id mono" data-no-i18n>${escapeHtml(runner.runner_id)}</span></div>` },
      status: { html: statusBadge(runner.state) },
      platform: { html: `<span class="platform-tag">${escapeHtml(safePlatform(runner))}</span>` },
      executionMode: { html: `<span class="mono font-12">${escapeHtml(modeLabel)}</span>${configuredMode === null ? "<span class=\"warning-text\"> · selection required</span>" : ""}` },
      lastSeen: { html: timeMarkup(runner.last_heartbeat_ms), className: "time-cell" },
      actions: { html: runnerActions(presentation, runner, modeFields, csrf), className: "actions" },
    })}</tr>`;
  }).join("") || `<tr><td colspan="${runnerColumns.length}" class="empty"><div class="empty-state-box"><p>${message("text.no.runners.yet", "en")}</p></div></td></tr>`;
  const warning = PRIVILEGED_HOST_WARNING;
  return `<section class="page-heading"><div><p class="eyebrow">${message("text.infrastructure", "en")}</p><h1>${message("nav.runners", "en")}</h1><p class="lede">${message("text.manage.safe.runner.metadata.authorization.windows.and.one.time.registration", "en")}</p></div><a class="button" href="#add-runner">${message("text.add.runner", "en")}</a></section>
  <section class="panel runner-inventory-panel"><div class="section-title"><h2>${message("text.registered.runners", "en")}</h2><span class="count-badge" data-no-i18n>${data.runners.length}</span></div><div class="table-wrap"><table class="data-table runner-table"><caption class="sr-only">${message("text.registered.runners", "en")}</caption>${responsiveTableHead(runnerColumns)}<tbody>${table}</tbody></table></div></section>
  <section class="panel add-panel runner-create-panel" id="add-runner"><div class="section-title"><h2>${message("text.add.runner", "en")}</h2><span class="muted font-12">${message("text.you.can.set.both.runner.authorization.and.enrollment.code.timing", "en")}</span></div><form method="post" action="/admin/runners" class="form-grid add-form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>${message("text.display.name", "en")}<input name="display_name" maxlength="256" required autocomplete="off" placeholder="e.g. Production Runner 01"></label><label>Custom Runner ID <span class="muted font-11">${message("text.optional", "en")}</span><input name="runner_id" maxlength="128" pattern="${IDENTIFIER_INPUT_PATTERN}" placeholder="generated-id"></label>${windowFields("runner", presentation.maxValidityDays)}${windowFields("code", presentation.maxValidityDays)}<fieldset class="execution-mode-fieldset"><legend>${message("text.system.runner.execution.mode", "en")}</legend><label class="check"><input type="radio" name="execution_mode" value="dedicated_user" checked data-execution-mode="dedicated_user"><span><strong>${message("text.restricted.service.account.dedicated.user.recommended", "en")}</strong><small>${message("text.use.a.dedicated.restricted.service.identity.for.narrower.host.access", "en")}</small></span></label><label class="check"><input type="radio" name="execution_mode" value="privileged_host" data-execution-mode="privileged_host"><span><strong>${message("text.full.host.control.advanced.explicit.authorization.required", "en")}</strong><small>${message("text.linux.root.macos.root.launchdaemon.windows.system.highestavailable", "en")}</small></span></label><p class="warning privileged-host-warning" hidden>${escapeHtml(warning)}</p><label class="check"><input type="checkbox" name="confirm_privileged_host" value="true" data-privileged-confirmation><span>${message("text.i.understand.and.authorize.this.one.time.high.privilege.installation.acknowledgement", "en")}</span></label></fieldset><div class="form-submit-wrap"><button class="button">${message("text.create.enrollment", "en")}</button></div></form></section>`;
}
