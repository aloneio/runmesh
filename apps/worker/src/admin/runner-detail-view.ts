import { message } from "../i18n/messages.js";
import type { RunnerExecutionMode } from "../contracts/administration.js";
import type { AdminData } from "../contracts/admin-views.js";
import type { RunnerReleaseDescriptor } from "../contracts/runner-release.js";
import type { HistoryView } from "../history-ui.js";
import type { JobHistorySettings } from "@aloneio/runmesh-protocol";
import { RunnerUpdateOperationSchema } from "@aloneio/runmesh-protocol";
import { historyControls, historySettingsForm } from "../history-ui.js";
import { JOBS_EXPLANATION, jobSnapshotNote } from "./job-views.js";
import { validityStatus } from "../validity.js";
import { record, escapeHtml, dataText, timeMarkup, shortChecksum, statusClass } from "./format.js";
import { statusBadge, historyJobTable, mcpCallTable } from "./tables.js";
import { IDENTIFIER_INPUT_PATTERN, managedWorkspaceForm, permissionForm } from "./forms.js";
import { isFullHostPath } from "./host-path-label.js";
import { executionModeFormFields, windowFields } from "./runner-fields.js";
export interface RunnerDetailPresentation {
  readonly configuredMode: RunnerExecutionMode | null;
  readonly reportedMode: RunnerExecutionMode | "unknown";
  readonly maxValidityDays: number;
  readonly dayMs: number;
}

export interface RunnerDetailPageInput {
  readonly presentation: RunnerDetailPresentation;
  readonly runner: Readonly<Record<string, unknown>>;
  readonly workspaces: readonly Record<string, unknown>[];
  readonly jobs?: AdminData["jobs"] | undefined;
  readonly environment?: Readonly<Record<string, unknown>> | undefined;
  readonly csrf: string;
  readonly release: Pick<RunnerReleaseDescriptor, "latest_version" | "distributable">;
  readonly policyVersions?: readonly Record<string, unknown>[] | undefined;
  readonly enrollment?: Readonly<Record<string, unknown>> | undefined;
  readonly mcpCalls?: readonly Record<string, unknown>[] | undefined;
  readonly view?: HistoryView | undefined;
  readonly historySettings?: JobHistorySettings | undefined;
}

