import { DEFAULT_JOB_HISTORY } from "../job-history-settings.js";
import { parseJobHistorySettings } from "../job-history-settings.js";
import type { JobHistorySettings } from "../job-history-settings.js";
import { pruneHistory } from "../history-retention.js";
import { isSafeIdentifier } from "../security.js";
import { MCP_AUDIT_RETENTION_MS } from "../audit-metadata.js";
import { projectMcpAuditMetadata } from "../audit-metadata.js";
import type { DashboardJobRecord, DashboardSnapshot, JobRow, McpCallRow } from './records.js';
import { MAX_TERMINAL_JOBS_PER_RUNNER, MAX_MCP_CALLS_PER_RUNNER } from './records.js';
import { validTransportIdentity, parseJobEvent, safeNonnegativeInteger, validMutationId } from './values.js';
import type { RegistryStorage } from './storage.js';
import type { HistoryPorts } from './ports.js';

/** History operations over a single Registry database. Construction has no I/O.
 * SQL text, arguments, transaction callbacks and await positions are retained. */
export class RegistryHistory {
  public constructor(private readonly storage: RegistryStorage, private readonly ports: HistoryPorts) {}
  public jobHistorySettings(runnerId: string, lifecycleId?: string): JobHistorySettings {
    const life = lifecycleId ?? this.ports.runnerRow(runnerId)?.lifecycle_id;
    const row = this.storage.sql.exec<{ settings_json: string }>("SELECT settings_json FROM job_history_settings WHERE runner_id=? AND lifecycle_id=?", runnerId, life ?? "").toArray()[0];
    if (row === undefined) return { ...DEFAULT_JOB_HISTORY };
    const parsed = parseJobHistorySettings(JSON.parse(row.settings_json));
    if (parsed === undefined) throw new Error("invalid stored history settings");
    return parsed;
  }

  public setJobHistorySettings(runnerId: string, value: unknown): boolean {
    const settings = parseJobHistorySettings(value), runner = this.ports.runnerRow(runnerId);
    if (settings === undefined || runner === undefined) return false;
    const json = JSON.stringify(settings);
    this.storage.sql.exec("INSERT INTO job_history_settings VALUES (?,?,?) ON CONFLICT(runner_id) DO UPDATE SET lifecycle_id=excluded.lifecycle_id,settings_json=excluded.settings_json WHERE lifecycle_id<>excluded.lifecycle_id OR settings_json<>excluded.settings_json", runnerId, runner.lifecycle_id, json);
    return true;
  }

  public syncRunner(
    runnerId: string,
    epoch: number,
    credentialVersion: number,
    _workspaces: readonly { readonly workspace_id: string }[],
    jobs: readonly { readonly job_id: string; readonly runner_id?: string | undefined; readonly updated_at_ms?: number }[],
    syncSequence: number,
    nowMs: number,
    requireOnline: boolean,
    lifecycleId: string,
    sessionId: string,
  ): boolean {
    // Keep this public method fail-closed even when called by an internal test
    // seam or a future route that bypasses RunnerSyncSchema. Unsafe numbers can
    // compare equal after IEEE-754 rounding and permanently stall sequence
    // advancement in SQLite.
    if (!safeNonnegativeInteger(epoch) || !safeNonnegativeInteger(credentialVersion) || !safeNonnegativeInteger(syncSequence) || !safeNonnegativeInteger(nowMs) || !validTransportIdentity(lifecycleId, sessionId)) return false;
    // The preflight session check is only an optimistic fast path. Keep the
    // fence and sequence comparison inside the same transaction as the
    // snapshot writes so a credential revoke/reconnect cannot race an already
    // admitted sync and then have its stale workspace/job data committed.
    try {
      const success = this.storage.transactionSync(() => {
        const current = this.ports.runnerRow(runnerId);
        if (!this.ports.runnerMatchesTransportFence(current, epoch, credentialVersion, requireOnline, lifecycleId, sessionId) || !this.ports.syncSequenceCanAdvance(current, syncSequence)) return false;
        if (this.ports.featureHealthDisabled("job_recording", nowMs)) return true;
        // A sync is an upsert of a bounded recent snapshot, never an authoritative
        // delete of job history. Older jobs remain discoverable while offline.
        for (const job of jobs) this.upsertJob(runnerId, { ...job, runner_id: runnerId }, nowMs);
        this.pruneTerminalJobs(runnerId);
        // Keep the session fence on the commit as a second line of defence. The
        // transaction-level read above normally serializes this update, but the
        // conditional write makes the invariant explicit and prevents a future
        // refactor from turning a stale snapshot into a successful sync.
        const updated = this.storage.sql.exec(
          "UPDATE runners SET last_sync_sequence = ?, updated_at_ms = ? WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ? AND lifecycle_id = ? AND session_id = ? AND (? = 0 OR state = 'online')",
          syncSequence, nowMs, runnerId, epoch, credentialVersion, lifecycleId, sessionId, requireOnline ? 1 : 0,
        );
        return updated.rowsWritten === 1;
      });
      if (success && !this.ports.featureHealthDisabled("job_recording", nowMs)) this.ports.clearFeatureHealth("job_recording");
      return success;
    } catch (error) {
      this.ports.disableFeatureHealth("job_recording", error, nowMs);
      return true;
    }
  }

