import type { RunnerExecutionMode } from "../registry.js";
import type { HistoryView } from "../history-ui.js";
import type { JobHistorySettings } from "../job-history-settings.js";
import { historyControls, historySettingsForm } from "../history-ui.js";
import { JOBS_EXPLANATION, jobSnapshotNote } from "../admin-jobs.js";
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
  const toolRows = tools === undefined ? `<p class="muted empty-desc">Environment details unavailable while offline.</p>` : `<div class="tool-grid">${Object.entries(tools).map(([name, value]) => { const item = record(value); const isAvail = item?.available === true; return `<div class="tool-item"><div class="tool-name-row"><strong class="tool-name">${escapeHtml(name)}</strong>${isAvail ? `<span class="badge online"><span class="status-dot online"></span>Available</span>` : `<span class="badge offline"><span class="status-dot offline"></span>Unavailable</span>`}</div>${isAvail && typeof item?.version === "string" ? `<span class="tool-version mono">${escapeHtml(item.version)}</span>` : ""}</div>`; }).join("")}</div>`;
  const policyStatus = runner.policy_status === "applied" || runner.policy_status === "invalid" ? runner.policy_status : "pending";
  const workspaceRows = workspaces.map((workspace) => managedWorkspaceForm(runnerId, record(workspace), csrf)).join("") || `<li class="muted empty-item">No managed workspaces configured.</li>`;
  const updateChannel = runner.update_channel === "pinned" ? "pinned" : "stable";
  const currentVersion = typeof runner.current_runner_version === "string" ? runner.current_runner_version : typeof publicInfo?.runner_version === "string" ? publicInfo.runner_version : "Unknown";
  const latestVersion = typeof runner.latest_runner_version === "string" ? runner.latest_runner_version : release.distributable ? release.latest_version : "Not configured";
  const distributionNotice = release.distributable ? "" : `<p class="muted font-12">Hosted distribution is not configured. Portable artifact/manual version management only.</p>`;
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
  }).join("") || `<li class="muted empty-item">No validation result has been reported yet.</li>`;
  const warningRows = warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<section class="detail-header">
    <div class="detail-title-group">
      <div class="detail-title-row">
        <p class="eyebrow">Runner details</p>
        <h1 class="detail-title"><span data-no-i18n>${escapeHtml(displayName)}</span></h1>
        ${statusBadge(state)}
      </div>
      <p class="detail-id mono"><span data-no-i18n>${escapeHtml(runnerId)}</span></p>
      <p class="lede">Control-plane workspace roots appear only in this authenticated administrator view.</p>
    </div>
    <div class="detail-header-actions">
      <a class="button secondary" href="/admin/runners">Back to runners</a>
    </div>
  </section>
  <div class="metrics" aria-label="Runner summary">
    <div class="metric">
      <span class="metric-label">Execution mode</span>
      <strong class="metric-value mono font-16">${escapeHtml(executionMode ?? "not configured")}</strong>
      <span class="metric-meta">Administrator configuration</span>
    </div>
    <div class="metric">
      <span class="metric-label">Platform</span>
      <strong class="metric-value mono font-16">${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</strong>
      <span class="metric-meta">${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</span>
    </div>
    <div class="metric">
      <span class="metric-label">Policy status</span>
      <strong class="metric-value">${escapeHtml(policyStatus)} · ${escapeHtml(appliedRevision === "—" && policyStatus === "applied" ? desiredRevision : appliedRevision)} / ${escapeHtml(desiredRevision)}</strong>
      <span class="metric-meta">Revision applied / desired</span>
    </div>
    <div class="metric">
      <span class="metric-label">Last seen</span>
      <strong class="metric-value font-16">${escapeHtml(time(typeof runner.last_heartbeat_ms === "number" ? runner.last_heartbeat_ms : null))}</strong>
      <span class="metric-meta">Heartbeat</span>
    </div>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title"><h2>Runner authorization window</h2><span class="badge ${runnerValidityStatus === "active" ? "online" : runnerValidityStatus === "scheduled" ? "pending" : "offline"}">${escapeHtml(runnerValidityStatus)}</span></div>
      <p class="muted font-12">This controls whether new protected operations are admitted. The Runner may remain connected for heartbeat and recovery while scheduled or expired.</p>
      <dl class="details"><dt>Active from</dt><dd class="mono">${escapeHtml(time(runnerFrom))}</dd><dt>Expires at</dt><dd class="mono">${escapeHtml(time(runnerUntil))}</dd></dl>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/validity" class="form-grid validity-form"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Valid days<input type="number" name="runner_valid_days" value="${escapeHtml(validityDaysInput(runnerUntil, true))}" min="0" max="${presentation.maxValidityDays}" step="1" inputmode="numeric" required></label><p class="muted font-12 full-width-submit">0 means no expiry. Saving starts a new authorization window now.</p><div class="form-submit-wrap full-width-submit"><button class="button">Save authorization window</button></div></form>
    </section>
    <section class="panel">
      <div class="section-title"><h2>Latest enrollment code</h2><span class="badge ${enrollmentStatus === "active" ? "online" : enrollmentStatus === "scheduled" ? "pending" : enrollmentStatus === "expired" ? "offline" : "invalid"}">${escapeHtml(enrollmentStatus)}</span></div>
      <p class="muted font-12">Codes are single-use. Only timing metadata is retained; the code itself is never stored or shown here after this page.</p>
      <dl class="details"><dt>Active from</dt><dd class="mono">${escapeHtml(time(enrollmentFrom))}</dd><dt>Expires at</dt><dd class="mono">${escapeHtml(time(enrollmentUntil))}</dd><dt>Consumed</dt><dd class="mono">${escapeHtml(time(typeof enrollment?.used_at_ms === "number" ? enrollment.used_at_ms : null))}</dd></dl>
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment" class="form-grid validity-form">${executionModeFormFields(executionMode ?? undefined, csrf, false)}${windowFields("code", presentation.maxValidityDays)}<div class="form-submit-wrap full-width-submit"><button class="button secondary">Generate new enrollment code</button></div></form>
    </section>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>Safe metadata</h2>
      </div>
      <dl class="details">
        <dt>Platform</dt>
        <dd>${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</dd>
        <dt>Architecture</dt>
        <dd>${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</dd>
        <dt>Hostname</dt>
        <dd class="mono">${escapeHtml(typeof publicInfo?.hostname === "string" ? publicInfo.hostname : "Unknown")}</dd>
        <dt>Runner version</dt>
        <dd class="mono">${escapeHtml(currentVersion)}</dd>
        <dt>Runner-reported execution mode</dt>
        <dd class="mono">${escapeHtml(reportedExecutionMode)}</dd>
        <dt>Service identity</dt>
        <dd class="mono">${escapeHtml(serviceIdentity)}</dd>
        <dt>Runner-reported privilege state</dt>
        <dd class="mono">${escapeHtml(privilegeState)}</dd>
        <dt>Stable/latest version</dt>
        <dd class="mono">${escapeHtml(latestVersion)}</dd>
        <dt>Protocol compatibility</dt>
        <dd>${escapeHtml(protocolRange)} · ${escapeHtml(protocolCompatibility)}</dd>
      </dl>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Service and policy diagnostics</h2>
      </div>
      <dl class="details">
        <dt>Configured execution mode (administrator)</dt>
        <dd class="mono">${escapeHtml(executionMode ?? "not configured")}</dd>
        <dt>Desired policy revision</dt>
        <dd class="mono">${escapeHtml(desiredRevision)}</dd>
        <dt>Active / applied policy revision</dt>
        <dd class="mono">${escapeHtml(appliedRevision)}</dd>
        <dt>Runner reported revision</dt>
        <dd class="mono">${escapeHtml(reportedRevision)}</dd>
        <dt>Desired checksum</dt>
        <dd class="mono">${escapeHtml(desiredChecksum)}</dd>
        <dt>Active checksum</dt>
        <dd class="mono">${escapeHtml(activeChecksum)}</dd>
        <dt>Runner reported checksum</dt>
        <dd class="mono">${escapeHtml(reportedChecksum)}</dd>
      </dl>
      ${warningRows === "" ? "" : `<ul class="warning diagnostic-warning-list">${warningRows}</ul>`}
      <h3 class="diagnostic-subheading">Workspace validation status</h3>
      <ul class="plain-list diagnostic-list">${diagnosticRows}</ul>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Version policy</h2>
      </div>
      <p class="muted font-12">Policy is recorded for operators; package download, update, and rollback remain deferred.</p>
      ${distributionNotice}
      <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/version-policy" class="form-grid version-policy-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
        <label>Channel
          <select name="update_channel">
            <option value="stable"${updateChannel === "stable" ? " selected" : ""}>Stable</option>
            <option value="pinned"${updateChannel === "pinned" ? " selected" : ""}>Pinned</option>
          </select>
        </label>
        <label>Desired version
          <input name="desired_runner_version" value="${escapeHtml(desiredVersion)}" placeholder="1.2.3" pattern="[0-9]+\\.[0-9]+\\.[0-9]+">
        </label>
        <div class="version-stat">
          <span class="form-stat-label">Current</span>
          <strong class="mono">${escapeHtml(currentVersion)}</strong>
        </div>
        <div class="version-stat">
          <span class="form-stat-label">Latest</span>
          <strong class="mono">${escapeHtml(latestVersion)}</strong>
        </div>
        <div class="form-submit-wrap full-width-submit">
          <button class="button">Save version policy</button>
        </div>
      </form>
      <p class="muted policy-status-foot font-12">Status: <span class="mono">${escapeHtml(String(runner.update_status ?? "unknown"))}</span></p>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Environment tools</h2>
      </div>
      ${toolRows}
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Recent shell jobs</h2>
      </div>
      <p class="muted">${JOBS_EXPLANATION}</p>
      ${historyControls(runnerId,view)}
      ${view.scope === "none" || view.scope === "audit" ? '<p class="muted">Jobs not loaded.</p>' : `${view.scope === "live" ? '<p class="muted">Runner live result</p>' : jobSnapshotNote()}${jobs === undefined ? '<p class="empty">Job metadata is temporarily unavailable.</p>' : historyJobTable(jobs.filter(record) as Record<string, unknown>[],runnerId,view)}` }
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Recent MCP calls</h2>
      </div>
      ${view.scope === "audit" || view.scope === "all" ? (mcpCalls === undefined ? '<p class="muted">Audit history unavailable.</p>' : mcpCallTable(mcpCalls.filter(record) as Record<string, unknown>[])) : '<p class="muted">Audit not loaded.</p>'}
      ${historySettingsForm(runnerId,csrf,historySettings)}
    </section>
  </div>
  <div class="grid-two">
    <section class="panel">
      <div class="section-title">
        <h2>Runner permission profile</h2>
      </div>
      <p class="muted font-12">Changes remain pending until the connected Runner validates and applies the revision.</p>
      ${permissionForm(runnerId, permissions, csrf)}
      <div class="danger-zone">
        <div class="danger-header">
          <h3>Emergency control</h3>
        </div>
        <p class="muted font-12">Emergency Lock does not automatically stop existing Jobs.</p>
        <form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/emergency-lock" class="stack emergency-lock-form">
          <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
          <label>Type the Runner ID to confirm emergency lock
            <input name="confirmation" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" required placeholder="${escapeHtml(runnerId)}">
          </label>
          <button class="button danger">Emergency lock all permissions</button>
        </form>
      </div>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Managed workspaces</h2>
        <span class="muted font-12">Each save increments the desired policy revision.</span>
      </div>
      <ul class="plain-list workspace-list">
        ${workspaceRows}
      </ul>
      <div class="add-workspace-box">
        <div class="box-title-row">
          <h3>Add workspace</h3>
        </div>
        ${managedWorkspaceForm(runnerId, undefined, csrf)}
      </div>
    </section>
  </div>`;
}