export function runnerDetailPage({ presentation, runner, workspaces, jobs, environment, csrf, release,
  policyVersions = [], enrollment, mcpCalls, view = { scope: "none", limit: 10 }, historySettings,
}: RunnerDetailPageInput): string {
  const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
  const displayName = typeof runner.display_name === "string" ? runner.display_name : runnerId;
  const state = typeof runner.state === "string" ? runner.state : "offline";
  const metadata = record(runner.metadata);
  const publicInfo = record(runner.public_info);
  const tools = record(environment?.tools);
  const toolRows = tools === undefined ? `<p class="muted empty-desc">${message("text.environment.details.unavailable.while.offline", "en")}</p>` : `<div class="tool-grid">${Object.entries(tools).map(([name, value]) => { const item = record(value); const isAvail = item?.available === true; return `<div class="tool-item"><div class="tool-name-row"><strong class="tool-name" data-no-i18n>${escapeHtml(name)}</strong>${isAvail ? `<span class="badge online"><span class="status-dot online"></span>${message("text.available", "en")}</span>` : `<span class="badge offline"><span class="status-dot offline"></span>${message("text.unavailable", "en")}</span>`}</div>${isAvail && typeof item?.version === "string" ? `<span class="tool-version mono" data-no-i18n>${escapeHtml(item.version)}</span>` : ""}</div>`; }).join("")}</div>`;
  const policyStatus = runner.policy_status === "applied" || runner.policy_status === "invalid" ? runner.policy_status : "pending";
  const workspaceRows = workspaces.map((workspace) => managedWorkspaceForm(runnerId, record(workspace), csrf)).join("") || `<li class="muted empty-item">${message("text.no.managed.workspaces.configured", "en")}</li>`;
  const updateChannel = runner.update_channel === "pinned" ? "pinned" : "stable";
  const currentVersion = typeof runner.current_runner_version === "string" ? runner.current_runner_version : typeof publicInfo?.runner_version === "string" ? publicInfo.runner_version : undefined;
  const latestVersion = typeof runner.latest_runner_version === "string" ? runner.latest_runner_version : release.distributable ? release.latest_version : undefined;
  const distributionNotice = release.distributable ? "" : `<p class="muted font-12">${message("text.hosted.distribution.is.not.configured.portable.artifact.manual.version.management.only", "en")}</p>`;
  const desiredVersion = typeof runner.desired_runner_version === "string" ? runner.desired_runner_version : "";
  const updateParsed = RunnerUpdateOperationSchema.safeParse(runner.update_operation);
  const update = updateParsed.success ? updateParsed.data : null;
  const updateState = update === null ? "" : message(`runner.update.${update.state}`, "en");
  const protocolCompatibility = runner.protocol_compatibility === "compatible" || runner.protocol_compatibility === "incompatible" ? runner.protocol_compatibility : "unknown";
  const protocolRange = `${String(runner.protocol_min_version ?? "Unknown")}–${String(runner.protocol_max_version ?? "Unknown")}`;
  const permissions = record(runner.runner_permissions);
  const desiredRevision = typeof runner.desired_policy_revision === "number" ? String(runner.desired_policy_revision) : "0";
  const appliedRevision = typeof runner.applied_policy_revision === "number" ? String(runner.applied_policy_revision) : "—";
  // Only a server-owned Registry value may establish the configured mode.
  // Runner metadata/public_info below are retained as untrusted diagnostics.
  const executionMode = presentation.configuredMode;
  const reportedExecutionMode = presentation.reportedMode;
  const privilegeState = metadata?.privilege_state === "privileged" || metadata?.privilege_state === "restricted" || metadata?.privilege_state === "mismatch" || metadata?.privilege_state === "unknown"
    ? metadata.privilege_state
    : publicInfo?.privilege_state === "privileged" || publicInfo?.privilege_state === "restricted" || publicInfo?.privilege_state === "mismatch" || publicInfo?.privilege_state === "unknown" ? publicInfo.privilege_state : "unknown";
  const serviceIdentity = typeof metadata?.service_identity === "string" && metadata.service_identity.length > 0
    ? metadata.service_identity
    : typeof publicInfo?.service_identity === "string" && publicInfo.service_identity.length > 0 ? publicInfo.service_identity : undefined;
  const reportedRevision = typeof runner.runner_reported_policy_revision === "number" ? String(runner.runner_reported_policy_revision) : "—";
  const desiredChecksum = shortChecksum(runner.desired_policy_checksum);
  const activeChecksum = shortChecksum(runner.active_policy_checksum);
  const reportedChecksum = shortChecksum(runner.runner_reported_policy_checksum);
  const runnerFrom = typeof runner.valid_from_ms === "number" ? runner.valid_from_ms : null;
  const runnerUntil = typeof runner.valid_until_ms === "number" ? runner.valid_until_ms : null;
  const runnerValidityStatus = runner.validity_status === "scheduled" || runner.validity_status === "expired" || runner.validity_status === "active" ? runner.validity_status : validityStatus({ valid_from_ms: runnerFrom, valid_until_ms: runnerUntil });
  const enrollmentFrom = typeof enrollment?.not_before_ms === "number" && enrollment.not_before_ms > 0 ? enrollment.not_before_ms : null;
  const enrollmentUntil = typeof enrollment?.expires_at_ms === "number" ? enrollment.expires_at_ms : null;
  const enrollmentStatus = enrollment === undefined ? "none" : typeof enrollment.used_at_ms === "number" ? "used" : validityStatus({ valid_from_ms: enrollmentFrom, valid_until_ms: enrollmentUntil });
  const validityDaysInput = (value: number | null, allowZero = false): string => {
    if (value === null || value <= Date.now()) return allowZero ? "0" : "1";
    return String(Math.min(presentation.maxValidityDays, Math.max(1, Math.ceil((value - Date.now()) / presentation.dayMs))));
  };
  const latestPolicy = policyVersions.map(record).filter((item): item is Record<string, unknown> => item !== undefined).sort((left, right) => Number(right.revision ?? 0) - Number(left.revision ?? 0))[0];
  const validationSummary = Array.isArray(latestPolicy?.validation_summary) ? latestPolicy.validation_summary.map(record).filter((item): item is Record<string, unknown> => item !== undefined) : [];
  const workspaceValidation: Record<string, unknown>[] = validationSummary.length > 0 ? validationSummary : workspaces.reduce<Record<string, unknown>[]>((items, item) => {
    const value = record(item);
    if (value !== undefined) items.push({ workspace_id: value.workspace_id, status: value.validation_status });
    return items;
  }, []);
  const hasOsAccessDenial = workspaceValidation.some((item) => item.reason === "os_access_denied");
  const hasFullHostWorkspace = workspaces.some((item) => isFullHostPath(typeof record(item)?.root_path === "string" ? String(record(item)?.root_path) : ""));
  const revisionLag = (typeof runner.desired_policy_revision === "number" && (runner.applied_policy_revision === null || typeof runner.applied_policy_revision !== "number" || runner.desired_policy_revision > runner.applied_policy_revision)) || (typeof runner.desired_policy_revision === "number" && (runner.runner_reported_policy_revision === null || typeof runner.runner_reported_policy_revision !== "number" || runner.desired_policy_revision > runner.runner_reported_policy_revision));
  const identityMismatch = privilegeState === "mismatch";
  const unverifiedPrivilegedReport = reportedExecutionMode === "privileged_host" && executionMode !== "privileged_host";
  const configuredButNotRestarted = runner.service_manifest_changed === true && runner.service_restarted !== true;
  const warnings = [
    identityMismatch ? "The Runner privileges differ from the configured mode. Check the service account." : "",
    executionMode === null ? "Choose and confirm an execution mode before installing the Runner." : "",
    unverifiedPrivilegedReport ? "The Runner reports full host privileges. Confirm the execution mode before re-enrolling." : "",
    executionMode === "dedicated_user" && hasFullHostWorkspace ? "dedicated_user is configured while a full-host workspace is enabled; migrate the service or narrow the workspace." : "",
    revisionLag ? "Desired policy revision is ahead of the applied or Runner-reported revision." : "",
    hasOsAccessDenial ? "The Runner service account cannot access this workspace. Check its file permissions and execution mode." : "",
    configuredButNotRestarted ? "The managed service manifest changed but the Runner process was not restarted." : "",
    state === "online" && workspaceValidation.filter((item) => item.status === "valid").length === 0 ? "Runner is online but has zero valid workspaces." : "",
  ].filter(Boolean);
  const diagnosticRows = workspaceValidation.map((item) => {
    const id = typeof item.workspace_id === "string" ? item.workspace_id : "unknown";
    const status = typeof item.status === "string" ? item.status : "unknown";
    const reason = typeof item.reason === "string" ? ` · ${item.reason}` : "";
    const stage = typeof item.validation_stage === "string" ? ` · ${item.validation_stage}` : "";
    const remediation = typeof item.remediation_code === "string" ? ` · ${item.remediation_code}` : "";
    return `<li><span class="mono" data-no-i18n>${escapeHtml(id)}</span><span class="validation-tag status-pill ${statusClass(status)}">${escapeHtml(status)}</span><span class="muted font-12">${escapeHtml(`${reason}${stage}${remediation}`)}</span></li>`;
  }).join("") || `<li class="muted empty-item">${message("text.no.validation.result.has.been.reported.yet", "en")}</li>`;
  const warningRows = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<section class="detail-header">
    <div class="detail-title-group">
      <p class="eyebrow">${message("text.runner.details", "en")}</p>
      <div class="detail-title-row">
        <h1 class="detail-title"><span data-no-i18n>${escapeHtml(displayName)}</span></h1>
        ${statusBadge(state)}
      </div>
      <p class="detail-id mono"><span data-no-i18n>${escapeHtml(runnerId)}</span></p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/runners">${message("text.back.to.runners", "en")}</a>
    </div>
  </section>
  <div class="metrics" aria-label="Runner summary">
    <div class="metric">
      <span class="metric-label">${message("text.runner.version", "en")}</span>
      <strong class="metric-value mono font-16">${dataText(currentVersion)}</strong>
      <span class="metric-meta">${message("text.current", "en")}</span>
    </div>
    <div class="metric">
      <span class="metric-label">${message("text.platform", "en")}</span>
      <strong class="metric-value mono font-16">${dataText(publicInfo?.platform)}</strong>
      <span class="metric-meta">${dataText(publicInfo?.architecture)}</span>
    </div>
    <div class="metric">
      <span class="metric-label">${message("text.workspaces", "en")}</span>
      <strong class="metric-value" data-no-i18n>${workspaces.length}</strong>
      <span class="metric-meta">${message("text.policy.status", "en")} · ${escapeHtml(policyStatus)}</span>
    </div>
    <div class="metric">
      <span class="metric-label">${message("text.last.seen", "en")}</span>
      <strong class="metric-value metric-time font-16">${timeMarkup(typeof runner.last_heartbeat_ms === "number" ? runner.last_heartbeat_ms : null)}</strong>
      <span class="metric-meta">${message("text.heartbeat", "en")}</span>
    </div>
  </div>
  <div class="grid-two runner-primary-grid">
    <section class="panel runner-version-panel" id="runner-version">
      <div class="section-title">
        <h2>${message("text.runner.version", "en")}</h2>
      </div>
      <p class="muted font-12">${message("text.choose.target.version.and.update.runner.host", "en")}</p>
      ${distributionNotice}
      <div class="runner-version-summary">
        <div class="version-stat">
          <span class="form-stat-label">${message("text.current", "en")}</span>
          <strong class="mono">${dataText(currentVersion)}</strong>
        </div>
        <div class="version-stat">
          <span class="form-stat-label">${message("text.latest", "en")}</span>
          <strong class="mono">${dataText(latestVersion, "Not configured")}</strong>
        </div>
      </div>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/version-policy" class="form-grid version-policy-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <input type="hidden" name="operation_id" value="${escapeHtml(typeof runner.update_request_id === "string" ? runner.update_request_id : "")}">
        <label>Channel
          <select name="update_channel">
            <option value="stable"${updateChannel === "stable" ? " selected" : ""}>${message("runner.update.latest.environment", "en")}</option>
            <option value="pinned"${updateChannel === "pinned" ? " selected" : ""}>${message("text.pinned", "en")}</option>
          </select>
        </label>
        <label>Desired version
          <input name="desired_runner_version" value="${escapeHtml(desiredVersion)}" placeholder="1.2.3 or 1.2.3-dev.4" pattern="[0-9]+\\.[0-9]+\\.[0-9]+(-dev\\.[0-9]+)?"${updateChannel === "pinned" ? " required" : " disabled"}>
        </label>
        <div class="form-submit-wrap full-width-submit">
          <button class="button">${message("text.save.version.policy", "en")}</button>
        </div>
      </form>
      <p class="muted policy-status-foot font-12">${message("text.status.2", "en")}<span>${escapeHtml(update === null ? String(runner.update_status ?? "unknown") : updateState)}</span>${update === null ? "" : ` · <span class="mono">${escapeHtml(update.target_version)}</span>`}</p>
      ${update?.error_code === null || update === null ? "" : `<p class="warning font-12">${message(`runner.update.error.${update.error_code}`, "en")}</p>`}
    </section>
    <section class="panel runner-workspaces-panel" id="runner-workspaces">
      <div class="section-title">
        <h2>${message("text.managed.workspaces", "en")}</h2>
        <span class="muted font-12">${message("text.each.save.increments.the.desired.policy.revision", "en")}</span>
      </div>
      <ul class="plain-list workspace-list">
        ${workspaceRows}
      </ul>
      <div class="add-workspace-box">
        <div class="box-title-row">
          <h3>${message("text.add.workspace", "en")}</h3>
        </div>
        <ul class="plain-list">${managedWorkspaceForm(runnerId, undefined, csrf)}</ul>
      </div>
    </section>
  </div>
  <div class="grid-two runner-access-grid">
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.runner.permission.profile", "en")}</h2>
      </div>
      <p class="muted font-12">${message("text.changes.remain.pending.until.the.connected.runner.validates.and.applies.the.revision", "en")}</p>
      ${permissionForm(runnerId, permissions, csrf)}
      <div class="danger-zone">
        <div class="danger-header">
          <h3>${message("text.emergency.control", "en")}</h3>
        </div>
        <p class="muted font-12">${message("text.emergency.lock.does.not.automatically.stop.existing.jobs", "en")}</p>
        <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/emergency-lock" class="stack emergency-lock-form">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
          <label>Type the Runner ID to confirm emergency lock
            <input name="confirmation" pattern="${IDENTIFIER_INPUT_PATTERN}" required data-no-i18n placeholder="${escapeHtml(runnerId)}">
          </label>
          <button class="button danger">${message("text.emergency.lock.all.permissions", "en")}</button>
        </form>
      </div>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.environment.tools", "en")}</h2>
      </div>
      ${toolRows}
    </section>
  </div>
  <div class="grid-two runner-history-grid">
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.recent.shell.jobs", "en")}</h2>
      </div>
      <p class="muted">${JOBS_EXPLANATION}</p>
      ${historyControls(runnerId,view)}
      ${view.scope === "none" || view.scope === "audit" ? '<p class="muted">Jobs not loaded.</p>' : `${view.scope === "live" ? '<p class="muted">Runner live result</p>' : jobSnapshotNote()}${jobs === undefined ? '<p class="empty">Job metadata is temporarily unavailable.</p>' : historyJobTable(jobs.filter(record) as Record<string, unknown>[],runnerId,view)}` }
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.recent.mcp.calls", "en")}</h2>
      </div>
      ${view.scope === "audit" || view.scope === "all" ? (mcpCalls === undefined ? '<p class="muted">Audit history unavailable.</p>' : mcpCallTable(mcpCalls.filter(record) as Record<string, unknown>[])) : '<p class="muted">Audit not loaded.</p>'}
      ${historySettingsForm(runnerId,csrf,historySettings)}
    </section>
  </div>
  <div class="grid-two runner-enrollment-grid">
    <section class="panel">
      <div class="section-title"><h2>${message("text.runner.authorization.window", "en")}</h2><span class="badge ${runnerValidityStatus === "active" ? "online" : runnerValidityStatus === "scheduled" ? "pending" : "offline"}">${escapeHtml(runnerValidityStatus)}</span></div>
      <p class="muted font-12">${message("text.this.controls.whether.new.protected.operations.are.admitted.the.runner.may.remain.connecte", "en")}</p>
      <dl class="details"><dt>${message("text.active.from", "en")}</dt><dd class="mono">${timeMarkup(runnerFrom)}</dd><dt>${message("text.expires.at", "en")}</dt><dd class="mono">${timeMarkup(runnerUntil)}</dd></dl>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/validity" class="form-grid validity-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>${message("text.valid.days", "en")}<input type="number" name="runner_valid_days" value="${escapeHtml(validityDaysInput(runnerUntil, true))}" min="0" max="${presentation.maxValidityDays}" step="1" inputmode="numeric" required></label><p class="muted font-12 full-width-submit">${message("text.0.means.no.expiry.saving.starts.a.new.authorization.window.now", "en")}</p><div class="form-submit-wrap full-width-submit"><button class="button">${message("text.save.authorization.window", "en")}</button></div></form>
    </section>
    <section class="panel">
      <div class="section-title"><h2>${message("text.latest.enrollment.code", "en")}</h2><span class="badge ${enrollmentStatus === "active" ? "online" : enrollmentStatus === "scheduled" ? "pending" : enrollmentStatus === "expired" || enrollmentStatus === "used" ? "offline" : "invalid"}">${enrollmentStatus === "used" ? message("text.enrollment.used", "en") : escapeHtml(enrollmentStatus)}</span></div>
      <p class="muted font-12">${message("text.enrollment.single.use.help", "en")}</p>
      <dl class="details"><dt>${message("text.active.from", "en")}</dt><dd class="mono">${timeMarkup(enrollmentFrom)}</dd><dt>${message("text.expires.at", "en")}</dt><dd class="mono">${timeMarkup(enrollmentUntil)}</dd><dt>${message("text.consumed", "en")}</dt><dd class="mono">${timeMarkup(typeof enrollment?.used_at_ms === "number" ? enrollment.used_at_ms : null)}</dd></dl>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment" class="form-grid validity-form">${executionModeFormFields(executionMode ?? undefined, csrf, false)}${windowFields("code", presentation.maxValidityDays)}<div class="form-submit-wrap full-width-submit"><button class="button secondary">${message("text.generate.new.enrollment.code", "en")}</button></div></form>
    </section>
  </div>
  <div class="grid-two runner-diagnostics-grid">
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.safe.metadata", "en")}</h2>
      </div>
      <dl class="details">
        <dt>${message("text.platform", "en")}</dt>
        <dd>${dataText(publicInfo?.platform)}</dd>
        <dt>${message("text.architecture", "en")}</dt>
        <dd>${dataText(publicInfo?.architecture)}</dd>
        <dt>${message("text.hostname", "en")}</dt>
        <dd class="mono">${dataText(publicInfo?.hostname)}</dd>
        <dt>${message("text.runner.version", "en")}</dt>
        <dd class="mono">${dataText(currentVersion)}</dd>
        <dt>${message("text.runner.reported.execution.mode", "en")}</dt>
        <dd class="mono">${escapeHtml(reportedExecutionMode)}</dd>
        <dt>${message("text.service.identity", "en")}</dt>
        <dd class="mono">${dataText(serviceIdentity)}</dd>
        <dt>${message("text.runner.reported.privilege.state", "en")}</dt>
        <dd class="mono">${escapeHtml(privilegeState)}</dd>
        <dt>${message("text.stable.latest.version", "en")}</dt>
        <dd class="mono">${dataText(latestVersion, "Not configured")}</dd>
        <dt>${message("text.protocol.compatibility", "en")}</dt>
        <dd>${escapeHtml(protocolRange)} · ${escapeHtml(protocolCompatibility)}</dd>
      </dl>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.service.and.policy.diagnostics", "en")}</h2><span class="badge ${policyStatus === "applied" ? "online" : policyStatus === "invalid" ? "invalid" : "pending"}">${escapeHtml(policyStatus)}</span>
      </div>
      <dl class="details">
        <dt>${message("text.configured.execution.mode.administrator", "en")}</dt>
        <dd class="mono">${escapeHtml(executionMode ?? "not configured")}</dd>
        <dt>${message("text.desired.policy.revision", "en")}</dt>
        <dd class="mono">${escapeHtml(desiredRevision)}</dd>
        <dt>${message("text.active.applied.policy.revision", "en")}</dt>
        <dd class="mono">${escapeHtml(appliedRevision)}</dd>
        <dt>${message("text.runner.reported.revision", "en")}</dt>
        <dd class="mono">${escapeHtml(reportedRevision)}</dd>
        <dt>${message("text.desired.checksum", "en")}</dt>
        <dd class="mono">${escapeHtml(desiredChecksum)}</dd>
        <dt>${message("text.active.checksum", "en")}</dt>
        <dd class="mono">${escapeHtml(activeChecksum)}</dd>
        <dt>${message("text.runner.reported.checksum", "en")}</dt>
        <dd class="mono">${escapeHtml(reportedChecksum)}</dd>
      </dl>
      ${warningRows === "" ? "" : `<ul class="warning diagnostic-warning-list">${warningRows}</ul>`}
      <h3 class="diagnostic-subheading">${message("text.workspace.validation.status", "en")}</h3>
      <ul class="plain-list diagnostic-list">${diagnosticRows}</ul>
    </section>
  </div>`;
}