  public recordJobEvent(runnerId: string, epoch: number, credentialVersion: number, message: unknown, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean {
    if (!safeNonnegativeInteger(epoch) || !safeNonnegativeInteger(credentialVersion) || !safeNonnegativeInteger(nowMs) || !validTransportIdentity(lifecycleId, sessionId)) return false;
    const event = parseJobEvent(message);
    if (event === undefined || event.job.runner_id !== runnerId) return false;
    // As with syncRunner, re-check the session fence while committing the
    // event. Otherwise an old socket can write a terminal/started event after
    // credential rotation or a newer connection has taken ownership.
    try {
      const success = this.storage.transactionSync(() => {
        const current = this.ports.runnerRow(runnerId);
        if (!this.ports.runnerMatchesTransportFence(current, epoch, credentialVersion, requireOnline, lifecycleId, sessionId)) return false;
        if (this.ports.featureHealthDisabled("job_recording", nowMs)) return true;
        this.upsertJob(runnerId, { ...event.job, runner_id: runnerId }, nowMs);
        this.pruneTerminalJobs(runnerId);
        return true;
      });
      if (success && !this.ports.featureHealthDisabled("job_recording", nowMs)) this.ports.clearFeatureHealth("job_recording");
      return success;
    } catch (error) {
      this.ports.disableFeatureHealth("job_recording", error, nowMs);
      return true;
    }
  }

  public listJobs(runnerId: string, filters: { readonly workspace_id?: string; readonly status?: string; readonly limit?: number } = {}): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 100);
    let rows: JobRow[];
    if (filters.workspace_id !== undefined && filters.status !== undefined) {
      rows = this.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.workspace_id') = ? AND json_extract(job_json, '$.status') = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, filters.workspace_id, filters.status, limit,
      ).toArray();
    } else if (filters.workspace_id !== undefined) {
      rows = this.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.workspace_id') = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, filters.workspace_id, limit,
      ).toArray();
    } else if (filters.status !== undefined) {
      rows = this.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.status') = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, filters.status, limit,
      ).toArray();
    } else {
      rows = this.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, limit,
      ).toArray();
    }
    return rows.map((row) => JSON.parse(row.job_json) as unknown);
  }

  public listMcpCalls(runnerId: string, limit = 100): unknown[] {
    const lifecycleId = this.ports.runnerRow(runnerId)?.lifecycle_id;
    if (lifecycleId === undefined) return [];
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_MCP_CALLS_PER_RUNNER);
    const rows = this.storage.sql.exec<McpCallRow>(
      // Retained audit rows outlive Runner deletion. Scope before applying the
      // limit so a replacement identity cannot see or be crowded out by them.
      "SELECT call_json FROM mcp_calls WHERE runner_id = ? AND completed_at_ms > ? AND CASE WHEN json_valid(call_json) THEN json_extract(call_json, '$.lifecycle_id') END = ? ORDER BY completed_at_ms DESC, call_id DESC LIMIT ?",
      runnerId, Date.now() - MCP_AUDIT_RETENTION_MS, lifecycleId, boundedLimit,
    ).toArray();
    return rows.flatMap((row) => {
      try { return [projectMcpAuditMetadata(JSON.parse(row.call_json))]; } catch { return []; }
    });
  }

  public dashboardSnapshot(): DashboardSnapshot {
    const runners = this.ports.listRunners().map((runner) => ({
      ...runner,
      workspace_count: Number(this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM managed_workspaces WHERE runner_id = ?", runner.runner_id).toArray()[0]?.count ?? 0),
      active_job_count: Number(this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.status') IN ('queued', 'running', 'cancelling')", runner.runner_id).toArray()[0]?.count ?? 0),
    }));
    const jobs = this.storage.sql.exec<{ runner_id: string; job_json: string; updated_at_ms: number }>("SELECT runner_id, job_json, updated_at_ms FROM jobs ORDER BY updated_at_ms DESC, job_id ASC LIMIT 20").toArray().flatMap((row): DashboardJobRecord[] => {
      try {
        const job = JSON.parse(row.job_json) as Record<string, unknown>;
        return typeof job.job_id === "string" && typeof job.workspace_id === "string" && typeof job.status === "string"
          ? [{
              runner_id: row.runner_id,
              job_id: job.job_id,
              workspace_id: job.workspace_id,
              status: job.status,
              created_by_client_id: typeof job.created_by_client_id === "string" && isSafeIdentifier(job.created_by_client_id) ? job.created_by_client_id : null,
              updated_at_ms: row.updated_at_ms,
            }]
          : [];
      } catch { return []; }
    });
    return { runners, jobs };
  }

  public getJob(runnerId: string, jobId: string): unknown | undefined { const row = this.storage.sql.exec<JobRow>("SELECT job_json FROM jobs WHERE runner_id = ? AND job_id = ?", runnerId, jobId).toArray()[0]; return row === undefined ? undefined : JSON.parse(row.job_json) as unknown; }

  public recordMcpCall(runnerId: string, epoch: number, credentialVersion: number, call: Record<string, unknown>, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string, captureAudit?: (metadata: Record<string, unknown>) => void): boolean {
    if (!safeNonnegativeInteger(epoch) || !safeNonnegativeInteger(credentialVersion) || !safeNonnegativeInteger(nowMs) || !validTransportIdentity(lifecycleId, sessionId)) return false;
    const completedAtMs = safeNonnegativeInteger(call.completed_at_ms) ? call.completed_at_ms : undefined;
    if (completedAtMs === undefined) return false;
    const callId = typeof call.call_id === "string" && validMutationId(call.call_id) ? call.call_id : undefined;
    const clientId = typeof call.client_id === "string" && isSafeIdentifier(call.client_id) ? call.client_id : undefined;
    const method = typeof call.method === "string" && call.method.length > 0 && call.method.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(call.method) ? call.method : undefined;
    const status = call.status === "ok" || call.status === "error" ? call.status : undefined;
    const startedAtMs = safeNonnegativeInteger(call.started_at_ms) ? call.started_at_ms : undefined;
    const workspaceId = call.workspace_id === undefined || call.workspace_id === null ? null : typeof call.workspace_id === "string" && isSafeIdentifier(call.workspace_id) ? call.workspace_id : undefined;
    const jobId = call.job_id === undefined || call.job_id === null ? null : typeof call.job_id === "string" && isSafeIdentifier(call.job_id) ? call.job_id : undefined;
    const resultRunnerId = call.result_runner_id === undefined || call.result_runner_id === null ? null : typeof call.result_runner_id === "string" && isSafeIdentifier(call.result_runner_id) ? call.result_runner_id : undefined;
    const errorCode = call.error_code === undefined || call.error_code === null ? null : typeof call.error_code === "string" && call.error_code.length > 0 && call.error_code.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(call.error_code) ? call.error_code : undefined;
    const expectedDurationMs = startedAtMs === undefined ? undefined : completedAtMs - startedAtMs;
    const durationMs = expectedDurationMs === undefined || !safeNonnegativeInteger(call.duration_ms) || call.duration_ms !== expectedDurationMs ? undefined : call.duration_ms;
    if (callId === undefined || clientId === undefined || method === undefined || status === undefined || startedAtMs === undefined || workspaceId === undefined || jobId === undefined || resultRunnerId === undefined || errorCode === undefined || durationMs === undefined) return false;
    try {
      const success = this.storage.transactionSync(() => {
        const current = this.ports.runnerRow(runnerId);
        if (!this.ports.runnerMatchesTransportFence(current, epoch, credentialVersion, requireOnline, lifecycleId, sessionId)) return false;
        if (this.ports.featureHealthDisabled("mcp_audit", nowMs)) return true;
        if ((method.startsWith("exec.") || method.startsWith("job.")) && !this.ports.recordsJobActivity(clientId)) return true;
        const metadata = {
            runner_id: runnerId,
            call_id: callId,
            client_id: clientId,
            method,
            workspace_id: workspaceId,
            job_id: jobId,
            status,
            error_code: errorCode,
            result_runner_id: resultRunnerId,
            started_at_ms: startedAtMs,
            completed_at_ms: completedAtMs,
            duration_ms: durationMs,
            epoch,
            credential_version: credentialVersion,
            lifecycle_id: lifecycleId,
            session_id: sessionId,
            recorded_at_ms: nowMs,
          };
        if (captureAudit !== undefined) captureAudit(metadata);
        else {
          this.storage.sql.exec(`INSERT INTO mcp_calls (runner_id, call_id, call_json, completed_at_ms) VALUES (?, ?, ?, ?)
            ON CONFLICT(runner_id, call_id) DO UPDATE SET call_json = excluded.call_json, completed_at_ms = excluded.completed_at_ms`,
            runnerId, callId, JSON.stringify(metadata), completedAtMs);
          this.pruneMcpCalls(runnerId);
        }
        return true;
      });
      if (success && captureAudit === undefined && !this.ports.featureHealthDisabled("mcp_audit", nowMs)) {
        this.ports.clearFeatureHealth("mcp_audit");
        this.ports.waitUntil(this.ports.scheduleMaintenanceAlarm(nowMs));
      }
      return success;
    } catch (error) {
      this.ports.disableFeatureHealth("mcp_audit", error, nowMs);
      return true;
    }
  }

  public pruneMcpCalls(runnerId: string): void {
    const cutoff = Date.now() - MCP_AUDIT_RETENTION_MS;
    if (this.storage.sql.exec("SELECT 1 FROM mcp_calls WHERE runner_id = ? AND completed_at_ms <= ? LIMIT 1", runnerId, cutoff).toArray().length > 0) {
      this.storage.sql.exec("DELETE FROM mcp_calls WHERE runner_id = ? AND completed_at_ms <= ?", runnerId, cutoff);
    }
    pruneHistory(this.storage.sql, "audit", runnerId, MAX_MCP_CALLS_PER_RUNNER);
  }

  public upsertJob(runnerId: string, job: Record<string, unknown>, nowMs: number): void {
    const updated = safeNonnegativeInteger(job.updated_at_ms) ? job.updated_at_ms : nowMs;
    const existing = this.getJob(runnerId, String(job.job_id));
    if (existing === undefined && typeof job.created_by_client_id === "string") {
      const client = this.ports.getMcpClient(job.created_by_client_id);
      if (client?.record_jobs === false || (client?.record_jobs_since_ms !== undefined &&
        (!safeNonnegativeInteger(job.created_at_ms) || job.created_at_ms < client.record_jobs_since_ms))) return;
    }
    const jobJson = JSON.stringify(job);
    // Lifecycle events can overtake a previously captured full snapshot. Keep
    // timestamps and lifecycle rank monotonic, including equal-ms events, and
    // never replace a committed terminal outcome with a stale active status.
    this.storage.sql.exec(`INSERT INTO jobs (runner_id, job_id, job_json, updated_at_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(runner_id, job_id) DO UPDATE SET job_json = excluded.job_json, updated_at_ms = excluded.updated_at_ms
      WHERE excluded.job_json <> jobs.job_json
        AND excluded.updated_at_ms >= jobs.updated_at_ms
        AND (CASE json_extract(excluded.job_json, '$.status') WHEN 'queued' THEN 0 WHEN 'running' THEN 1 WHEN 'cancelling' THEN 2 ELSE 3 END)
          >= (CASE json_extract(jobs.job_json, '$.status') WHEN 'queued' THEN 0 WHEN 'running' THEN 1 WHEN 'cancelling' THEN 2 ELSE 3 END)
        AND (json_extract(jobs.job_json, '$.status') NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
          OR json_extract(excluded.job_json, '$.status') = json_extract(jobs.job_json, '$.status'))`, runnerId, job.job_id, jobJson, updated);
  }

  public pruneTerminalJobs(runnerId: string): void {
    pruneHistory(this.storage.sql, "terminal_job", runnerId, MAX_TERMINAL_JOBS_PER_RUNNER);
  }
}
