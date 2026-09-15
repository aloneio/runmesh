import type { RunnerConnectionState } from "./contracts/runner-selection.js";
import type { PolicyReadiness } from "./contracts/runner-selection.js";
import type { McpClientActiveRunner } from "./contracts/runner-selection.js";
import type { McpRunnerSelectionResult } from "./contracts/runner-selection.js";
import { resolveRuntimeConfiguration } from "./runtime-config.js";
import { PackedJobHistory } from "./job-history-store.js";
import { JobHistoryUnavailableError } from "./job-history-store.js";
import { ensureJobHistorySettings } from "./job-history-settings.js";
import type { JobHistorySettings } from "./job-history-settings.js";
import { ExternalAuditHistory } from "./external-audit.js";
import { AuditHistoryUnavailableError } from "./external-audit.js";
import { controlPlaneUnavailableResponse } from "./control-plane-errors.js";
import { ensureHistoryRetentionSchema } from "./history-retention.js";
import type { JobMetadata } from "@aloneio/runmesh-protocol";
import { IdentifierSchema } from "@aloneio/runmesh-protocol";
import { RunnerMetadataSchema } from "@aloneio/runmesh-protocol";
import { RunnerSyncSchema } from "@aloneio/runmesh-protocol";
import type { RunnerMetadata } from "@aloneio/runmesh-protocol";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import { containsControlCharacter } from "./security.js";
import { isSafeIdentifier } from "./security.js";
import { verifyInternalRequest } from "./security.js";
import { readCappedText } from "./body.js";
import { ensureMetadataOnlyAudit } from "./audit-metadata.js";
import { MCP_AUDIT_RETENTION_MS } from "./audit-metadata.js";
import { projectMcpAuditMetadata } from "./audit-metadata.js";
import { ensureAuthSourceThrottleSchema } from "./auth-throttle.js";
import { validTimestamp } from "./validity.js";
import { validWindow } from "./validity.js";
import type { ValidityWindow } from "./validity.js";
import type { ValidityStatus } from "./validity.js";
import type { RunnerExecutionMode, PolicyAcknowledgementResult, RunnerMutationState, CodingScope, PermissionSet, WorkspaceValidationStatus, RunnerUpdateChannel, RunnerPublicInfo, RunnerRecord, WorkspaceRecord, DashboardSnapshot, RegistryFeatureKey, RegistryFeatureHealth, McpClientRecord, VerifiedMcpClient, RunnerRow, EnrollmentRow, FeatureHealthRow, AdminSettingsRow, AuthThrottleKind, InternalInput } from './registry/records.js';
import { MAX_INTERNAL_BODY_BYTES, MAX_SYNC_ITEMS, DEFAULT_RUNNER_ENROLLMENT_TTL_MS, REGISTRY_HISTORY_CLEANUP_INTERVAL_MS, HISTORY_CLEANUP_DEADLINE_KEY } from './registry/records.js';
import { authThrottleKind, validLifecycleId, parseTransportIdentity, matchesTransportIdentity, requestedExecutionMode, requestedExpectedExecutionMode, requestedExpectedLifecycleId, requestedPrivilegedConfirmation, requestedRunnerEnrollmentTtl, parseJobEvent, uniqueIds, parseRunnerId, parseJsonObject, stringField, integerField, nullableIntegerField, safeNonnegativeInteger, nullableChecksumField, runnerPublicInfoField, permissionSetField, workspaceStatusesField, validVerifier, validMutationId, mutationIdField, scopesField } from './registry/values.js';
import { RegistryAuth } from './registry/auth.js';
import { RegistryPolicy } from './registry/policy.js';
import { RegistryLifecycle } from './registry/lifecycle.js';
import { RegistryHistory } from './registry/history.js';
import { registryStorage } from './registry/storage.js';
export type { RunnerConnectionState, PolicyReadiness, ActiveRunnerContext, McpClientActiveRunner, McpRunnerSelectionResult } from "./contracts/runner-selection.js";
export type { RunnerExecutionMode } from './registry/records.js';
export type { PolicyAcknowledgementResult } from './registry/records.js';
export type { RunnerMutationState } from './registry/records.js';
export type { CodingScope } from './registry/records.js';
export type { PermissionBit } from './registry/records.js';
export type { PermissionSet } from './registry/records.js';
export type { RunnerProfilePreset } from './registry/records.js';
export type { WorkspaceValidationStatus } from './registry/records.js';
export type { RunnerUpdateChannel } from './registry/records.js';
export type { RunnerProtocolCompatibility } from './registry/records.js';
export type { RunnerUpdateStatus } from './registry/records.js';
export type { RunnerPublicInfo } from './registry/records.js';
export type { RunnerRecord } from './registry/records.js';
export type { WorkspaceRecord } from './registry/records.js';
export type { DashboardRunnerRecord } from './registry/records.js';
export type { DashboardJobRecord } from './registry/records.js';
export type { DashboardMcpCallRecord } from './registry/records.js';
export type { DashboardSnapshot } from './registry/records.js';
export type { RegistryFeatureKey } from './registry/records.js';
export type { RegistryFeatureHealth } from './registry/records.js';
export type { McpClientRecord } from './registry/records.js';
export type { VerifiedMcpClient } from './registry/records.js';
export { DEFAULT_RUNNER_ENROLLMENT_TTL_MS } from './registry/records.js';
export { RUNNER_ENROLLMENT_TTL_OPTIONS_MS } from './registry/records.js';
export { REGISTRY_HISTORY_CLEANUP_INTERVAL_MS } from './registry/records.js';

/** Public Registry facade: platform lifecycle, schema and existing HTTP routes.
 * Domain ports are synchronous closures, not remote RPCs or cached grants. */
export class RegistryDO {
  private readonly auth: RegistryAuth;
  private readonly policy: RegistryPolicy;
  private readonly lifecycle: RegistryLifecycle;
  private readonly history: RegistryHistory;
  private readonly featureHealth = new Map<RegistryFeatureKey, { readonly disabled_until_ms: number | null; readonly failure_count: number; readonly last_failure_at_ms: number | null; readonly last_error: string | null }>();

  private maintenanceQueue: Promise<void> = Promise.resolve();

  private readonly packedJobs: PackedJobHistory | undefined;

  private readonly externalAudit: ExternalAuditHistory | undefined;

