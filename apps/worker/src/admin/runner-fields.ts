import { message } from "../i18n/messages.js";
import type { RunnerExecutionMode as ConsoleExecutionMode } from "../contracts/administration.js";
import { escapeHtml } from "./format.js";

export function windowFields(prefix: "runner" | "code", maxValidityDays: number): string {
  const runner = prefix === "runner";
  const label = runner ? "Runner authorization" : "One-time code";
  const name = runner ? "runner_valid_days" : "code_valid_days";
  const value = runner ? "0" : "1";
  const help = runner ? "0 means no expiry. The authorization starts when you save it." : "The code starts now and must remain valid for at least 1 day.";
  return `<fieldset class="validity-fieldset"><legend>${label}</legend><label>${message("text.valid.days", "en")}<input type="number" name="${name}" value="${value}" min="${runner ? "0" : "1"}" max="${maxValidityDays}" step="1" inputmode="numeric" required></label><small>${help}</small></fieldset>`;
}

export const PRIVILEGED_HOST_WARNING = "Runner will run as root, SYSTEM, or the platform-equivalent highest-privilege identity. Shell commands can access files, processes, network, environment variables, credentials, and system services reachable by that service identity. Install only on a trusted dedicated machine, VM, or container.";

export function executionModeFormFields(mode: ConsoleExecutionMode | undefined, csrf: string, interactive = false, requirePrivilegedConfirmation = mode === "privileged_host"): string {
  if (!interactive) {
    const expected = mode ?? "";
    return `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="expected_execution_mode" value="${expected}">`;
  }
  const safeMode = mode === "privileged_host" ? "privileged_host" : mode === "dedicated_user" ? "dedicated_user" : undefined;
  const expected = safeMode ?? "";
  const confirmationRequired = safeMode === "privileged_host" && requirePrivilegedConfirmation;
  const priorConfirmation = safeMode === "privileged_host" && !confirmationRequired;
  const placeholder = safeMode === undefined ? `<option value="" selected>${message("text.choose.execution.mode.required", "en")}</option>` : "";
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="expected_execution_mode" value="${expected}"><fieldset class="execution-mode-inline" data-execution-mode-form data-reuse-privileged-confirmation="${priorConfirmation ? "true" : "false"}"><legend>${message("text.execution.mode", "en")}</legend><label>${message("text.mode", "en")}<select name="execution_mode" aria-label="Execution mode"${safeMode === undefined ? " required" : ""}>${placeholder}<option value="dedicated_user"${safeMode === "dedicated_user" ? " selected" : ""}>${message("text.dedicated.user.restricted.service.account", "en")}</option><option value="privileged_host"${safeMode === "privileged_host" ? " selected" : ""}>${message("text.privileged.host.highest.host.privilege", "en")}</option></select></label><label class="check"><input type="checkbox" name="confirm_privileged_host" value="true" data-privileged-confirmation${confirmationRequired ? " required" : ""}><span>${priorConfirmation ? "Previously authorized for this Runner." : "I understand and authorize the high-privilege installation."}</span></label><p class="warning privileged-host-warning"${safeMode === "privileged_host" ? "" : " hidden"}>${escapeHtml(PRIVILEGED_HOST_WARNING)}</p></fieldset>`;
}
