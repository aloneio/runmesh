import { message } from "../i18n/messages.js";
import type { RunnerExecutionMode } from "../contracts/administration.js";
import type { HistoryView } from "../history-ui.js";
import type { JobHistorySettings } from "../job-history-settings.js";
import { historyControls, historySettingsForm } from "../history-ui.js";
import { JOBS_EXPLANATION, jobSnapshotNote } from "./job-views.js";
import { validityStatus } from "../validity.js";
import { record, escapeHtml, time, shortChecksum, statusClass } from "./format.js";
import { statusBadge, historyJobTable, mcpCallTable } from "./tables.js";
import { managedWorkspaceForm, permissionForm } from "./forms.js";
import { isFullHostPath } from "./host-path-label.js";
import { executionModeFormFields, windowFields } from "./runner-fields.js";
export interface RunnerDetailPresentation {
  readonly configuredMode: RunnerExecutionMode | null;
  readonly reportedMode: RunnerExecutionMode | "unknown";
  readonly maxValidityDays: number;
  readonly dayMs: number;
}

export function runnerDetailPage(presentation: RunnerDetailPresentation, runner: Record<string, unknown>, workspaces: readonly unknown[], jobs: readonly unknown[] | undefined, environment: Record<string, unknown> | undefined, csrf: string, release: { readonly latest_version: string; readonly distributable: boolean }, policyVersions: readonly unknown[] = [], enrollment?: Record<string, unknown>, mcpCalls: readonly unknown[] | undefined = undefined, view: HistoryView = {scope:"none",limit:10}, historySettings?: JobHistorySettings): string {
  const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
  const displayName = typeof runner.display_name === "string" ? runner.display_name : runnerId;
  const state = typeof runner.state === "string" ? runner.state : "offline";
  const metadata = record(runner.metadata);
  const publicInfo = record(runner.public_info);
  const tools = record(environment?.tools);
  const toolRows = tools === undefined ? `<p class="muted empty-desc">${message("text.environment.details.unavailable.while.offline", "en")}</p>` : `<div class="tool-grid">${Object.entries(tools).map(([name, value]) => { const item = record(value); const isAvail = item?.available === true; return `<div class="tool-item"><div class="tool-name-row"><strong class="tool-name">${escapeHtml(name)}</strong>${isAvail ? `<span class="badge online"><span class="status-dot online"></span>${message("text.available", "en")}</span>` : `<span class="badge offline"><span class="status-dot offline"></span>${message("text.unavailable", "en")}</span>`}</div>${isAvail && typeof item?.version === "string" ? `<span class="tool-version mono">${escapeHtml(item.version)}</span>` : ""}</div>`; }).join("")}</div>`;
  const policyStatus = runner.policy_status === "applied" || runner.policy_status === "invalid" ? runner.policy_status : "pending";
  const workspaceRows = workspaces.map((workspace) => managedWorkspaceForm(runnerId, record(workspace), csrf)).join("") || `<li class="muted empty-item">${message("text.no.managed.workspaces.configured", "en")}</li>`;
  const updateChannel = runner.update_channel === "pinned" ? "pinned" : "stable";
  const currentVersion = typeof runner.current_runner_version === "string" ? runner.current_runner_version : typeof publicInfo?.runner_version === "string" ? publicInfo.runner_version : "Unknown";
  const latestVersion = typeof runner.latest_runner_version === "string" ? runner.latest_runner_version : release.distributable ? release.latest_version : "Not configured";
  const distributionNotice = release.distributable ? "" : `<p class="muted font-12">${message("text.hosted.distribution.is.not.configured.portable.artifact.manual.version.management.only", "en")}</p>`;
  const desiredVersion = typeof runner.desired_runner_version === "string" ? runner.desired_runner_version : "";
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
    : typeof publicInfo?.service_identity === "string" && publicInfo.service_identity.length > 0 ? publicInfo.service_identity : "Unknown";
  const reportedRevision = typeof runner.runner_reported_policy_revision === "number" ? String(runner.runner_reported_policy_revision) : "—";
  const desiredChecksum = shortChecksum(runner.desired_policy_checksum);
  const activeChecksum = shortChecksum(runner.active_policy_checksum);
  const reportedChecksum = shortChecksum(runner.runner_reported_policy_checksum);
  const runnerFrom = typeof runner.valid_from_ms === "number" ? runner.valid_from_ms : null;
  const runnerUntil = typeof runner.valid_until_ms === "number" ? runner.valid_until_ms : null;
  const runnerValidityStatus = runner.validity_status === "scheduled" || runner.validity_status === "expired" || runner.validity_status === "active" ? runner.validity_status : validityStatus({ valid_from_ms: runnerFrom, valid_until_ms: runnerUntil });
  const enrollmentFrom = typeof enrollment?.not_before_ms === "number" && enrollment.not_before_ms > 0 ? enrollment.not_before_ms : null;
  const enrollmentUntil = typeof enrollment?.expires_at_ms === "number" ? enrollment.expires_at_ms : null;
  const enrollmentStatus = enrollment === undefined ? "none" : validityStatus({ valid_from_ms: enrollmentFrom, valid_until_ms: enrollmentUntil });
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
    identityMismatch ? "Runner-reported privilege state is mismatch; verify the service identity before granting access." : "",
    executionMode === null ? "No trusted administrator execution-mode selection is recorded; choose and confirm a mode before (re)installing." : "",
    unverifiedPrivilegedReport ? "Runner reports privileged_host, but that self-report is not authorization; re-enroll only after an administrator explicitly confirms the desired mode." : "",
    executionMode === "dedicated_user" && hasFullHostWorkspace ? "dedicated_user is configured while a full-host workspace is enabled; migrate the service or narrow the workspace." : "",
    revisionLag ? "Desired policy revision is ahead of the applied or Runner-reported revision." : "",
    hasOsAccessDenial ? "Workspace validation reported os_access_denied; review the service identity and migrate to privileged_host or grant the required OS access." : "",
    configuredButNotRestarted ? "The managed service manifest changed but the Runner process was not restarted." : "",
    state === "online" && workspaceValidation.filter((item) => item.status === "valid").length === 0 ? "Runner is online but has zero valid workspaces." : "",
  ].filter(Boolean);
  const diagnosticRows = workspaceValidation.map((item) => {
    const id = typeof item.workspace_id === "string" ? item.workspace_id : "unknown";
    const status = typeof item.status === "string" ? item.status : "unknown";
    const reason = typeof item.reason === "string" ? ` · ${item.reason}` : "";
    const stage = typeof item.validation_stage === "string" ? ` · ${item.validation_stage}` : "";
    const remediation = typeof item.remediation_code === "string" ? ` · ${item.remediation_code}` : "";
    return `<li><span class="mono">${escapeHtml(id)}</span><span class="validation-tag status-pill ${statusClass(status)}">${escapeHtml(status)}</span><span class="muted font-12">${escapeHtml(`${reason}${stage}${remediation}`)}</span></li>`;
  }).join("") || `<li class="muted empty-item">${message("text.no.validation.result.has.been.reported.yet", "en")}</li>`;
  const warningRows = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<section class="detail-header">
    <div class="detail-title-group">
      <div class="detail-title-row">
        <p class="eyebrow">${message("text.runner.details", "en")}</p>
        <h1 class="detail-title"><span data-no-i18n>${escapeHtml(displayName)}</span></h1>
        ${statusBadge(state)}
      </div>
      <p class="detail-id mono"><span data-no-i18n>${escapeHtml(runnerId)}</span></p>
      <p class="lede">${message("text.control.plane.workspace.roots.appear.only.in.this.authenticated.administrator.view", "en")}</p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/runners">${message("text.back.to.runners", "en")}</a>
    </div>
  </section>
  <div class="metrics" aria-label="Runner summary">
    <div class="metric">
      <span class="metric-label">${message("text.execution.mode", "en")}</span>
      <strong class="metric-value mono font-16">${escapeHtml(executionMode ?? "not configured")}</strong>
      <span class="metric-meta">${message("text.administrator.configuration", "en")}</span>
    </div>
    <div class="metric">
      <span class="metric-label">${message("text.platform", "en")}</span>
      <strong class="metric-value mono font-16">${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</strong>
      <span class="metric-meta">${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</span>
    </div>
    <div class="metric">
      <span class="metric-label">${message("text.policy.status", "en")}</span>
      <strong class="metric-value">${escapeHtml(policyStatus)} · ${escapeHtml(appliedRevision === "—" && policyStatus === "applied" ? desiredRevision : appliedRevision)} / ${escapeHtml(desiredRevision)}</strong>
      <span class="metric-meta">${message("text.revision.applied.desired", "en")}</span>
    </div>
    <div class="metric">
      <span class="metric-label">${message("text.last.seen", "en")}</span>
      <strong class="metric-value font-16">${escapeHtml(time(typeof runner.last_heartbeat_ms === "number" ? runner.last_heartbeat_ms : null))}</strong>
      <span class="metric-meta">${message("text.heartbeat", "en")}</span>
    </div>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title"><h2>${message("text.runner.authorization.window", "en")}</h2><span class="badge ${runnerValidityStatus === "active" ? "online" : runnerValidityStatus === "scheduled" ? "pending" : "offline"}">${escapeHtml(runnerValidityStatus)}</span></div>
      <p class="muted font-12">${message("text.this.controls.whether.new.protected.operations.are.admitted.the.runner.may.remain.connecte", "en")}</p>
      <dl class="details"><dt>${message("text.active.from", "en")}</dt><dd class="mono">${escapeHtml(time(runnerFrom))}</dd><dt>${message("text.expires.at", "en")}</dt><dd class="mono">${escapeHtml(time(runnerUntil))}</dd></dl>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/validity" class="form-grid validity-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>${message("text.valid.days", "en")}<input type="number" name="runner_valid_days" value="${escapeHtml(validityDaysInput(runnerUntil, true))}" min="0" max="${presentation.maxValidityDays}" step="1" inputmode="numeric" required></label><p class="muted font-12 full-width-submit">${message("text.0.means.no.expiry.saving.starts.a.new.authorization.window.now", "en")}</p><div class="form-submit-wrap full-width-submit"><button class="button">${message("text.save.authorization.window", "en")}</button></div></form>
    </section>
    <section class="panel">
      <div class="section-title"><h2>${message("text.latest.enrollment.code", "en")}</h2><span class="badge ${enrollmentStatus === "active" ? "online" : enrollmentStatus === "scheduled" ? "pending" : enrollmentStatus === "expired" ? "offline" : "invalid"}">${escapeHtml(enrollmentStatus)}</span></div>
      <p class="muted font-12">${message("text.codes.are.single.use.only.timing.metadata.is.retained.the.code.itself.is.never.stored.or.s", "en")}</p>
      <dl class="details"><dt>${message("text.active.from", "en")}</dt><dd class="mono">${escapeHtml(time(enrollmentFrom))}</dd><dt>${message("text.expires.at", "en")}</dt><dd class="mono">${escapeHtml(time(enrollmentUntil))}</dd><dt>${message("text.consumed", "en")}</dt><dd class="mono">${escapeHtml(time(typeof enrollment?.used_at_ms === "number" ? enrollment.used_at_ms : null))}</dd></dl>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment" class="form-grid validity-form">${executionModeFormFields(executionMode ?? undefined, csrf, false)}${windowFields("code", presentation.maxValidityDays)}<div class="form-submit-wrap full-width-submit"><button class="button secondary">${message("text.generate.new.enrollment.code", "en")}</button></div></form>
    </section>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.safe.metadata", "en")}</h2>
      </div>
      <dl class="details">
        <dt>${message("text.platform", "en")}</dt>
        <dd>${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</dd>
        <dt>${message("text.architecture", "en")}</dt>
        <dd>${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</dd>
        <dt>${message("text.hostname", "en")}</dt>
        <dd class="mono">${escapeHtml(typeof publicInfo?.hostname === "string" ? publicInfo.hostname : "Unknown")}</dd>
        <dt>${message("text.runner.version", "en")}</dt>
        <dd class="mono">${escapeHtml(currentVersion)}</dd>
        <dt>${message("text.runner.reported.execution.mode", "en")}</dt>
        <dd class="mono">${escapeHtml(reportedExecutionMode)}</dd>
        <dt>${message("text.service.identity", "en")}</dt>
        <dd class="mono">${escapeHtml(serviceIdentity)}</dd>
        <dt>${message("text.runner.reported.privilege.state", "en")}</dt>
        <dd class="mono">${escapeHtml(privilegeState)}</dd>
        <dt>${message("text.stable.latest.version", "en")}</dt>
        <dd class="mono">${escapeHtml(latestVersion)}</dd>
        <dt>${message("text.protocol.compatibility", "en")}</dt>
        <dd>${escapeHtml(protocolRange)} · ${escapeHtml(protocolCompatibility)}</dd>
      </dl>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.service.and.policy.diagnostics", "en")}</h2>
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
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.version.policy", "en")}</h2>
      </div>
      <p class="muted font-12">${message("text.policy.is.recorded.for.operators.package.download.update.and.rollback.remain.deferred", "en")}</p>
      ${distributionNotice}
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/version-policy" class="form-grid version-policy-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <label>Channel
          <select name="update_channel">
            <option value="stable"${updateChannel === "stable" ? " selected" : ""}>${message("text.stable", "en")}</option>
            <option value="pinned"${updateChannel === "pinned" ? " selected" : ""}>${message("text.pinned", "en")}</option>
          </select>
        </label>
        <label>Desired version
          <input name="desired_runner_version" value="${escapeHtml(desiredVersion)}" placeholder="1.2.3" pattern="[0-9]+\\.[0-9]+\\.[0-9]+">
        </label>
        <div class="version-stat">
          <span class="form-stat-label">${message("text.current", "en")}</span>
          <strong class="mono">${escapeHtml(currentVersion)}</strong>
        </div>
        <div class="version-stat">
          <span class="form-stat-label">${message("text.latest", "en")}</span>
          <strong class="mono">${escapeHtml(latestVersion)}</strong>
        </div>
        <div class="form-submit-wrap full-width-submit">
          <button class="button">${message("text.save.version.policy", "en")}</button>
        </div>
      </form>
      <p class="muted policy-status-foot font-12">${message("text.status.2", "en")}<span class="mono">${escapeHtml(String(runner.update_status ?? "unknown"))}</span></p>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>${message("text.environment.tools", "en")}</h2>
      </div>
      ${toolRows}
    </section>
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
  <div class="grid-two">
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
            <input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required placeholder="${escapeHtml(runnerId)}">
          </label>
          <button class="button danger">${message("text.emergency.lock.all.permissions", "en")}</button>
        </form>
      </div>
    </section>
    <section class="panel">
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
        ${managedWorkspaceForm(runnerId, undefined, csrf)}
      </div>
    </section>
  </div>`;
}