  public constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { INTERNAL_CONTROL_SECRET?: string; RUNNER_TOKEN_PEPPER?: string; HISTORY_DB?: D1Database; RUNMESH_AUDIT_BACKEND?: string; RUNMESH_JOB_HISTORY_BACKEND?: string },
  ) {
    this.env = env = resolveRuntimeConfiguration(env);
    const storage = registryStorage(ctx.storage);
    this.auth = new RegistryAuth(storage, {
      disableFeatureHealth: (...args) => this.disableFeatureHealth(...args),
      featureHealthDisabled: (...args) => this.featureHealthDisabled(...args),
      listRunners: (...args) => this.listRunners(...args),
      runnerRow: (...args) => this.runnerRow(...args),
    });
    this.policy = new RegistryPolicy(storage, {
      getJob: (...args) => this.getJob(...args),
      getMcpClient: (...args) => this.getMcpClient(...args),
      getMcpClientActiveRunner: (...args) => this.getMcpClientActiveRunner(...args),
      getRunner: (...args) => this.getRunner(...args),
      revalidateMcpClient: (...args) => this.revalidateMcpClient(...args),
      runnerAccess: (...args) => this.runnerAccess(...args),
      runnerRow: (...args) => this.runnerRow(...args),
      sessionIsCurrent: (...args) => this.sessionIsCurrent(...args),
    }, env.RUNMESH_JOB_HISTORY_BACKEND);
    this.lifecycle = new RegistryLifecycle(storage, {
      createPolicySnapshot: (...args) => this.createPolicySnapshot(...args),
    }, env.RUNNER_TOKEN_PEPPER);
    this.history = new RegistryHistory(storage, {
      clearFeatureHealth: (...args) => this.clearFeatureHealth(...args),
      disableFeatureHealth: (...args) => this.disableFeatureHealth(...args),
      featureHealthDisabled: (...args) => this.featureHealthDisabled(...args),
      getMcpClient: (...args) => this.getMcpClient(...args),
      listRunners: (...args) => this.listRunners(...args),
      recordsJobActivity: (...args) => this.recordsJobActivity(...args),
      runnerMatchesTransportFence: (current, epoch, credentialVersion, requireOnline, lifecycleId, sessionId): current is RunnerRow => this.runnerMatchesTransportFence(current, epoch, credentialVersion, requireOnline, lifecycleId, sessionId),
      runnerRow: (...args) => this.runnerRow(...args),
      scheduleMaintenanceAlarm: (...args) => this.scheduleMaintenanceAlarm(...args),
      syncSequenceCanAdvance: (...args) => this.syncSequenceCanAdvance(...args),
      waitUntil: (...args) => this.ctx.waitUntil(...args),
    });
    this.packedJobs = env.RUNMESH_JOB_HISTORY_BACKEND === "d1" && env.HISTORY_DB !== undefined ? new PackedJobHistory(env.HISTORY_DB, ctx.id.toString()) : undefined;
    this.externalAudit = env.RUNMESH_AUDIT_BACKEND === "d1" && env.HISTORY_DB !== undefined ? new ExternalAuditHistory(env.HISTORY_DB, ctx.id.toString()) : undefined;
    this.ctx.blockConcurrencyWhile(async () => {
      // Durable Objects may be evicted and reconstructed for every request.
      // Replaying CREATE TABLE/INDEX IF NOT EXISTS on every reconstruction is
      // still counted as a SQL write on the free tier, so fast-path fully
      // initialized objects with a read-only schema check.
      if (!this.schemaIsCurrent()) {
        if (this.hasPersistedRegistrySchema()) {
          throw new Error("incompatible Registry schema: deploy this clean-break release to a fresh Durable Object namespace");
        }
        this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runners (
          runner_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_verifier TEXT NOT NULL, state TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL DEFAULT 0, credential_version INTEGER NOT NULL DEFAULT 1,
          lifecycle_id TEXT NOT NULL,
          configured_execution_mode TEXT,
          session_id TEXT, metadata_json TEXT, public_info_json TEXT, last_heartbeat_ms INTEGER, last_sync_sequence INTEGER,
          desired_policy_revision INTEGER NOT NULL DEFAULT 0, desired_policy_checksum TEXT, applied_policy_revision INTEGER, active_policy_checksum TEXT,
          runner_reported_policy_revision INTEGER, runner_reported_policy_checksum TEXT, policy_status TEXT NOT NULL DEFAULT 'pending',
          policy_error_code TEXT, policy_updated_at_ms INTEGER, policy_acked_at_ms INTEGER,
          runner_permissions_json TEXT NOT NULL DEFAULT '{"read":false,"edit":false,"shell":false,"job_control":false}',
          current_runner_version TEXT, protocol_min_version INTEGER, protocol_max_version INTEGER,
          protocol_compatibility TEXT NOT NULL DEFAULT 'unknown', update_channel TEXT NOT NULL DEFAULT 'stable',
          desired_runner_version TEXT, latest_runner_version TEXT, update_status TEXT NOT NULL DEFAULT 'unknown',
          valid_from_ms INTEGER, valid_until_ms INTEGER, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runner_policy_versions (
          runner_id TEXT NOT NULL, revision INTEGER NOT NULL, checksum TEXT NOT NULL, policy_json TEXT NOT NULL,
          status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER,
          validation_summary_json TEXT, source_revision INTEGER, mutation_id TEXT,
          PRIMARY KEY (runner_id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_runner_policy_versions_retention ON runner_policy_versions(runner_id, revision DESC);
        CREATE TABLE IF NOT EXISTS runner_mutations (
          runner_id TEXT NOT NULL, mutation_id TEXT NOT NULL, kind TEXT NOT NULL,
          pre_credential_version INTEGER NOT NULL, lifecycle_id TEXT NOT NULL,
          committed_at_ms INTEGER NOT NULL, PRIMARY KEY (runner_id, mutation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_runner_mutations_runner ON runner_mutations(runner_id);
        CREATE TABLE IF NOT EXISTS runner_policy_mutations (
          runner_id TEXT NOT NULL, mutation_id TEXT NOT NULL, kind TEXT NOT NULL,
          fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, committed_at_ms INTEGER NOT NULL,
          PRIMARY KEY (runner_id, mutation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_runner_policy_mutations_runner ON runner_policy_mutations(runner_id);
        CREATE TABLE IF NOT EXISTS managed_workspaces (
          runner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, display_name TEXT NOT NULL, root_path TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, permissions_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
          validation_status TEXT, PRIMARY KEY (runner_id, workspace_id)
        );
        CREATE TABLE IF NOT EXISTS jobs (
          runner_id TEXT NOT NULL, job_id TEXT NOT NULL, job_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL, PRIMARY KEY (runner_id, job_id)
        );
        CREATE TABLE IF NOT EXISTS mcp_calls (
          runner_id TEXT NOT NULL, call_id TEXT NOT NULL, call_json TEXT NOT NULL,
          completed_at_ms INTEGER NOT NULL, PRIMARY KEY (runner_id, call_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_calls_runner ON mcp_calls(runner_id, completed_at_ms DESC, call_id DESC);
        CREATE TABLE IF NOT EXISTS feature_health (
          feature TEXT PRIMARY KEY, disabled_until_ms INTEGER NOT NULL, failure_count INTEGER NOT NULL,
          last_failure_at_ms INTEGER NOT NULL, last_error TEXT, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1), password_verifier TEXT NOT NULL,
          session_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_throttle (
          id TEXT PRIMARY KEY CHECK (id IN ('login', 'setup')), failed_attempts INTEGER NOT NULL DEFAULT 0,
          blocked_until_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS auth_source_throttle (
          id TEXT PRIMARY KEY, failed_attempts INTEGER NOT NULL DEFAULT 0,
          blocked_until_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_auth_source_throttle_updated ON auth_source_throttle(updated_at_ms);
        CREATE TABLE IF NOT EXISTS admin_sessions (
          session_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL, session_version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_clients (
          client_id TEXT PRIMARY KEY, label TEXT NOT NULL, secret_verifier TEXT NOT NULL UNIQUE,
          secret_prefix TEXT NOT NULL, scopes_json TEXT NOT NULL, secret_version INTEGER NOT NULL DEFAULT 1,
          created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, last_used_at_ms INTEGER, revoked_at_ms INTEGER,
          active_runner_id TEXT, active_runner_updated_at_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS internal_request_nonces (
          nonce TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_internal_request_nonces_expiry ON internal_request_nonces(expires_at_ms);
        CREATE TABLE IF NOT EXISTS client_runner_overrides (
          client_id TEXT NOT NULL, runner_id TEXT NOT NULL, permissions_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (client_id, runner_id)
        );
        CREATE TABLE IF NOT EXISTS runner_enrollments (
          enrollment_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, verifier TEXT NOT NULL UNIQUE,
          created_at_ms INTEGER NOT NULL, not_before_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_runner_enrollments_expiry ON runner_enrollments(expires_at_ms);
        CREATE INDEX IF NOT EXISTS idx_runner_enrollments_runner ON runner_enrollments(runner_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_clients_secret ON mcp_clients(secret_verifier);
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at_ms);
      `);
      }
      this.loadFeatureHealth();
      // No legacy audit body is exposed, even if optional cleanup hits a quota.
      try { this.ctx.storage.transactionSync(() => { ensureMetadataOnlyAudit(this.ctx.storage.sql); ensureHistoryRetentionSchema(this.ctx.storage.sql); ensureJobHistorySettings(this.ctx.storage.sql); }); }
      catch (error) { this.disableFeatureHealth("mcp_audit", error, Date.now()); }

      // Existing v2 stores pass schemaIsCurrent and skip initial DDL. Add the
      // optional source buckets once without breaking their administrator,
      // Runner, or session data, and retain bounded fallback on quota failure.
      try { this.ctx.storage.transactionSync(() => ensureAuthSourceThrottleSchema(this.ctx.storage.sql)); }
      catch (error) { this.disableFeatureHealth("auth_throttle", error, Date.now()); }
      await this.scheduleMaintenanceAlarm(Date.now());
    });
  }

  public async alarm(): Promise<void> {
    const nowMs = Date.now();
    try { await this.runMaintenanceAlarm(nowMs); }
    catch (error) {
      this.disableFeatureHealth("maintenance_alarm", error, nowMs);
      // Avoid a tight retry burst when an account/storage backend is overloaded.
      // If even rescheduling fails, retain the platform's bounded alarm retry.
      try { await this.ctx.storage.setAlarm(nowMs + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS); }
      catch { throw error; }
    }
  }

  private async runMaintenanceAlarm(nowMs: number): Promise<void> {
    if (this.ctx.storage.sql.exec("SELECT 1 FROM mcp_calls WHERE completed_at_ms <= ? LIMIT 1", nowMs - MCP_AUDIT_RETENTION_MS).toArray().length > 0) {
      this.ctx.storage.sql.exec("DELETE FROM mcp_calls WHERE completed_at_ms <= ?", nowMs - MCP_AUDIT_RETENTION_MS);
    }
    // Reads are cheap compared with a Durable Object storage write. Avoid
    // issuing no-op UPDATE/DELETE statements on every maintenance alarm when
    // there is nothing to transition or expire.
    if (this.ctx.storage.sql.exec("SELECT 1 FROM runners WHERE state = 'online' AND (last_heartbeat_ms IS NULL OR last_heartbeat_ms < ?) LIMIT 1", nowMs - 45_000).toArray().length > 0) {
      this.ctx.storage.sql.exec(
        `UPDATE runners SET state = 'stale', updated_at_ms = ?
         WHERE state = 'online' AND (last_heartbeat_ms IS NULL OR last_heartbeat_ms < ?)`, nowMs, nowMs - 45_000,
      );
    }
    // Liveness and exact audit expiry retain their existing deadlines. Other
    // history cleanup runs at most once per 15 minutes, even across eviction.
    // Authorization checks continue enforcing expiry when each record is read.
    const nextCleanup = await this.ctx.storage.get<number>(HISTORY_CLEANUP_DEADLINE_KEY);
    if (!safeNonnegativeInteger(nextCleanup) || nextCleanup <= nowMs || nextCleanup > nowMs + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS) {
      if (this.ctx.storage.sql.exec("SELECT 1 FROM feature_health WHERE disabled_until_ms <= ? LIMIT 1", nowMs).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM feature_health WHERE disabled_until_ms <= ?", nowMs);
      if (this.ctx.storage.sql.exec("SELECT 1 FROM admin_sessions WHERE expires_at_ms <= ? LIMIT 1", nowMs).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE expires_at_ms <= ?", nowMs);
      if (this.ctx.storage.sql.exec("SELECT 1 FROM internal_request_nonces WHERE expires_at_ms <= ? LIMIT 1", nowMs).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM internal_request_nonces WHERE expires_at_ms <= ?", nowMs);
      // Keep recent expired/used metadata visible in the console; never retain raw codes.
      const enrollmentRetentionCutoff = nowMs - 30 * 24 * 60 * 60 * 1_000;
      if (this.ctx.storage.sql.exec("SELECT 1 FROM runner_enrollments WHERE expires_at_ms <= ? LIMIT 1", enrollmentRetentionCutoff).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM runner_enrollments WHERE expires_at_ms <= ?", enrollmentRetentionCutoff);
      await this.ctx.storage.put(HISTORY_CLEANUP_DEADLINE_KEY, nowMs + REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
    }
    await this.scheduleMaintenanceAlarm(nowMs);
  }

  private scheduleMaintenanceAlarm(nowMs: number): Promise<void> {
    const work = this.maintenanceQueue.then(() => this.scheduleMaintenanceAlarmNow(nowMs));
    this.maintenanceQueue = work.catch(() => undefined);
    return work;
  }

  private async scheduleMaintenanceAlarmNow(nowMs: number): Promise<void> {
    if (this.featureHealthDisabled("maintenance_alarm", nowMs)) return;
    try {
      const nextStale = this.ctx.storage.sql.exec<{ next_ms: number | null }>(
        "SELECT MIN(COALESCE(last_heartbeat_ms, 0) + 45000) AS next_ms FROM runners WHERE state = 'online'",
      ).toArray()[0]?.next_ms;
      const nextAudit = this.ctx.storage.sql.exec<{ next_ms: number | null }>(
        "SELECT MIN(completed_at_ms) + ? AS next_ms FROM mcp_calls", MCP_AUDIT_RETENTION_MS,
      ).toArray()[0]?.next_ms;
      const deadlines = [nextStale, nextAudit].filter((n): n is number => safeNonnegativeInteger(n));
      if (deadlines.length === 0) { await this.ctx.storage.deleteAlarm(); return; }
      const deadline = Math.max(nowMs + 1_000, Math.min(...deadlines));
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current <= nowMs || current > deadline) await this.ctx.storage.setAlarm(deadline);
      this.clearFeatureHealth("maintenance_alarm");
    } catch (error) { this.disableFeatureHealth("maintenance_alarm", error, nowMs); }
  }

  private loadFeatureHealth(): void {
    const nowMs = Date.now();
    try {
      for (const row of this.ctx.storage.sql.exec<FeatureHealthRow>("SELECT feature, disabled_until_ms, failure_count, last_failure_at_ms, last_error FROM feature_health").toArray()) {
        if (row.disabled_until_ms === null) continue;
        if (row.disabled_until_ms <= nowMs) continue;
        this.featureHealth.set(row.feature, row);
      }
    } catch { /* optional feature state must never make the Registry unavailable */ }
  }

  public featureHealthSnapshot(nowMs = Date.now()): RegistryFeatureHealth[] {
    const states: RegistryFeatureHealth[] = [];
    for (const [feature, state] of this.featureHealth.entries()) {
      if (state.disabled_until_ms !== null && state.disabled_until_ms <= nowMs) {
        this.featureHealth.delete(feature);
        continue;
      }
      states.push({ feature, ...state });
    }
    const external = this.externalAudit?.health(nowMs);
    if (external !== undefined && !states.some((state) => state.feature === "mcp_audit")) states.push({ feature: "mcp_audit", ...external, last_failure_at_ms: null, last_error: "External audit storage is unavailable; core authorization and execution are independent." });
    return states.sort((left, right) => left.feature.localeCompare(right.feature));
  }

  private clearFeatureHealth(feature: RegistryFeatureKey): void {
    if (!this.featureHealth.delete(feature)) return;
    try { this.ctx.storage.sql.exec("DELETE FROM feature_health WHERE feature = ?", feature); } catch { /* feature state cleanup is best-effort */ }
  }

  private runnerMatchesTransportFence(current: RunnerRow | undefined, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): current is RunnerRow {
    return current !== undefined && current.connection_epoch === epoch && current.credential_version === credentialVersion && (!requireOnline || current.state === "online") && matchesTransportIdentity(current, lifecycleId, sessionId);
  }

  private syncSequenceCanAdvance(current: RunnerRow, syncSequence: number): boolean {
    const prior = current.last_sync_sequence;
    return prior === null || prior === undefined || (safeNonnegativeInteger(prior) && syncSequence > prior);
  }

  private disableFeatureHealth(feature: RegistryFeatureKey, error: unknown, nowMs = Date.now(), cooldownMs = 15 * 60_000): void {
    const previous = this.featureHealth.get(feature);
    const failure_count = (previous?.failure_count ?? 0) + 1;
    const last_error = this.summarizeFeatureError(error);
    const disabled_until_ms = nowMs + cooldownMs;
    const state = {
      disabled_until_ms,
      failure_count,
      last_failure_at_ms: nowMs,
      last_error,
    };
    this.featureHealth.set(feature, state);
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO feature_health (feature, disabled_until_ms, failure_count, last_failure_at_ms, last_error, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feature) DO UPDATE SET disabled_until_ms = excluded.disabled_until_ms, failure_count = excluded.failure_count,
         last_failure_at_ms = excluded.last_failure_at_ms, last_error = excluded.last_error, updated_at_ms = excluded.updated_at_ms`,
        feature, state.disabled_until_ms, state.failure_count, state.last_failure_at_ms, state.last_error, nowMs,
      );
    } catch { /* in-memory breaker still prevents repeated optional writes in this DO instance */ }
    if (feature === "maintenance_alarm") void this.ctx.storage.setAlarm(Math.max(nowMs + 1_000, disabled_until_ms)).catch(() => undefined);
  }

  private summarizeFeatureError(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
    if (typeof error === "string") return error.slice(0, 240);
    try { return JSON.stringify(error).slice(0, 240); } catch { return "feature write failed"; }
  }

  private featureHealthDisabled(feature: RegistryFeatureKey, nowMs = Date.now()): boolean {
    const state = this.featureHealth.get(feature);
    if (state === undefined) return false;
    if (state.disabled_until_ms !== null && state.disabled_until_ms <= nowMs) {
      this.featureHealth.delete(feature);
      return false;
    }
    return state.disabled_until_ms !== null && state.disabled_until_ms > nowMs;
  }

  public consumeInternalNonce(nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean { return this.auth.consumeInternalNonce(nonce, expiresAtMs, nowMs); }

  private schemaIsCurrent(): boolean {
    const requiredTables = [
      "runners", "runner_policy_versions", "runner_mutations", "runner_policy_mutations",
      "managed_workspaces", "jobs", "mcp_calls", "feature_health", "admin_settings",
      "auth_throttle", "admin_sessions", "mcp_clients", "internal_request_nonces",
      "client_runner_overrides", "runner_enrollments",
    ];
    const requiredColumns: Readonly<Record<string, readonly string[]>> = {
      runners: ["token_verifier", "credential_version", "lifecycle_id", "configured_execution_mode", "desired_policy_revision", "policy_status", "runner_permissions_json", "current_runner_version", "protocol_min_version", "protocol_max_version", "protocol_compatibility", "update_channel", "desired_runner_version", "latest_runner_version", "update_status", "valid_from_ms", "valid_until_ms"],
      runner_policy_versions: ["source_revision", "mutation_id"],
      runner_mutations: ["lifecycle_id"],
      feature_health: ["disabled_until_ms", "failure_count", "last_failure_at_ms", "last_error", "updated_at_ms"],
      mcp_clients: ["active_runner_id", "active_runner_updated_at_ms"],
      runner_enrollments: ["not_before_ms"],
    };
    const tables = new Set(this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name));
    if (requiredTables.some((table) => !tables.has(table))) return false;
    return Object.entries(requiredColumns).every(([table, required]) => {
      const columns = new Set(this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name));
      return required.every((column) => columns.has(column));
    });
  }

  private hasPersistedRegistrySchema(): boolean {
    const tables = this.ctx.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).toArray().map((row) => row.name);
    return tables.length > 0;
  }

  public adminStatus(): { initialized: boolean } { return this.auth.adminStatus(); }

  public adminPasswordVerifier(): string | undefined { return this.auth.adminPasswordVerifier(); }

  public checkSourceAuthThrottle(kind: AuthThrottleKind, sourceHash: string, nowMs: number): { allowed: boolean; retry_after_ms: number } { return this.auth.checkSourceAuthThrottle(kind, sourceHash, nowMs); }

  public recordSourceAuthAttempt(kind: AuthThrottleKind, sourceHash: string, success: boolean, nowMs: number): void { return this.auth.recordSourceAuthAttempt(kind, sourceHash, success, nowMs); }

  public checkAuthThrottle(kind: AuthThrottleKind, nowMs: number): { allowed: boolean; retry_after_ms: number } { return this.auth.checkAuthThrottle(kind, nowMs); }

  public recordAuthAttempt(kind: AuthThrottleKind, success: boolean, nowMs: number): void { return this.auth.recordAuthAttempt(kind, success, nowMs); }

  public setupAdmin(passwordVerifier: string, nowMs: number): boolean { return this.auth.setupAdmin(passwordVerifier, nowMs); }

  public createAdminSession(sessionHash: string, csrfHash: string, expiresAtMs: number, nowMs: number, expectedSessionVersion: number): boolean { return this.auth.createAdminSession(sessionHash, csrfHash, expiresAtMs, nowMs, expectedSessionVersion); }

  public verifyAdminSession(sessionHash: string, nowMs: number): { csrf_hash: string } | undefined { return this.auth.verifyAdminSession(sessionHash, nowMs); }

  public logoutAdminSession(sessionHash: string): void { return this.auth.logoutAdminSession(sessionHash); }

  public changeAdminPassword(passwordVerifier: string, nowMs: number): boolean { return this.auth.changeAdminPassword(passwordVerifier, nowMs); }

  public listMcpClients(): McpClientRecord[] { return this.auth.listMcpClients(); }

  public createMcpClient(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string; scopes: readonly CodingScope[] }, nowMs: number): McpClientRecord | undefined { return this.auth.createMcpClient(input, nowMs); }

  public jobHistorySettings(runnerId: string, lifecycleId?: string): JobHistorySettings { return this.history.jobHistorySettings(runnerId, lifecycleId); }

  public setJobHistorySettings(runnerId: string, value: unknown): boolean { return this.history.setJobHistorySettings(runnerId, value); }

  private async storePackedJobs(runnerId: string, epoch: number, credentialVersion: number, lifecycle: string, session: string, jobs: readonly JobMetadata[]): Promise<Response> {
    const runner = this.runnerRow(runnerId);
    if (!this.runnerMatchesTransportFence(runner,epoch,credentialVersion,true,lifecycle,session)) return new Response("stale history session",{status:409});
    const settings = this.jobHistorySettings(runnerId,lifecycle);
    if (settings.mode === "off") return Response.json({history_status:"disabled"});
    const clients = new Map<string, McpClientRecord | undefined>();
    const eligible = jobs.filter((job) => {
      if (job.created_by_client_id === undefined) return true;
      if (!clients.has(job.created_by_client_id)) clients.set(job.created_by_client_id,this.getMcpClient(job.created_by_client_id));
      const client = clients.get(job.created_by_client_id);
      return client !== undefined && client.record_jobs !== false && job.created_at_ms >= (client.record_jobs_since_ms ?? 0);
    });
    try {
      if (this.packedJobs === undefined) throw new JobHistoryUnavailableError();
      const saved = await this.packedJobs.merge(runnerId,lifecycle,eligible,settings);
      return Response.json({history_status:saved.recorded ? "recorded" : saved.deferred ? "deferred" : "unchanged",updated_at_ms:saved.updated_at_ms});
    } catch { return Response.json({history_status:"degraded"},{status:202}); }
  }

  public setJobRecording(clientId: string, enabled: boolean, nowMs: number): McpClientRecord | undefined { return this.auth.setJobRecording(clientId, enabled, nowMs); }

  public recordsJobActivity(clientId: string): boolean { return this.auth.recordsJobActivity(clientId); }

  public updateMcpClientScopes(clientId: string, scopes: readonly CodingScope[], nowMs: number): McpClientRecord | undefined { return this.auth.updateMcpClientScopes(clientId, scopes, nowMs); }

  public renameMcpClient(clientId: string, label: string, nowMs: number): McpClientRecord | undefined { return this.auth.renameMcpClient(clientId, label, nowMs); }

  public rotateMcpClient(clientId: string, secretVerifier: string, secretPrefix: string, nowMs: number): McpClientRecord | undefined { return this.auth.rotateMcpClient(clientId, secretVerifier, secretPrefix, nowMs); }

  public revokeMcpClient(clientId: string, nowMs: number): McpClientRecord | undefined { return this.auth.revokeMcpClient(clientId, nowMs); }

  public verifyMcpClient(secretVerifier: string, nowMs: number): VerifiedMcpClient | undefined { return this.auth.verifyMcpClient(secretVerifier, nowMs); }

  public revalidateMcpClient(clientId: unknown, secretVersion: unknown): VerifiedMcpClient | undefined { return this.auth.revalidateMcpClient(clientId, secretVersion); }

  public authorizeMcpRpc(input: Record<string, unknown>): { ok: true } | { ok: false; code: string } { return this.policy.authorizeMcpRpc(input); }

  public effectiveWorkspaceList(clientId: string, runnerId: string): { runner_id: string; revision: number; checksum: string; workspaces: Array<{ workspace_id: string; enabled: boolean; permissions: PermissionSet }> } | undefined { return this.policy.effectiveWorkspaceList(clientId, runnerId); }

  public setClientRunnerOverride(clientId: string, runnerId: string, permissions: PermissionSet, nowMs: number): boolean { return this.policy.setClientRunnerOverride(clientId, runnerId, permissions, nowMs); }

  public clientRunnerPermissions(clientId: string, runnerId: string): PermissionSet | undefined { return this.policy.clientRunnerPermissions(clientId, runnerId); }

  public listClientRunnerOverrides(clientId: string): Array<{ runner_id: string; permissions: PermissionSet }> { return this.policy.listClientRunnerOverrides(clientId); }

  public deleteClientRunnerOverride(clientId: string, runnerId: string): boolean { return this.policy.deleteClientRunnerOverride(clientId, runnerId); }

  public effectivePermissions(clientId: string, runnerId: string, workspaceId: string): PermissionSet | undefined { return this.policy.effectivePermissions(clientId, runnerId, workspaceId); }

  public getSnapshotAuthorization(runnerId: string): { readonly ok: true; readonly revision: number; readonly checksum: string } | { readonly ok: false; readonly code: "policy_pending" | "stale_policy"; readonly reason: string } { return this.policy.getSnapshotAuthorization(runnerId); }

  public getDesiredPolicySnapshot(runnerId: string): RunnerPolicy | undefined { return this.policy.getDesiredPolicySnapshot(runnerId); }

  public getActivePolicySnapshot(runnerId: string): RunnerPolicy | undefined { return this.policy.getActivePolicySnapshot(runnerId); }

  public getActiveWorkspacePolicy(runnerId: string, workspaceId: string): RunnerPolicy["workspaces"][number] | undefined { return this.policy.getActiveWorkspacePolicy(runnerId, workspaceId); }

  public getPolicyReadiness(runnerId: string): PolicyReadiness { return this.policy.getPolicyReadiness(runnerId); }

  public getRunnerMutationState(runnerId: string, mutationId: string): RunnerMutationState { return this.lifecycle.getRunnerMutationState(runnerId, mutationId); }

  public getMcpClientActiveRunner(clientId: string): McpClientActiveRunner | undefined { return this.auth.getMcpClientActiveRunner(clientId); }

  public selectMcpClientRunner(clientId: string, runnerId: string, confirmSwitch: boolean, nowMs: number): McpRunnerSelectionResult { return this.auth.selectMcpClientRunner(clientId, runnerId, confirmSwitch, nowMs); }

  public resetMcpClientRunner(clientId: string, nowMs: number): McpClientActiveRunner | undefined { return this.auth.resetMcpClientRunner(clientId, nowMs); }

  public autoSelectOnlyRunner(clientId: string, nowMs: number): McpRunnerSelectionResult | undefined { return this.auth.autoSelectOnlyRunner(clientId, nowMs); }

  private desiredPolicy(runnerId: string): RunnerPolicy | undefined { return this.policy.desiredPolicy(runnerId); }

  public listPolicyVersions(runnerId: string): Array<{ runner_id: string; revision: number; checksum: string; policy_json: string; status: string; created_at_ms: number; acknowledged_at_ms: number | null; validation_summary_json: string | null; source_revision: number | null; mutation_id: string | null }> { return this.policy.listPolicyVersions(runnerId); }

  public listManagedWorkspaces(runnerId: string): WorkspaceRecord[] { return this.policy.listManagedWorkspaces(runnerId); }

  public getManagedWorkspace(runnerId: string, workspaceId: string): WorkspaceRecord | undefined { return this.policy.getManagedWorkspace(runnerId, workspaceId); }

  public createManagedWorkspace(runnerId: string, input: { workspace_id: string; display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number, mutationId?: string): WorkspaceRecord | undefined { return this.policy.createManagedWorkspace(runnerId, input, nowMs, mutationId); }

  public updateManagedWorkspace(runnerId: string, workspaceId: string, input: { display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number, mutationId?: string): WorkspaceRecord | undefined { return this.policy.updateManagedWorkspace(runnerId, workspaceId, input, nowMs, mutationId); }

  public deleteManagedWorkspace(runnerId: string, workspaceId: string, nowMs: number, mutationId?: string): boolean { return this.policy.deleteManagedWorkspace(runnerId, workspaceId, nowMs, mutationId); }

  public setRunnerPermissions(runnerId: string, permissions: PermissionSet, nowMs: number, mutationId?: string): RunnerRecord | undefined { return this.policy.setRunnerPermissions(runnerId, permissions, nowMs, mutationId); }

  public setRunnerVersionPolicy(runnerId: string, input: { update_channel: RunnerUpdateChannel; desired_runner_version?: string; latest_runner_version?: string }, nowMs: number): RunnerRecord | undefined { return this.lifecycle.setRunnerVersionPolicy(runnerId, input, nowMs); }

  public emergencyLockRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): RunnerRecord | undefined { return this.policy.emergencyLockRunner(runnerId, confirmation, nowMs, mutationId); }

  public acknowledgePolicy(runnerId: string, epoch: number, credentialVersion: number, input: { desired_revision: number; desired_checksum: string; applied_revision: number | null; applied_checksum: string | null; runner_reported_policy_revision: number | null; runner_reported_policy_checksum: string | null; status: "applied" | "pending" | "invalid"; workspace_status: readonly { workspace_id: string; status: WorkspaceValidationStatus }[] }, nowMs: number, lifecycleId: string, sessionId: string): PolicyAcknowledgementResult | undefined { return this.policy.acknowledgePolicy(runnerId, epoch, credentialVersion, input, nowMs, lifecycleId, sessionId); }

  public registerRunner(runnerId: string, tokenVerifier: string, nowMs: number, mutationId?: string, configuredExecutionMode?: RunnerExecutionMode): boolean { return this.lifecycle.registerRunner(runnerId, tokenVerifier, nowMs, mutationId, configuredExecutionMode); }

  public addRunner(runnerId: string, displayName: string, nowMs: number, mutationId?: string, configuredExecutionMode?: RunnerExecutionMode, confirmPrivilegedHost = false, validity: ValidityWindow = { valid_from_ms: null, valid_until_ms: null }): RunnerRecord | undefined { return this.lifecycle.addRunner(runnerId, displayName, nowMs, mutationId, configuredExecutionMode, confirmPrivilegedHost, validity); }

  public renameRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined { return this.lifecycle.renameRunner(runnerId, displayName, nowMs); }

  public deleteRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): boolean { return this.lifecycle.deleteRunner(runnerId, confirmation, nowMs, mutationId); }

  public createRunnerEnrollment(runnerId: string, enrollmentId: string, verifier: string, nowMs: number, configuredExecutionMode?: RunnerExecutionMode, confirmPrivilegedHost = false, expectedConfiguredExecutionMode?: RunnerExecutionMode | null, expectedLifecycleId?: string, enrollmentTtlMs = DEFAULT_RUNNER_ENROLLMENT_TTL_MS, window: { not_before_ms?: number; expires_at_ms?: number } = {}): { enrollment_id: string; runner_id: string; created_at_ms: number; not_before_ms: number; expires_at_ms: number } | undefined { return this.lifecycle.createRunnerEnrollment(runnerId, enrollmentId, verifier, nowMs, configuredExecutionMode, confirmPrivilegedHost, expectedConfiguredExecutionMode, expectedLifecycleId, enrollmentTtlMs, window); }

  public lookupRunnerEnrollment(verifier: string, nowMs: number): { runner_id: string } | undefined { return this.lifecycle.lookupRunnerEnrollment(verifier, nowMs); }

  public redeemRunnerEnrollment(verifier: string, tokenVerifier: string, publicInfo: RunnerPublicInfo, nowMs: number, mutationId?: string): Promise<{ runner_id: string } | undefined> { return this.lifecycle.redeemRunnerEnrollment(verifier, tokenVerifier, publicInfo, nowMs, mutationId); }

  public authenticateRunner(runnerId: string, token: string): Promise<{ credential_version: number } | undefined> { return this.lifecycle.authenticateRunner(runnerId, token); }

  public beginConnection(runnerId: string, metadata: RunnerMetadata, protocol: { min_protocol_version: number; max_protocol_version: number }, sessionId: string, credentialVersion: number, nowMs: number): number | undefined { return this.lifecycle.beginConnection(runnerId, metadata, protocol, sessionId, credentialVersion, nowMs); }

  public sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean { return this.lifecycle.sessionIsCurrent(runnerId, epoch, credentialVersion, requireOnline, lifecycleId, sessionId); }

  public recordHeartbeat(runnerId: string, epoch: number, credentialVersion: number, nowMs: number, lifecycleId: string, sessionId: string): boolean { return this.lifecycle.recordHeartbeat(runnerId, epoch, credentialVersion, nowMs, lifecycleId, sessionId); }

  public markDisconnected(runnerId: string, epoch: number, credentialVersion: number, state: Exclude<RunnerConnectionState, "online">, nowMs: number, lifecycleId: string, sessionId: string): void { return this.lifecycle.markDisconnected(runnerId, epoch, credentialVersion, state, nowMs, lifecycleId, sessionId); }

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
  ): boolean { return this.history.syncRunner(runnerId, epoch, credentialVersion, _workspaces, jobs, syncSequence, nowMs, requireOnline, lifecycleId, sessionId); }

  public invalidateRunnerCredential(runnerId: string, nowMs: number, mutationId?: string): boolean { return this.lifecycle.invalidateRunnerCredential(runnerId, nowMs, mutationId); }

  public revokeRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): boolean { return this.lifecycle.revokeRunner(runnerId, confirmation, nowMs, mutationId); }

  public recordJobEvent(runnerId: string, epoch: number, credentialVersion: number, message: unknown, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string): boolean { return this.history.recordJobEvent(runnerId, epoch, credentialVersion, message, nowMs, requireOnline, lifecycleId, sessionId); }

  public runnerAccess(runnerId: string, nowMs = Date.now()): { allowed: boolean; status: ValidityStatus | "missing" } { return this.lifecycle.runnerAccess(runnerId, nowMs); }

  public setRunnerValidity(runnerId: string, window: ValidityWindow, lifecycleId: string, nowMs = Date.now()): boolean { return this.lifecycle.setRunnerValidity(runnerId, window, lifecycleId, nowMs); }

  public latestRunnerEnrollment(runnerId: string): Omit<EnrollmentRow, "verifier"> | undefined { return this.lifecycle.latestRunnerEnrollment(runnerId); }

  public getRunner(runnerId: string): RunnerRecord | undefined { return this.lifecycle.getRunner(runnerId); }

  public getRunnerExecutionState(runnerId: string): { readonly runner: RunnerRecord; readonly lifecycle_id: string; readonly session_id: string | null } | undefined { return this.lifecycle.getRunnerExecutionState(runnerId); }

  public listJobs(runnerId: string, filters: { readonly workspace_id?: string; readonly status?: string; readonly limit?: number } = {}): unknown[] { return this.history.listJobs(runnerId, filters); }

  public listMcpCalls(runnerId: string, limit = 100): unknown[] { return this.history.listMcpCalls(runnerId, limit); }

  public listRunners(): RunnerRecord[] { return this.lifecycle.listRunners(); }

  public dashboardSnapshot(): DashboardSnapshot { return this.history.dashboardSnapshot(); }

  public getJob(runnerId: string, jobId: string): unknown | undefined { return this.history.getJob(runnerId, jobId); }

  public recordMcpCall(runnerId: string, epoch: number, credentialVersion: number, call: Record<string, unknown>, nowMs: number, requireOnline: boolean, lifecycleId: string, sessionId: string, captureAudit?: (metadata: Record<string, unknown>) => void): boolean { return this.history.recordMcpCall(runnerId, epoch, credentialVersion, call, nowMs, requireOnline, lifecycleId, sessionId, captureAudit); }

  public async fetch(request: Request): Promise<Response> {
    try { return await this.handleRequest(request); }
    catch { return controlPlaneUnavailableResponse(); }
  }

  private async handleRequest(request: Request): Promise<Response> {
    const rawBody = await readCappedBody(request);
    if (rawBody === undefined) return new Response("payload too large", { status: 413 });
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    // Read-only internal calls are authenticated by the short-lived HMAC
    // timestamp and do not mutate state. Persisting a nonce row for every
    // dashboard read exhausts the Durable Objects free-tier write budget.
    // Heartbeats and session probes are replay-safe as well: they are fenced by
    // the current transport identity, and heartbeats only accept monotonic
    // timestamps. They arrive for every transport frame, so writing a nonce row
    // for each one would consume the Durable Objects write budget while adding
    // no protection.
    const replaySafeHeartbeat = request.method === "POST"
      && segments.length === 3 && segments[0] === "runners" && segments[2] === "heartbeat";
    const replaySafeSession = request.method === "POST"
      && segments.length === 3 && segments[0] === "runners" && segments[2] === "session";
    const replaySafeHistory = this.env.RUNMESH_JOB_HISTORY_BACKEND === "d1" && request.method === "POST" && segments.length === 3 && segments[0] === "runners" && (segments[2] === "sync" || segments[2] === "event");
    // These endpoints only evaluate current authority. Their replies are not
    // execution capabilities: Worker and RunnerDO still revalidate before
    // dispatch. Persisting a fresh nonce for every read doubles storage work.
    // Keep timestamp/HMAC verification and all nonces for actual mutations.
    const replaySafeAuthorization = request.method === "POST" && segments.length === 3 && (
      (segments[0] === "auth" && segments[1] === "mcp" && ["verify", "revalidate", "authorize-rpc"].includes(segments[2]!))
      || (segments[0] === "runners" && segments[2] === "mcp-authorization")
    );
    const consumeNonce = request.method === "GET" || replaySafeHeartbeat || replaySafeSession || replaySafeHistory || replaySafeAuthorization
      ? () => true
      : (nonce: string, expiresAtMs: number) => this.consumeInternalNonce(nonce, expiresAtMs);
    if (!await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, rawBody, consumeNonce)) return new Response("not found", { status: 404 });
    const input = rawBody.length === 0 ? {} : parseJsonObject(rawBody);
    if (input === undefined) return Response.json({ error: "invalid JSON object" }, { status: 400 });
    const now = Date.now();
    if (request.method === "POST" && segments.length === 2 && segments[0] === "enrollments" && segments[1] === "lookup") {
      const verifier = stringField(input, "verifier", 64);
      const target = verifier === undefined ? undefined : this.lookupRunnerEnrollment(verifier, now);
      return target === undefined ? new Response("not found", { status: 404 }) : Response.json(target);
    }
    if (request.method === "POST" && segments.length === 2 && segments[0] === "enrollments" && segments[1] === "redeem") {
      const verifier = stringField(input, "verifier", 64); const tokenVerifier = stringField(input, "token_verifier", 64); const publicInfo = runnerPublicInfoField(input.runner_public_info);
      const mutationId = input.mutation_id === undefined ? undefined : mutationIdField(input);
      // Public Worker redemption must always be paired with a RunnerDO fence;
      // keeping the optional argument on the direct method only preserves old
      // unit/test callers and cannot provide a production downgrade path.
      if (mutationId === undefined) return Response.json({ error: "mutation_id is required" }, { status: 400 });
      const redeemed = verifier === undefined || tokenVerifier === undefined || publicInfo === undefined ? undefined : await this.redeemRunnerEnrollment(verifier, tokenVerifier, publicInfo, now, mutationId);
      return redeemed === undefined ? new Response("invalid enrollment", { status: 401 }) : Response.json(redeemed);
    }
    if (segments[0] === "auth") return this.handleAuth(request.method, segments.slice(1), input, now, url);
    if (request.method === "GET" && segments.length === 1 && segments[0] === "runners") return Response.json({ runners: this.listRunners() });
    if (request.method === "GET" && segments.length === 1 && segments[0] === "dashboard") return Response.json(this.dashboardSnapshot());
    if (request.method === "GET" && segments.length === 2 && segments[0] === "status" && segments[1] === "features") return Response.json({ features: this.featureHealthSnapshot(now) });
    const runnerId = segments[0] === "runners" ? parseRunnerId(segments[1]) : undefined;
    const action = segments[2]; const itemId = segments[3];
    if (runnerId === undefined || segments.length > 4) return new Response("not found", { status: 404 });
    if (action === "history-settings" && itemId === undefined) {
      if (this.runnerRow(runnerId) === undefined) return new Response("not found",{status:404});
      if (request.method === "GET") return Response.json(this.jobHistorySettings(runnerId));
      if (request.method === "POST") {
        if (!this.setJobHistorySettings(runnerId,input)) return new Response("invalid history settings",{status:400});
        const settings = this.jobHistorySettings(runnerId);
        const life = this.runnerRow(runnerId)?.lifecycle_id;
        if (this.packedJobs !== undefined && life !== undefined) {
          try { await this.packedJobs.setRetention(runnerId,life,settings.retention_days); }
          catch { return Response.json({...settings,cleanup_update:"pending_next_upload"},{status:202}); }
        }
        return Response.json(settings);
      }
    }
    if (request.method === "POST" && action === "mcp-authorization" && itemId === undefined) {
      const decision = this.authorizeMcpRpc({ ...input, runner_id: runnerId });
      return Response.json(decision, { status: decision.ok ? 200 : decision.code === "stale_policy" ? 409 : 403 });
    }
    if (request.method === "PUT" && action === undefined) {
      const tokenVerifier = stringField(input, "token_verifier", 64); const mutationId = input.mutation_id === undefined ? undefined : mutationIdField(input);
      if (tokenVerifier === undefined || !validVerifier(tokenVerifier) || (input.mutation_id !== undefined && mutationId === undefined)) return Response.json({ error: "invalid token verifier or mutation" }, { status: 400 });
      const configuredExecutionMode = requestedExecutionMode(input);
      if (configuredExecutionMode === null) return Response.json({ error: "invalid execution mode" }, { status: 400 });
      const existingRunner = this.runnerRow(runnerId);
      // A credential replacement must be fenced by RunnerDO.  The public
      // internal route is HMAC-authenticated, but an older Worker or a
      // manually replayed request must not be able to update an existing row
      // without the mutation identity that binds the Registry transaction to
      // that fence.  Creation is the only operation that may omit it.
      if (existingRunner !== undefined && mutationId === undefined) return Response.json({ error: "mutation_id is required for credential replacement" }, { status: 400 });
      return this.registerRunner(runnerId, tokenVerifier, now, mutationId, configuredExecutionMode ?? undefined)
        ? new Response(null, { status: 204 })
        : new Response("mutation conflict", { status: 409 });
    }
    if (request.method === "POST" && action === "auth") {
      const token = stringField(input, "token", 512); if (token === undefined || /\s/.test(token) || containsControlCharacter(token)) return new Response("unauthorized", { status: 401 });
      const authenticated = await this.authenticateRunner(runnerId, token); return authenticated === undefined ? new Response("unauthorized", { status: 401 }) : Response.json(authenticated);
    }
    if (request.method === "POST" && action === "connect") {
      const sessionId = stringField(input, "session_id", 128); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const metadata = RunnerMetadataSchema.safeParse(input.metadata); const protocolMin = integerField(input, "min_protocol_version"); const protocolMax = integerField(input, "max_protocol_version");
      if (!metadata.success || sessionId === undefined || credentialVersion === undefined || nowMs === undefined || protocolMin === undefined || protocolMax === undefined || protocolMin < 1 || protocolMin > protocolMax || protocolMax > 1_000) return Response.json({ error: "invalid connection metadata" }, { status: 400 });
      const epoch = this.beginConnection(runnerId, metadata.data, { min_protocol_version: protocolMin, max_protocol_version: protocolMax }, sessionId, credentialVersion, nowMs);
      const row = epoch === undefined ? undefined : this.runnerRow(runnerId);
      const policy = epoch === undefined ? undefined : this.desiredPolicy(runnerId);
      if (epoch === undefined || row === undefined || row.connection_epoch !== epoch || row.session_id !== sessionId || !validLifecycleId(row.lifecycle_id)) {
        return new Response("stale credentials", { status: 409 });
      }
      await this.scheduleMaintenanceAlarm(now);
      return Response.json({ epoch, lifecycle_id: row.lifecycle_id, desired_policy: policy, ...(this.env.RUNMESH_JOB_HISTORY_BACKEND === "d1" && metadata.data.capabilities.labels.job_history_protocol === "1" ? { job_history: this.jobHistorySettings(runnerId,row.lifecycle_id) } : {}) });
    }
    if (request.method === "POST" && action === "heartbeat") {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const identity = parseTransportIdentity(input);
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid) return Response.json({ error: "invalid heartbeat" }, { status: 400 });
      return this.recordHeartbeat(runnerId, epoch, credentialVersion, nowMs, identity.lifecycleId, identity.sessionId) ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 });
    }
    if (request.method === "POST" && action === "session") {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const identity = parseTransportIdentity(input);
      if (epoch === undefined || credentialVersion === undefined || !identity.valid) return Response.json({ error: "invalid session identity" }, { status: 400 });
      return this.sessionIsCurrent(runnerId, epoch, credentialVersion, input.require_online === true, identity.lifecycleId, identity.sessionId) ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 });
    }
    if (request.method === "POST" && action === "disconnect") {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const identity = parseTransportIdentity(input);
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || (input.state !== "offline" && input.state !== "stale") || !identity.valid) return Response.json({ error: "invalid disconnect" }, { status: 400 });
      this.markDisconnected(runnerId, epoch, credentialVersion, input.state, nowMs, identity.lifecycleId, identity.sessionId);
      // Drop a stale maintenance alarm as soon as the last online runner
      // disconnects instead of waiting for the old deadline to wake this DO.
      await this.scheduleMaintenanceAlarm(nowMs);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "sync") {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const message = RunnerSyncSchema.safeParse(input.message); const identity = parseTransportIdentity(input);
      if (!message.success || epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid || message.data.runner_id !== runnerId || message.data.workspaces.length > MAX_SYNC_ITEMS || message.data.jobs.length > MAX_SYNC_ITEMS || !uniqueIds(message.data.workspaces.map((workspace) => workspace.workspace_id)) || !uniqueIds(message.data.jobs.map((job) => job.job_id))) return Response.json({ error: "invalid sync" }, { status: 400 });
      if (this.env.RUNMESH_JOB_HISTORY_BACKEND === "d1") return this.storePackedJobs(runnerId,epoch,credentialVersion,identity.lifecycleId,identity.sessionId,message.data.jobs);
      return this.syncRunner(runnerId, epoch, credentialVersion, message.data.workspaces, message.data.jobs, message.data.sync_sequence, nowMs, true, identity.lifecycleId, identity.sessionId) ? new Response(null, { status: 204 }) : new Response("stale sync or session", { status: 409 });
    }
    if (request.method === "POST" && action === "event") {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const identity = parseTransportIdentity(input);
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid) return Response.json({ error: "invalid event identity" }, { status: 400 });
      if (this.env.RUNMESH_JOB_HISTORY_BACKEND === "d1") {
        // Old Runners emit events AND snapshots. Only the complete snapshot
        // goes to optional history; no per-event nonce, Job or audit write.
        if (parseJobEvent(input.message) === undefined) return new Response("invalid event",{status:400});
        return this.sessionIsCurrent(runnerId,epoch,credentialVersion,true,identity.lifecycleId,identity.sessionId)
          ? new Response(null,{status:204}) : new Response("stale session",{status:409});
      }
      if (!this.recordJobEvent(runnerId, epoch, credentialVersion, input.message, nowMs, true, identity.lifecycleId, identity.sessionId)) return new Response("stale session or invalid event", { status: 409 });
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "add") {
      const displayName = stringField(input, "display_name", 256); const mutationId = input.mutation_id === undefined ? undefined : mutationIdField(input);
      if (input.mutation_id !== undefined && mutationId === undefined) return Response.json({ error: "invalid mutation_id" }, { status: 400 });
      const configuredExecutionMode = requestedExecutionMode(input); const confirmation = requestedPrivilegedConfirmation(input);
      if (configuredExecutionMode === null || confirmation === null || (configuredExecutionMode === "privileged_host" && confirmation !== true)) return Response.json({ error: "invalid execution mode or privileged-host confirmation" }, { status: 400 });
      const validFrom = input.valid_from_ms === undefined || input.valid_from_ms === null ? null : validTimestamp(input.valid_from_ms) ? input.valid_from_ms : undefined;
      const validUntil = input.valid_until_ms === undefined || input.valid_until_ms === null ? null : validTimestamp(input.valid_until_ms) ? input.valid_until_ms : undefined;
      const runner = displayName === undefined || validFrom === undefined || validUntil === undefined ? undefined : this.addRunner(runnerId, displayName, now, mutationId, configuredExecutionMode, confirmation === true, { valid_from_ms: validFrom, valid_until_ms: validUntil });
      return runner === undefined ? new Response("conflict", { status: 409 }) : Response.json(runner);
    }
    if (request.method === "DELETE" && action === undefined) { const confirmation = stringField(input, "confirmation", 128); const mutationId = mutationIdField(input); return confirmation !== undefined && mutationId !== undefined && this.deleteRunner(runnerId, confirmation, now, mutationId) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 }); }
    if (request.method === "POST" && action === "rename") { const displayName = stringField(input, "display_name", 256); const runner = displayName === undefined ? undefined : this.renameRunner(runnerId, displayName, now); return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner); }
    if (request.method === "POST" && action === "enrollments") {
      const enrollmentId = stringField(input, "enrollment_id", 43); const verifier = stringField(input, "verifier", 64);
      const configuredExecutionMode = requestedExecutionMode(input); const confirmation = requestedPrivilegedConfirmation(input); const enrollmentTtlMs = requestedRunnerEnrollmentTtl(input);
      const expectedMode = requestedExpectedExecutionMode(input); const expectedLifecycleId = requestedExpectedLifecycleId(input);
      if ((input.not_before_ms !== undefined && !validTimestamp(input.not_before_ms)) || (input.expires_at_ms !== undefined && !validTimestamp(input.expires_at_ms))) return new Response("invalid enrollment dates", { status: 400 });
      const hasExpectedMode = Object.prototype.hasOwnProperty.call(input, "expected_execution_mode");
      const hasExpectedLifecycle = Object.prototype.hasOwnProperty.call(input, "expected_lifecycle_id");
      // Any internal caller that supplies a mode for an existing Runner must
      // also supply both CAS components. Requests that only create a code
      // retain the already-recorded administrator selection.
      if (configuredExecutionMode !== undefined && (!hasExpectedMode || !hasExpectedLifecycle)) return Response.json({ error: "expected runner state is required for execution-mode changes" }, { status: 409 });
      if (hasExpectedMode !== hasExpectedLifecycle || configuredExecutionMode === null || confirmation === null || (configuredExecutionMode === "privileged_host" && confirmation !== true) || expectedMode === "invalid" || expectedLifecycleId === null || enrollmentTtlMs === null) return Response.json({ error: "invalid execution mode, confirmation, expiration, or expected runner state" }, { status: 400 });
      const enrollment = enrollmentId === undefined || verifier === undefined ? undefined : this.createRunnerEnrollment(runnerId, enrollmentId, verifier, now, configuredExecutionMode, confirmation === true, expectedMode, expectedLifecycleId, enrollmentTtlMs, { ...(input.not_before_ms === undefined ? {} : { not_before_ms: input.not_before_ms as number }), ...(input.expires_at_ms === undefined ? {} : { expires_at_ms: input.expires_at_ms as number }) });
      return enrollment === undefined ? new Response("not found", { status: 404 }) : Response.json(enrollment);
    }
    if (request.method === "GET" && action === "access") return Response.json(this.runnerAccess(runnerId));
    if (request.method === "GET" && action === "enrollments") return Response.json({ enrollment: this.latestRunnerEnrollment(runnerId) ?? null });
    if (request.method === "POST" && action === "validity") {
      const window = { valid_from_ms: input.valid_from_ms, valid_until_ms: input.valid_until_ms } as ValidityWindow;
      const lifecycleId = requestedExpectedLifecycleId(input);
      if (!validWindow(window) || typeof lifecycleId !== "string") return new Response("invalid validity window", { status: 400 });
      return this.setRunnerValidity(runnerId, window, lifecycleId, now) ? new Response(null, { status: 204 }) : new Response("runner state changed", { status: 409 });
    }
    if (request.method === "POST" && action === "rotate") {
      const mutationId = mutationIdField(input);
      if (this.runnerRow(runnerId) === undefined) return new Response("not found", { status: 404 });
      if (mutationId === undefined) return Response.json({ error: "mutation_id is required" }, { status: 400 });
      return this.invalidateRunnerCredential(runnerId, now, mutationId)
        ? new Response(null, { status: 204 })
        : new Response("mutation conflict", { status: 409 });
    }
    if (request.method === "POST" && action === "revoke") {
      const confirmation = stringField(input, "confirmation", 128); const mutationId = mutationIdField(input);
      return confirmation !== undefined && confirmation === runnerId && mutationId !== undefined && this.revokeRunner(runnerId, confirmation, now, mutationId) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (request.method === "GET" && action === "mutation-state" && itemId === undefined) {
      const mutationId = url.searchParams.get("mutation_id");
      return mutationId !== null && validMutationId(mutationId) ? Response.json(this.getRunnerMutationState(runnerId, mutationId)) : Response.json({ error: "invalid mutation_id" }, { status: 400 });
    }
    if (request.method === "GET" && action === "execution-state" && itemId === undefined) {
      const state = this.getRunnerExecutionState(runnerId);
      return state === undefined ? new Response("not found", { status: 404 }) : Response.json(state);
    }
    if (request.method === "GET" && action === "active-policy" && itemId === undefined) {
      const policy = this.getActivePolicySnapshot(runnerId);
      return policy === undefined ? new Response("not found", { status: 404 }) : Response.json(policy);
    }
    if (request.method === "GET" && action === "active-workspaces" && itemId === undefined) {
      const policy = this.getActivePolicySnapshot(runnerId);
      if (policy === undefined) return new Response("not found", { status: 404 });
      return Response.json({ runner_id: runnerId, revision: policy.revision, checksum: policy.checksum, workspaces: policy.workspaces.map((workspace) => ({ workspace_id: workspace.workspace_id, enabled: workspace.enabled, permissions: workspace.permissions })) });
    }
    if (request.method === "GET" && action === "snapshot-authorization" && itemId === undefined) return Response.json(this.getSnapshotAuthorization(runnerId));
    if (request.method === "GET" && action === "policy-readiness" && itemId === undefined) {
      const readiness = this.getPolicyReadiness(runnerId);
      const runner = this.getRunner(runnerId);
      const desiredPolicyMutationId = runner === undefined ? null : this.ctx.storage.sql.exec<{ mutation_id: string | null }>("SELECT mutation_id FROM runner_policy_versions WHERE runner_id = ? AND revision = ?", runnerId, runner.desired_policy_revision).toArray()[0]?.mutation_id ?? null;
      return Response.json({ ...readiness, desired_policy_mutation_id: desiredPolicyMutationId });
    }
    if (request.method === "POST" && action === "policy-ack") {
      if (!parseTransportIdentity(input).valid) return Response.json({ error: "invalid policy acknowledgement identity" }, { status: 400 });
      const ack = this.policyAcknowledgementFromInput(runnerId, input, now);
      if (ack === undefined) return Response.json({ error: "invalid policy acknowledgement" }, { status: 409 });
      return Response.json({ ack_result: ack });
    }
    if (request.method === "GET" && action === "desired-policy" && itemId === undefined) { const policy = this.desiredPolicy(runnerId); const mutationId = policy === undefined ? undefined : this.ctx.storage.sql.exec<{ mutation_id: string | null }>("SELECT mutation_id FROM runner_policy_versions WHERE runner_id = ? AND revision = ?", runnerId, policy.revision).toArray()[0]?.mutation_id; return policy === undefined ? new Response("not found", { status: 404 }) : Response.json({ ...policy, mutation_id: mutationId ?? null }); }
    if (request.method === "GET" && action === "policy-versions" && itemId === undefined) return Response.json({ runner_id: runnerId, versions: this.listPolicyVersions(runnerId).map((version) => ({ revision: version.revision, checksum: version.checksum.slice(0, 12), status: version.status, created_at_ms: version.created_at_ms, acknowledged_at_ms: version.acknowledged_at_ms, source_revision: version.source_revision, mutation_id: version.mutation_id, validation_summary: version.validation_summary_json === null ? null : JSON.parse(version.validation_summary_json) })) });
    if (request.method === "GET" && action === "policy-revision" && itemId === undefined) { const runner = this.getRunner(runnerId); const mutationId = runner === undefined ? undefined : this.ctx.storage.sql.exec<{ mutation_id: string | null }>("SELECT mutation_id FROM runner_policy_versions WHERE runner_id = ? AND revision = ?", runnerId, runner.desired_policy_revision).toArray()[0]?.mutation_id; return runner === undefined ? new Response("not found", { status: 404 }) : Response.json({ desired_policy_revision: runner.desired_policy_revision, desired_policy_checksum: runner.desired_policy_checksum, desired_policy_mutation_id: mutationId ?? null, applied_policy_revision: runner.applied_policy_revision, active_policy_checksum: runner.active_policy_checksum, runner_reported_policy_revision: runner.runner_reported_policy_revision, runner_reported_policy_checksum: runner.runner_reported_policy_checksum, policy_status: runner.policy_status }); }
    if (request.method === "GET" && action === "jobs" && itemId === undefined) {
      const workspaceId = url.searchParams.get("workspace_id") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;
      if ((workspaceId !== undefined && !IdentifierSchema.safeParse(workspaceId).success) || (status !== undefined && !["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"].includes(status)) || (rawLimit !== null && (limit === undefined || limit < 1 || limit > 100))) return Response.json({ error: "invalid job filters" }, { status: 400 });
      if (this.env.RUNMESH_JOB_HISTORY_BACKEND === "d1") {
        const current = this.runnerRow(runnerId);
        if (current === undefined) return new Response("not found",{status:404});
        try {
          if (this.packedJobs === undefined) throw new JobHistoryUnavailableError();
          const result = await this.packedJobs.list(runnerId,current.lifecycle_id,this.jobHistorySettings(runnerId,current.lifecycle_id),{ ...(workspaceId === undefined ? {} : {workspace_id:workspaceId}), ...(status === undefined ? {} : {status}), ...(limit === undefined ? {} : {limit}) });
          if (this.runnerRow(runnerId)?.lifecycle_id !== current.lifecycle_id) return new Response("history identity changed",{status:409});
          return Response.json({runner_id:runnerId,source:"packed_d1_snapshot",...result});
        } catch { return Response.json({error:{code:"job_history_unavailable",message:"Job history is unavailable; query the online Runner with workspace_id."}},{status:503,headers:{"cache-control":"no-store","retry-after":"900"}}); }
      }
      return Response.json({ runner_id: runnerId, jobs: this.listJobs(runnerId, { ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }), ...(status === undefined ? {} : { status }), ...(limit === undefined ? {} : { limit }) }) });
    }
    if (request.method === "GET" && action === "mcp-calls" && itemId === undefined) {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;
      if (rawLimit !== null && (limit === undefined || limit < 1 || limit > 100)) return Response.json({ error: "invalid MCP call filters" }, { status: 400 });
      if (this.env.RUNMESH_AUDIT_BACKEND === "d1") {
        const current = this.runnerRow(runnerId);
        if (current === undefined) return new Response("not found", { status: 404 });
        try {
          if (this.externalAudit === undefined) throw new AuditHistoryUnavailableError();
          const external = await this.externalAudit.list(runnerId, current.lifecycle_id, limit);
          if (this.runnerRow(runnerId)?.lifecycle_id !== current.lifecycle_id) return new Response("Runner identity changed", { status: 409 });
          // Previously recorded DO rows retain their normal retention period.
          // No fallback is used when D1 fails: an empty success would lie.
          const combined = [...this.listMcpCalls(runnerId, limit).map(projectMcpAuditMetadata), ...external];
          const unique = [...new Map(combined.map((row) => [String(row.call_id), row])).values()];
          unique.sort((a, b) => Number(b.completed_at_ms) - Number(a.completed_at_ms) || String(b.call_id).localeCompare(String(a.call_id)));
          return Response.json({ runner_id: runnerId, history_backend: "d1", calls: unique.slice(0, limit ?? 100) });
        } catch { return Response.json({ error: { code: "audit_history_unavailable", message: "Cloud audit history is temporarily unavailable; this does not undo execution." } }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "900" } }); }
      }
      return Response.json({ runner_id: runnerId, calls: this.listMcpCalls(runnerId, limit) });
    }
    if (request.method === "POST" && action === "mcp-calls" && itemId === undefined) {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const identity = parseTransportIdentity(input);
      const callId = stringField(input, "call_id", 128);
      const clientId = stringField(input, "client_id", 128);
      const methodName = stringField(input, "method", 128);
      const status = input.status === "ok" || input.status === "error" ? input.status : undefined;
      const startedAtMs = integerField(input, "started_at_ms");
      const completedAtMs = integerField(input, "completed_at_ms");
      const durationMs = integerField(input, "duration_ms");
      const errorCode = input.error_code === undefined || input.error_code === null ? null : stringField(input, "error_code", 128);
      const workspaceId = input.workspace_id === undefined || input.workspace_id === null ? null : stringField(input, "workspace_id", 128);
      const jobId = input.job_id === undefined || input.job_id === null ? null : stringField(input, "job_id", 128);
      if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !identity.valid || callId === undefined || !validMutationId(callId) || clientId === undefined || methodName === undefined || status === undefined || startedAtMs === undefined || completedAtMs === undefined || durationMs === undefined || (errorCode === null ? false : errorCode === undefined) || (workspaceId === null ? false : workspaceId === undefined) || (jobId === null ? false : jobId === undefined)) return Response.json({ error: "invalid MCP call" }, { status: 400 });
      if (completedAtMs - startedAtMs !== durationMs) return Response.json({ error: "invalid MCP call duration" }, { status: 400 });
      const wasDegraded = this.featureHealthDisabled("mcp_audit", nowMs);
      let captured: Record<string, unknown> | undefined;
      const capture = this.env.RUNMESH_AUDIT_BACKEND === "d1" ? (metadata: Record<string, unknown>) => { captured = metadata; } : undefined;
      const accepted = this.recordMcpCall(runnerId, epoch, credentialVersion, {
        call_id: callId,
        client_id: clientId,
        method: methodName,
        workspace_id: workspaceId,
        job_id: jobId,
        result_runner_id: input.result_runner_id ?? null,
        status,
        error_code: errorCode,
        started_at_ms: startedAtMs,
        completed_at_ms: completedAtMs,
        duration_ms: durationMs,
      }, nowMs, false, identity.lifecycleId, identity.sessionId, capture);
      if (!accepted) return new Response("stale session or invalid MCP call", { status: 409 });
      const disabled = (methodName.startsWith("exec.") || methodName.startsWith("job.")) && !this.recordsJobActivity(clientId);
      const externalSaved = capture === undefined || (!disabled && captured !== undefined && await this.externalAudit?.append(captured) === true);
      const auditStatus = disabled ? "disabled" : !externalSaved || wasDegraded || this.featureHealthDisabled("mcp_audit", nowMs) ? "degraded" : "recorded";
      return Response.json({ audit_status: auditStatus }, { status: auditStatus === "recorded" ? 200 : 202 });
    }
    if (request.method === "GET" && action === "jobs" && itemId !== undefined && IdentifierSchema.safeParse(itemId).success) {
      const current = this.runnerRow(runnerId);
      if (current === undefined) return new Response("not found",{status:404});
      let job: unknown;
      if (this.env.RUNMESH_JOB_HISTORY_BACKEND === "d1") {
        if (this.packedJobs === undefined) return controlPlaneUnavailableResponse();
        try { job = await this.packedJobs.get(runnerId,current.lifecycle_id,itemId,this.jobHistorySettings(runnerId,current.lifecycle_id)); }
        catch { return Response.json({error:{code:"job_history_unavailable"}},{status:503}); }
        if (this.runnerRow(runnerId)?.lifecycle_id !== current.lifecycle_id) return new Response("history identity changed",{status:409});
      } else job = this.getJob(runnerId,itemId);
      return job === undefined ? Response.json({error:"job not yet archived; use workspace_id for live access"},{status:404}) : Response.json(job);
    }
    if (request.method === "GET" && action === undefined && itemId === undefined) { const runner = this.getRunner(runnerId); return runner === undefined ? Response.json({ error: "runner not found" }, { status: 404 }) : Response.json(runner); }
    return new Response("not found", { status: 404 });
  }

  private policyAcknowledgementFromInput(runnerId: string, input: InternalInput, nowMs: number): PolicyAcknowledgementResult | undefined {
    const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const desiredRevision = integerField(input, "desired_revision"); const desiredChecksum = stringField(input, "desired_checksum", 64); const appliedRevision = nullableIntegerField(input, "applied_revision"); const appliedChecksum = nullableChecksumField(input, "applied_checksum"); const reportedRevision = nullableIntegerField(input, "runner_reported_policy_revision"); const reportedChecksum = nullableChecksumField(input, "runner_reported_policy_checksum"); const status = input.status; const statuses = workspaceStatusesField(input.workspace_status); const identity = parseTransportIdentity(input);
    if (epoch === undefined || credentialVersion === undefined || desiredRevision === undefined || desiredChecksum === undefined || appliedRevision === undefined || appliedChecksum === undefined || reportedRevision === undefined || reportedChecksum === undefined || (status !== "applied" && status !== "pending" && status !== "invalid") || statuses === undefined || !identity.valid) return undefined;
    return this.acknowledgePolicy(runnerId, epoch, credentialVersion, { desired_revision: desiredRevision, desired_checksum: desiredChecksum, applied_revision: appliedRevision, applied_checksum: appliedChecksum, runner_reported_policy_revision: reportedRevision, runner_reported_policy_checksum: reportedChecksum, status, workspace_status: statuses }, nowMs, identity.lifecycleId, identity.sessionId);
  }

  private async handleAuth(method: string, segments: string[], input: InternalInput, nowMs: number, url: URL): Promise<Response> {
    const action = segments[0]; const clientId = segments[1];
    if (method === "POST" && action === "internal-nonces" && clientId === undefined) {
      const nonce = stringField(input, "nonce", 64); const expiresAtMs = integerField(input, "expires_at_ms");
      return nonce === undefined || expiresAtMs === undefined || !this.consumeInternalNonce(nonce, expiresAtMs, nowMs)
        ? new Response("not found", { status: 404 })
        : new Response(null, { status: 204 });
    }
    if (method === "GET" && action === "status" && clientId === undefined) return Response.json(this.adminStatus());
    if (method === "GET" && action === "settings" && clientId === undefined) { const settings = this.settings(); return settings === undefined ? new Response("not found", { status: 404 }) : Response.json({ password_verifier: settings.password_verifier, session_version: settings.session_version }); }
    if (method === "POST" && action === "setup" && clientId === undefined) { const verifier = stringField(input, "password_verifier", 4_096); return verifier === undefined ? Response.json({ error: "invalid verifier" }, { status: 400 }) : this.setupAdmin(verifier, nowMs) ? new Response(null, { status: 204 }) : new Response("already initialized", { status: 409 }); }
    if (method === "POST" && action === "throttle" && clientId === "check") {
      const kind = authThrottleKind(input.kind);
      const sourceHash = stringField(input, "source_hash", 64);
      return kind === undefined || sourceHash === undefined || !validVerifier(sourceHash) ? Response.json({ error: "invalid throttle source" }, { status: 400 }) : Response.json(this.checkSourceAuthThrottle(kind, sourceHash, nowMs));
    }
    if (method === "POST" && action === "throttle" && clientId === "record") {
      const kind = authThrottleKind(input.kind);
      const sourceHash = stringField(input, "source_hash", 64);
      if (kind === undefined || sourceHash === undefined || !validVerifier(sourceHash) || typeof input.success !== "boolean") return Response.json({ error: "invalid throttle record" }, { status: 400 });
      this.recordSourceAuthAttempt(kind, sourceHash, input.success, nowMs);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && action === "sessions" && clientId === undefined) {
      const sessionHash = stringField(input, "session_hash", 64); const csrfHash = stringField(input, "csrf_hash", 64);
      const expires = integerField(input, "expires_at_ms"); const expectedVersion = integerField(input, "expected_session_version");
      if (sessionHash === undefined || csrfHash === undefined || expires === undefined || expectedVersion === undefined || expectedVersion < 1 || !validVerifier(sessionHash) || !validVerifier(csrfHash) || expires <= nowMs) return Response.json({ error: "invalid session" }, { status: 400 });
      return this.createAdminSession(sessionHash, csrfHash, expires, nowMs, expectedVersion)
        ? new Response(null, { status: 204 }) : new Response("authentication generation changed", { status: 409 });
    }
    if (method === "POST" && action === "sessions" && clientId === "verify") { const sessionHash = stringField(input, "session_hash", 64); if (sessionHash === undefined || !validVerifier(sessionHash)) return new Response("not found", { status: 404 }); const session = this.verifyAdminSession(sessionHash, nowMs); return session === undefined ? new Response("not found", { status: 404 }) : Response.json(session); }
    if (method === "POST" && action === "sessions" && clientId === "logout") { const sessionHash = stringField(input, "session_hash", 64); if (sessionHash !== undefined && validVerifier(sessionHash)) this.logoutAdminSession(sessionHash); return new Response(null, { status: 204 }); }
    if (method === "POST" && action === "password" && clientId === undefined) { const verifier = stringField(input, "password_verifier", 4_096); return verifier === undefined ? Response.json({ error: "invalid verifier" }, { status: 400 }) : this.changeAdminPassword(verifier, nowMs) ? new Response(null, { status: 204 }) : new Response("not initialized", { status: 409 }); }
    if (method === "GET" && action === "clients" && clientId === undefined) return Response.json({ clients: this.listMcpClients() });
    if (method === "POST" && action === "clients" && clientId === undefined) { const id = stringField(input, "client_id", 128); const label = stringField(input, "label", 256); const verifier = stringField(input, "secret_verifier", 64); const prefix = stringField(input, "secret_prefix", 16); const scopes = scopesField(input.scopes); if (id === undefined || label === undefined || verifier === undefined || prefix === undefined || scopes === undefined) return Response.json({ error: "invalid client" }, { status: 400 }); const client = this.createMcpClient({ client_id: id, label, secret_verifier: verifier, secret_prefix: prefix, scopes }, nowMs); return client === undefined ? new Response("conflict", { status: 409 }) : Response.json(client); }
    if (action === "clients" && clientId !== undefined && isSafeIdentifier(clientId)) {
      const subaction = segments[2];
      if (method === "POST" && subaction === "recording") {
        if (typeof input.record_jobs !== "boolean") return Response.json({ error: "record_jobs must be boolean" }, { status: 400 });
        const client = this.setJobRecording(clientId, input.record_jobs, nowMs);
        return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client);
      }
      if (method === "POST" && subaction === "rename") { const label = stringField(input, "label", 256); const client = label === undefined ? undefined : this.renameMcpClient(clientId, label, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "rotate") { const verifier = stringField(input, "secret_verifier", 64); const prefix = stringField(input, "secret_prefix", 16); const client = verifier === undefined || prefix === undefined ? undefined : this.rotateMcpClient(clientId, verifier, prefix, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "revoke") { const client = this.revokeMcpClient(clientId, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "scopes") { const scopes = scopesField(input.scopes); const client = scopes === undefined ? undefined : this.updateMcpClientScopes(clientId, scopes, nowMs); return client === undefined ? new Response("invalid client scopes", { status: this.getMcpClient(clientId) === undefined ? 404 : 400 }) : Response.json(client); }
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "runner-overrides" && segments[3] === undefined) {
      return this.getMcpClient(clientId) === undefined ? new Response("not found", { status: 404 }) : Response.json({ client_id: clientId, overrides: this.listClientRunnerOverrides(clientId) });
    }
    if (method === "DELETE" && action === "clients" && clientId !== undefined && segments[2] === "runner-overrides" && segments[3] !== undefined && isSafeIdentifier(segments[3])) {
      return this.deleteClientRunnerOverride(clientId, segments[3]) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "runner-overrides" && segments[3] !== undefined && isSafeIdentifier(segments[3])) {
      const permissions = permissionSetField(input.permissions);
      return permissions !== undefined && this.setClientRunnerOverride(clientId, segments[3], permissions, nowMs) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "effective-permissions" && segments[3] !== undefined && isSafeIdentifier(segments[3])) {
      const workspaceId = url.searchParams.get("workspace_id");
      const permissions = workspaceId === null ? undefined : this.effectivePermissions(clientId, segments[3], workspaceId);
      return permissions === undefined ? new Response("not found", { status: 404 }) : Response.json({ permissions });
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "active-runner") {
      const selection = this.getMcpClientActiveRunner(clientId);
      return selection === undefined ? new Response("not found", { status: 404 }) : Response.json(selection);
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "active-runner" && segments[3] === "reset") {
      const selection = this.resetMcpClientRunner(clientId, nowMs);
      return selection === undefined ? new Response("not found", { status: 404 }) : Response.json(selection);
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "active-runner") {
      const runnerId = stringField(input, "runner_id", 128);
      const confirmSwitch = input.confirm_switch === true;
      if (runnerId === undefined) return Response.json({ error: "invalid runner" }, { status: 400 });
      const result = this.selectMcpClientRunner(clientId, runnerId, confirmSwitch, nowMs);
      return result.ok ? Response.json(result) : (result.code === "runner_switch_confirmation_required" || result.code === "runner_unavailable") ? Response.json(result, { status: 409 }) : new Response("not found", { status: 404 });
    }
    if (method === "POST" && action === "clients" && clientId !== undefined && segments[2] === "auto-select-runner") {
      const result = this.autoSelectOnlyRunner(clientId, nowMs);
      return result === undefined ? Response.json({ code: "runner_not_selected" }, { status: 409 }) : result.ok ? Response.json(result) : new Response("not found", { status: 404 });
    }
    if (method === "GET" && action === "runners" && clientId !== undefined && segments[2] === "managed-workspaces" && segments[3] === undefined) {
      if (!isSafeIdentifier(clientId)) return new Response("not found", { status: 404 });
      return this.runnerRow(clientId) === undefined
        ? new Response("not found", { status: 404 })
        : Response.json({ runner_id: clientId, workspaces: this.listManagedWorkspaces(clientId) });
    }
    if (method === "GET" && action === "runners" && clientId !== undefined && segments[2] === "enrollments" && segments[3] === undefined) {
      return !isSafeIdentifier(clientId) || this.runnerRow(clientId) === undefined ? new Response("not found", { status: 404 }) : Response.json({ enrollment: this.latestRunnerEnrollment(clientId) ?? null });
    }
    if (method === "GET" && action === "runners" && clientId !== undefined && segments[2] === "access" && segments[3] === undefined) {
      return !isSafeIdentifier(clientId) ? new Response("not found", { status: 404 }) : Response.json(this.runnerAccess(clientId));
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "validity" && segments[3] === undefined) {
      if (!isSafeIdentifier(clientId)) return new Response("not found", { status: 404 });
      const window = { valid_from_ms: input.valid_from_ms, valid_until_ms: input.valid_until_ms } as ValidityWindow;
      const lifecycleId = requestedExpectedLifecycleId(input);
      if (!validWindow(window) || typeof lifecycleId !== "string") return new Response("invalid validity window", { status: 400 });
      return this.setRunnerValidity(clientId, window, lifecycleId, nowMs) ? new Response(null, { status: 204 }) : new Response("runner state changed", { status: 409 });
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "managed-workspaces" && segments[3] === undefined) {
      if (!isSafeIdentifier(clientId)) return new Response("not found", { status: 404 });
      const workspaceId = stringField(input, "workspace_id", 128); const displayName = stringField(input, "display_name", 256); const rootPath = stringField(input, "root_path", 4_096); const permissions = permissionSetField(input.permissions); const mutationId = mutationIdField(input);
      if (workspaceId === undefined || displayName === undefined || rootPath === undefined || permissions === undefined || mutationId === undefined || typeof input.enabled !== "boolean") return Response.json({ error: "invalid workspace mutation" }, { status: 400 });
      const workspace = this.createManagedWorkspace(clientId, { workspace_id: workspaceId, display_name: displayName, root_path: rootPath, enabled: input.enabled, permissions }, nowMs, mutationId);
      return workspace === undefined ? new Response("conflict", { status: 409 }) : Response.json(workspace);
    }
    if (action === "runners" && clientId !== undefined && segments[2] === "managed-workspaces" && segments[3] !== undefined && isSafeIdentifier(clientId) && isSafeIdentifier(segments[3])) {
      const workspaceId = segments[3];
      if (method === "GET") { const workspace = this.getManagedWorkspace(clientId, workspaceId); return workspace === undefined ? new Response("not found", { status: 404 }) : Response.json(workspace); }
      if (method === "PUT") {
        const displayName = stringField(input, "display_name", 256); const rootPath = stringField(input, "root_path", 4_096); const permissions = permissionSetField(input.permissions); const mutationId = mutationIdField(input);
        if (displayName === undefined || rootPath === undefined || permissions === undefined || mutationId === undefined || typeof input.enabled !== "boolean") return Response.json({ error: "invalid workspace mutation" }, { status: 400 });
        const workspace = this.updateManagedWorkspace(clientId, workspaceId, { display_name: displayName, root_path: rootPath, enabled: input.enabled, permissions }, nowMs, mutationId);
        return workspace === undefined ? new Response("not found", { status: 404 }) : Response.json(workspace);
      }
      if (method === "DELETE") {
        const confirmation = stringField(input, "confirmation", 128); const mutationId = mutationIdField(input);
        return confirmation === workspaceId && mutationId !== undefined && this.deleteManagedWorkspace(clientId, workspaceId, nowMs, mutationId) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
      }
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "version-policy" && isSafeIdentifier(clientId)) {
      const channel = input.update_channel; const desired = input.desired_runner_version; const latest = input.latest_runner_version;
      if ((channel !== "stable" && channel !== "pinned") || (desired !== undefined && typeof desired !== "string") || (latest !== undefined && typeof latest !== "string")) return Response.json({ error: "invalid runner version policy" }, { status: 400 });
      const runner = this.setRunnerVersionPolicy(clientId, { update_channel: channel, ...(typeof desired === "string" ? { desired_runner_version: desired } : {}), ...(typeof latest === "string" ? { latest_runner_version: latest } : {}) }, nowMs);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "permissions" && isSafeIdentifier(clientId)) {
      const permissions = permissionSetField(input.permissions);
      const mutationId = mutationIdField(input);
      if (mutationId === undefined) return Response.json({ error: "mutation_id is required" }, { status: 400 });
      const runner = permissions === undefined ? undefined : this.setRunnerPermissions(clientId, permissions, nowMs, mutationId);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "emergency-lock" && isSafeIdentifier(clientId)) {
      const confirmation = stringField(input, "confirmation", 128); const mutationId = mutationIdField(input);
      const runner = confirmation === clientId && mutationId !== undefined ? this.emergencyLockRunner(clientId, confirmation, nowMs, mutationId) : undefined;
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "policy-ack" && isSafeIdentifier(clientId)) {
      const ack = this.policyAcknowledgementFromInput(clientId, input, nowMs);
      if (ack === undefined) return Response.json({ error: "invalid policy acknowledgement" }, { status: 409 });
      return Response.json({ ack_result: ack });
    }
    if (method === "POST" && action === "mcp" && clientId === "revalidate") {
      const client = this.revalidateMcpClient(input.client_id, input.secret_version);
      return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client);
    }
    if (method === "POST" && action === "mcp" && clientId === "authorize-rpc") {
      const decision = this.authorizeMcpRpc(input);
      return Response.json(decision, { status: decision.ok ? 200 : decision.code === "stale_policy" ? 409 : 403 });
    }
    if (method === "GET" && action === "clients" && clientId !== undefined && segments[2] === "effective-workspaces" && segments[3] !== undefined && isSafeIdentifier(segments[3])) {
      const value = this.effectiveWorkspaceList(clientId, segments[3]);
      return value === undefined ? new Response("not found", { status: 404 }) : Response.json(value);
    }
    if (method === "POST" && action === "mcp" && clientId === "verify") {
      const verifier = stringField(input, "secret_verifier", 64);
      const client = verifier === undefined ? undefined : this.verifyMcpClient(verifier, nowMs);
      return client === undefined ? Response.json({ error: { code: "invalid_mcp_credential" } }, { status: 404 }) : Response.json(client);
    }
    return new Response("not found", { status: 404 });
  }

  private settings(): AdminSettingsRow | undefined { return this.auth.settings(); }

  private getMcpClient(clientId: string): McpClientRecord | undefined { return this.auth.getMcpClient(clientId); }

  private runnerRow(runnerId: string): RunnerRow | undefined { return this.lifecycle.runnerRow(runnerId); }

  private createPolicySnapshot(runnerId: string, revision: number, nowMs: number, sourceRevision: number | null, mutationId: string): void { return this.policy.createPolicySnapshot(runnerId, revision, nowMs, sourceRevision, mutationId); }
}

export class RegistryDOv2 extends RegistryDO {}

async function readCappedBody(request: Request): Promise<string | undefined> { return readCappedText(request, MAX_INTERNAL_BODY_BYTES); }
