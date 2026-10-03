import { createRunnerLifecycleRoutes } from "./registry/routes/runner-lifecycle.js";
import { createRunnerPolicyReadRoutes } from "./registry/routes/runner-policy-read.js";
import { createRunnerHistoryRoutes } from "./registry/history-routes.js";
import { createRunnerTransportRoutes } from "./registry/transport-routes.js";
import { createAdminRoutes } from "./registry/routes/admin.js";
import { createClientsRoutes } from "./registry/routes/clients.js";
import { createRunnerPolicyRoutes } from "./registry/routes/runner-policy.js";
import { createIdentityRoutes } from "./registry/routes/identity.js";
import type { RegistryRoute } from "./registry/routes/request.js";
import { RegistryFeatureHealthStore } from "./registry/feature-health.js";
import { historyCleanupDue, nextHistoryCleanupDeadline, nextMaintenanceDeadline } from "./registry/maintenance-plan.js";
import { createCoreRegistrySchema, registrySchemaIsCurrent, hasPersistedRegistrySchema, ensureJobHistorySettings } from "./registry/schema.js";
import type { RunnerConnectionState } from "./contracts/runner-selection.js";
import type { PolicyReadiness } from "./contracts/runner-selection.js";
import type { McpClientActiveRunner } from "./contracts/runner-selection.js";
import type { McpRunnerSelectionResult } from "./contracts/runner-selection.js";
import { resolveRuntimeConfiguration } from "./runtime-config.js";
import { PackedJobHistory } from "./job-history-store.js";
import type { JobHistorySettings } from "@aloneio/runmesh-protocol";
import { ExternalAuditHistory } from "./external-audit.js";
import { controlPlaneUnavailableResponse } from "./control-plane-errors.js";
import { ensureHistoryRetentionSchema } from "./history-retention.js";
import type { RunnerMetadata } from "@aloneio/runmesh-protocol";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import { verifyInternalRequest } from "./security.js";
import { readCappedText } from "./body.js";
import { ensureMetadataOnlyAudit } from "./audit-metadata.js";
import { MCP_AUDIT_RETENTION_MS } from "./audit-metadata.js";
import { ensureAuthSourceThrottleSchema } from "./auth-throttle.js";
import type { ValidityWindow } from "./validity.js";
import type { ValidityStatus } from "./validity.js";
import type { RunnerExecutionMode, PolicyAcknowledgementResult, RunnerMutationState, CodingScope, PermissionSet, WorkspaceValidationStatus, RunnerUpdateChannel, RunnerPublicInfo, RunnerRecord, WorkspaceRecord, DashboardSnapshot, RegistryFeatureKey, RegistryFeatureHealth, McpClientRecord, VerifiedMcpClient, RunnerRow, EnrollmentRow, AdminSettingsRow, AuthThrottleKind, InternalInput } from './registry/records.js';
import { MAX_INTERNAL_BODY_BYTES, DEFAULT_RUNNER_ENROLLMENT_TTL_MS, REGISTRY_HISTORY_CLEANUP_INTERVAL_MS, RUNNER_ENROLLMENT_RETENTION_MS, HISTORY_CLEANUP_DEADLINE_KEY } from './registry/records.js';
import { parseTransportIdentity, matchesTransportIdentity, parsePathIdentifier, parseJsonObject, stringField, integerField, nullableIntegerField, safeNonnegativeInteger, nullableChecksumField, runnerPublicInfoField, workspaceStatusesField, validVerifier, mutationIdField } from "./registry/values.js";
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

const VERIFIED_DEV_RELEASE_STORAGE_KEY = "distribution:verified-dev-runner-release:v1";

/** Public Registry facade: platform lifecycle, schema and existing HTTP routes.
 * Domain ports are synchronous closures, not remote RPCs or cached grants. */
export class RegistryDO {
  private readonly runnerLifecycleRoutes: ReturnType<typeof createRunnerLifecycleRoutes>;
  private readonly runnerPolicyReadRoutes: ReturnType<typeof createRunnerPolicyReadRoutes>;
  private readonly runnerHistoryRoutes: ReturnType<typeof createRunnerHistoryRoutes>;
  private readonly runnerTransportRoutes: ReturnType<typeof createRunnerTransportRoutes>;
  private readonly adminRoutes: RegistryRoute;
  private readonly clientsRoutes: RegistryRoute;
  private readonly runnerPolicyRoutes: RegistryRoute;
  private readonly identityRoutes: RegistryRoute;

  private readonly auth: RegistryAuth;
  private readonly policy: RegistryPolicy;
  private readonly lifecycle: RegistryLifecycle;
  private readonly history: RegistryHistory;
  private readonly featureHealth: RegistryFeatureHealthStore;

  private maintenanceQueue: Promise<void> = Promise.resolve();

  private readonly packedJobs: PackedJobHistory | undefined;

  private readonly externalAudit: ExternalAuditHistory | undefined;

  public constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { INTERNAL_CONTROL_SECRET?: string; RUNNER_TOKEN_PEPPER?: string; HISTORY_DB?: D1Database; RUNMESH_AUDIT_BACKEND?: string; RUNMESH_JOB_HISTORY_BACKEND?: string },
  ) {
    this.env = env = resolveRuntimeConfiguration(env);
    const storage = registryStorage(ctx.storage);
    this.featureHealth = new RegistryFeatureHealthStore(storage.sql);
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
    this.adminRoutes = createAdminRoutes({
      consumeInternalNonce: (...args) => this.consumeInternalNonce(...args),
      adminStatus: (...args) => this.adminStatus(...args),
      settings: (...args) => this.settings(...args),
      setupAdmin: (...args) => this.setupAdmin(...args),
      checkSourceAuthThrottle: (...args) => this.checkSourceAuthThrottle(...args),
      recordSourceAuthAttempt: (...args) => this.recordSourceAuthAttempt(...args),
      createAdminSession: (...args) => this.createAdminSession(...args),
      verifyAdminSession: (...args) => this.verifyAdminSession(...args),
      logoutAdminSession: (...args) => this.logoutAdminSession(...args),
      changeAdminPassword: (...args) => this.changeAdminPassword(...args),
    });
    this.clientsRoutes = createClientsRoutes({
      listMcpClients: (...args) => this.listMcpClients(...args),
      createMcpIdentity: (...args) => this.auth.createMcpIdentity(...args),
      createMcpClient: (...args) => this.createMcpClient(...args),
      setJobRecording: (...args) => this.setJobRecording(...args),
      renameMcpClient: (...args) => this.renameMcpClient(...args),
      rotateMcpClient: (...args) => this.rotateMcpClient(...args),
      revokeMcpClient: (...args) => this.revokeMcpClient(...args),
      deleteMcpClient: (...args) => this.deleteMcpClient(...args),
      updateMcpClientScopes: (...args) => this.updateMcpClientScopes(...args),
      hasMcpClient: clientId => this.getMcpClient(clientId) !== undefined,
      listClientRunnerOverrides: (...args) => this.listClientRunnerOverrides(...args),
      deleteClientRunnerOverride: (...args) => this.deleteClientRunnerOverride(...args),
      setClientRunnerOverride: (...args) => this.setClientRunnerOverride(...args),
      effectivePermissions: (...args) => this.effectivePermissions(...args),
      getMcpClientActiveRunner: (...args) => this.getMcpClientActiveRunner(...args),
      resetMcpClientRunner: (...args) => this.resetMcpClientRunner(...args),
      revalidateMcpClient: (...args) => this.revalidateMcpClient(...args),
      selectMcpClientRunner: (...args) => this.selectMcpClientRunner(...args),
      autoSelectOnlyRunner: (...args) => this.autoSelectOnlyRunner(...args),
      effectiveWorkspaceList: (...args) => this.effectiveWorkspaceList(...args),
    });
    this.runnerPolicyRoutes = createRunnerPolicyRoutes({
      hasRunner: runnerId => this.runnerRow(runnerId) !== undefined,
      listManagedWorkspaces: (...args) => this.listManagedWorkspaces(...args),
      latestRunnerEnrollment: (...args) => this.latestRunnerEnrollment(...args),
      runnerAccess: (...args) => this.runnerAccess(...args),
      setRunnerValidity: (...args) => this.setRunnerValidity(...args),
      createManagedWorkspace: (...args) => this.createManagedWorkspace(...args),
      getManagedWorkspace: (...args) => this.getManagedWorkspace(...args),
      updateManagedWorkspace: (...args) => this.updateManagedWorkspace(...args),
      deleteManagedWorkspace: (...args) => this.deleteManagedWorkspace(...args),
      setRunnerVersionPolicy: (...args) => this.setRunnerVersionPolicy(...args),
      setRunnerPermissions: (...args) => this.setRunnerPermissions(...args),
      emergencyLockRunner: (...args) => this.emergencyLockRunner(...args),
      policyAcknowledgementFromInput: (...args) => this.policyAcknowledgementFromInput(...args),
    });
    this.identityRoutes = createIdentityRoutes({
      revalidateMcpIdentity: (...args) => this.auth.revalidateMcpIdentity(...args),
      revalidateMcpClient: (...args) => this.revalidateMcpClient(...args),
      authorizeMcpRpc: (...args) => this.authorizeMcpRpc(...args),
      verifyMcpIdentity: (...args) => this.auth.verifyMcpIdentity(...args),
      verifyMcpClient: (...args) => this.verifyMcpClient(...args),
    });
    this.packedJobs = env.RUNMESH_JOB_HISTORY_BACKEND === "d1" && env.HISTORY_DB !== undefined ? new PackedJobHistory(env.HISTORY_DB, ctx.id.toString()) : undefined;
    this.externalAudit = env.RUNMESH_AUDIT_BACKEND === "d1" && env.HISTORY_DB !== undefined ? new ExternalAuditHistory(env.HISTORY_DB, ctx.id.toString()) : undefined;
    this.runnerLifecycleRoutes = createRunnerLifecycleRoutes({
      authorizeMcpRpc: (...args) => this.authorizeMcpRpc(...args),
      runnerRow: (...args) => this.runnerRow(...args),
      registerRunner: (...args) => this.registerRunner(...args),
      recordHeartbeat: (...args) => this.recordHeartbeat(...args),
      sessionIsCurrent: (...args) => this.sessionIsCurrent(...args),
      addRunner: (...args) => this.addRunner(...args),
      deleteRunner: (...args) => this.deleteRunner(...args),
      renameRunner: (...args) => this.renameRunner(...args),
      createRunnerEnrollment: (...args) => this.createRunnerEnrollment(...args),
      runnerAccess: (...args) => this.runnerAccess(...args),
      latestRunnerEnrollment: (...args) => this.latestRunnerEnrollment(...args),
      setRunnerValidity: (...args) => this.setRunnerValidity(...args),
      invalidateRunnerCredential: (...args) => this.invalidateRunnerCredential(...args),
      revokeRunner: (...args) => this.revokeRunner(...args),
      getRunnerMutationState: (...args) => this.getRunnerMutationState(...args),
      getRunnerExecutionState: (...args) => this.getRunnerExecutionState(...args),
      getRunner: (...args) => this.getRunner(...args)
    });
    this.runnerPolicyReadRoutes = createRunnerPolicyReadRoutes({
      getActivePolicySnapshot: (...args) => this.getActivePolicySnapshot(...args),
      getSnapshotAuthorization: (...args) => this.getSnapshotAuthorization(...args),
      getPolicyReadiness: (...args) => this.getPolicyReadiness(...args),
      getRunner: (...args) => this.getRunner(...args),
      policyAcknowledgementFromInput: (...args) => this.policyAcknowledgementFromInput(...args),
      desiredPolicy: (...args) => this.desiredPolicy(...args),
      listPolicyVersions: (...args) => this.listPolicyVersions(...args),
      policyMutationId: (...args) => this.policy.policyMutationId(...args)
    });
    this.runnerHistoryRoutes = createRunnerHistoryRoutes({
      runnerRow: (...args) => this.runnerRow(...args),
      jobHistorySettings: (...args) => this.jobHistorySettings(...args),
      setJobHistorySettings: (...args) => this.setJobHistorySettings(...args),
      syncRunner: (...args) => this.syncRunner(...args),
      sessionIsCurrent: (...args) => this.sessionIsCurrent(...args),
      recordJobEvent: (...args) => this.recordJobEvent(...args),
      listJobs: (...args) => this.listJobs(...args),
      listMcpCalls: (...args) => this.listMcpCalls(...args),
      featureHealthDisabled: (...args) => this.featureHealthDisabled(...args),
      recordMcpCall: (...args) => this.recordMcpCall(...args),
      recordsJobActivity: (...args) => this.recordsJobActivity(...args),
      getJob: (...args) => this.getJob(...args),
      runnerMatchesTransportFence: this.runnerMatchesTransportFence.bind(this),
      getMcpClient: (...args) => this.getMcpClient(...args),
      packedJobs: this.packedJobs,
      externalAudit: this.externalAudit,
      externalAuditing: env.RUNMESH_AUDIT_BACKEND === "d1",
      packedHistory: env.RUNMESH_JOB_HISTORY_BACKEND === "d1"
    });
    this.runnerTransportRoutes = createRunnerTransportRoutes({
      authenticateRunner: (...args) => this.authenticateRunner(...args),
      beginConnection: (...args) => this.beginConnection(...args),
      runnerRow: (...args) => this.runnerRow(...args),
      desiredPolicy: (...args) => this.desiredPolicy(...args),
      scheduleMaintenanceAlarm: (...args) => this.scheduleMaintenanceAlarm(...args),
      jobHistorySettings: (...args) => this.jobHistorySettings(...args),
      markDisconnected: (...args) => this.markDisconnected(...args)
    });
    this.ctx.blockConcurrencyWhile(async () => {
      // Durable Objects may be evicted and reconstructed for every request.
      // Replaying CREATE TABLE/INDEX IF NOT EXISTS on every reconstruction is
      // still counted as a SQL write on the free tier, so fast-path fully
      // initialized objects with a read-only schema check.
      if (!this.schemaIsCurrent()) {
        if (this.hasPersistedRegistrySchema()) {
          throw new Error("incompatible Registry schema: deploy this clean-break release to a fresh Durable Object namespace");
        }
        createCoreRegistrySchema(this.ctx.storage.sql);
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
    if (historyCleanupDue(nextCleanup, nowMs, REGISTRY_HISTORY_CLEANUP_INTERVAL_MS)) {
      if (this.ctx.storage.sql.exec("SELECT 1 FROM feature_health WHERE disabled_until_ms <= ? LIMIT 1", nowMs).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM feature_health WHERE disabled_until_ms <= ?", nowMs);
      if (this.ctx.storage.sql.exec("SELECT 1 FROM admin_sessions WHERE expires_at_ms <= ? LIMIT 1", nowMs).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE expires_at_ms <= ?", nowMs);
      if (this.ctx.storage.sql.exec("SELECT 1 FROM internal_request_nonces WHERE expires_at_ms <= ? LIMIT 1", nowMs).toArray().length > 0) this.ctx.storage.sql.exec("DELETE FROM internal_request_nonces WHERE expires_at_ms <= ?", nowMs);
      // Keep recent expired/used metadata visible in the console; never retain raw codes.
      const enrollmentRetentionCutoff = nowMs - RUNNER_ENROLLMENT_RETENTION_MS;
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
      // Pending records need one expiry-driven wake even without a Runner.
      // The durable sweep deadline batches cleanup; an empty store stays idle.
      const nextExpiry = this.ctx.storage.sql.exec<{ next_ms: number | null }>(
        `SELECT MIN(expires_ms) AS next_ms FROM (
          SELECT MIN(expires_at_ms) AS expires_ms FROM internal_request_nonces
          UNION ALL SELECT MIN(expires_at_ms) FROM admin_sessions
          UNION ALL SELECT MIN(disabled_until_ms) FROM feature_health
          UNION ALL SELECT MIN(expires_at_ms) + ? FROM runner_enrollments
        )`, RUNNER_ENROLLMENT_RETENTION_MS,
      ).one().next_ms;
      const nextSweep = nextExpiry === null ? undefined : await this.ctx.storage.get<number>(HISTORY_CLEANUP_DEADLINE_KEY);
      const nextHistory = nextHistoryCleanupDeadline(nowMs, nextExpiry, nextSweep, REGISTRY_HISTORY_CLEANUP_INTERVAL_MS);
      const deadline = nextMaintenanceDeadline(nowMs, nextStale, nextAudit, nextHistory);
      const current = await this.ctx.storage.getAlarm();
      if (deadline === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); return; }
      if (current === null || current <= nowMs || current > deadline) await this.ctx.storage.setAlarm(deadline);
      this.clearFeatureHealth("maintenance_alarm");
    } catch (error) { this.disableFeatureHealth("maintenance_alarm", error, nowMs); }
  }

  private loadFeatureHealth(): void { this.featureHealth.load(); }

  public featureHealthSnapshot(nowMs = Date.now()): RegistryFeatureHealth[] {
    const states = this.featureHealth.snapshot(nowMs);
    const external = this.externalAudit?.health(nowMs);
    if (external !== undefined && !states.some((state) => state.feature === "mcp_audit")) states.push({ feature: "mcp_audit", ...external, last_failure_at_ms: null, last_error: "External audit storage is unavailable; core authorization and execution are independent." });
    return states.sort((left, right) => left.feature.localeCompare(right.feature));
  }

  private clearFeatureHealth(feature: RegistryFeatureKey): void { this.featureHealth.clear(feature); }

  private runnerMatchesTransportFence(current: RunnerRow | undefined, epoch: number, credentialVersion: number, requireOnline: boolean, lifecycleId: string, sessionId: string): current is RunnerRow {
    return current !== undefined && current.connection_epoch === epoch && current.credential_version === credentialVersion && (!requireOnline || current.state === "online") && matchesTransportIdentity(current, lifecycleId, sessionId);
  }

  private syncSequenceCanAdvance(current: RunnerRow, syncSequence: number): boolean {
    const prior = current.last_sync_sequence;
    return prior === null || prior === undefined || (safeNonnegativeInteger(prior) && syncSequence > prior);
  }

  private disableFeatureHealth(feature: RegistryFeatureKey, error: unknown, nowMs = Date.now(), cooldownMs = 15 * 60_000): void {
    const disabledUntil = this.featureHealth.disable(feature, error, nowMs, cooldownMs);
    if (feature === "maintenance_alarm") void this.ctx.storage.setAlarm(Math.max(nowMs + 1_000, disabledUntil)).catch(() => undefined);
  }

  private featureHealthDisabled(feature: RegistryFeatureKey, nowMs = Date.now()): boolean { return this.featureHealth.disabled(feature, nowMs); }

  public consumeInternalNonce(nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean { return this.auth.consumeInternalNonce(nonce, expiresAtMs, nowMs); }

  private schemaIsCurrent(): boolean { return registrySchemaIsCurrent(this.ctx.storage.sql); }

  private hasPersistedRegistrySchema(): boolean { return hasPersistedRegistrySchema(this.ctx.storage.sql); }

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



  public setJobRecording(clientId: string, enabled: boolean, nowMs: number): McpClientRecord | undefined { return this.auth.setJobRecording(clientId, enabled, nowMs); }

  public recordsJobActivity(clientId: string): boolean { return this.auth.recordsJobActivity(clientId); }

  public updateMcpClientScopes(clientId: string, scopes: readonly CodingScope[], nowMs: number): McpClientRecord | undefined { return this.auth.updateMcpClientScopes(clientId, scopes, nowMs); }

  public renameMcpClient(clientId: string, label: string, nowMs: number): McpClientRecord | undefined { return this.auth.renameMcpClient(clientId, label, nowMs); }

  public rotateMcpClient(clientId: string, secretVerifier: string, secretPrefix: string, nowMs: number): McpClientRecord | undefined { return this.auth.rotateMcpClient(clientId, secretVerifier, secretPrefix, nowMs); }

  public revokeMcpClient(clientId: string, nowMs: number): McpClientRecord | undefined { return this.auth.revokeMcpClient(clientId, nowMs); }

  public deleteMcpClient(clientId: string): boolean { return this.auth.deleteMcpClient(clientId); }

  public verifyMcpClient(secretVerifier: string, nowMs: number): VerifiedMcpClient | undefined { return this.auth.verifyMcpClient(secretVerifier, nowMs); }

  public revalidateMcpClient(clientId: unknown, secretVersion: unknown, includeJobRecording = false): VerifiedMcpClient | undefined { return this.auth.revalidateMcpClient(clientId, secretVersion, includeJobRecording); }

  public authorizeMcpRpc(input: Record<string, unknown>): { ok: true; record_history?: boolean } | { ok: false; code: string } { return this.policy.authorizeMcpRpc(input); }

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

  public redeemRunnerEnrollment(verifier: string, tokenVerifier: string, publicInfo: RunnerPublicInfo, nowMs: number, mutationId: string): Promise<{ runner_id: string } | undefined> { return this.lifecycle.redeemRunnerEnrollment(verifier, tokenVerifier, publicInfo, nowMs, mutationId); }

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
      || (segments[0] === "auth" && segments[1] === "sessions" && segments[2] === "verify")
      || (segments[0] === "runners" && segments[2] === "mcp-authorization")
    );
    // Metadata-only completed-call receipts are immutable in both backends.
    // Their unique call IDs and live transport fence make retries idempotent;
    // persisting a separate nonce adds index writes and later deletion work.
    const replaySafeReceipt = request.method === "POST" && segments.length === 3
      && segments[0] === "runners" && segments[2] === "mcp-calls";
    // This wrapper atomically consumes the original request nonce in its
    // route. A second nonce for the wrapper adds no replay protection; its
    // HMAC still binds the method, path, timestamp and complete payload.
    const delegatedNonce = request.method === "POST" && url.pathname === "/auth/internal-nonces";
    const consumeNonce = request.method === "GET" || replaySafeHeartbeat || replaySafeSession || replaySafeHistory || replaySafeAuthorization || replaySafeReceipt || delegatedNonce
      ? () => true
      : async (nonce: string, expiresAtMs: number) => {
        const consumed = this.consumeInternalNonce(nonce, expiresAtMs);
        if (consumed) await this.scheduleMaintenanceAlarm(Date.now());
        return consumed;
      };
    if (!await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, rawBody, consumeNonce)) return new Response("not found", { status: 404 });
    const input = rawBody.length === 0 ? {} : parseJsonObject(rawBody);
    if (input === undefined) return Response.json({ error: "invalid JSON object" }, { status: 400 });
    const now = Date.now();
    // The session is bound by the HMAC to method, target and body. Verify it
    // after all admission awaits, in the same event turn as synchronous writes.
    const browserSession = url.searchParams.get("admin_session");
    if (browserSession !== null && (url.searchParams.getAll("admin_session").length !== 1 || !validVerifier(browserSession) || this.verifyAdminSession(browserSession, now) === undefined)) {
      return new Response("administrative session is no longer authorized", { status: 403, headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && segments.length === 2 && segments[0] === "enrollments" && segments[1] === "lookup") {
      const verifier = stringField(input, "verifier", 64);
      const target = verifier === undefined ? undefined : this.lookupRunnerEnrollment(verifier, now);
      return target === undefined ? new Response("not found", { status: 404 }) : Response.json(target);
    }
    if (request.method === "POST" && segments.length === 2 && segments[0] === "enrollments" && segments[1] === "redeem") {
      const verifier = stringField(input, "verifier", 64); const tokenVerifier = stringField(input, "token_verifier", 64); const publicInfo = runnerPublicInfoField(input.runner_public_info);
      const mutationId = mutationIdField(input);
      // Redemption shares the mutation identity used to acquire the RunnerDO fence.
      if (mutationId === undefined) return Response.json({ error: "mutation_id is required" }, { status: 400 });
      const redeemed = verifier === undefined || tokenVerifier === undefined || publicInfo === undefined ? undefined : await this.redeemRunnerEnrollment(verifier, tokenVerifier, publicInfo, now, mutationId);
      return redeemed === undefined ? new Response("invalid enrollment", { status: 401 }) : Response.json(redeemed);
    }
    if (segments[0] === "auth") {
      const response = this.handleAuth(request.method, segments.slice(1), input, now, url);
      // Only successful consumption creates expiry work. Keep scheduling in
      // the async facade so the domain route retains its synchronous contract.
      if (delegatedNonce && response.status === 204) await this.scheduleMaintenanceAlarm(now);
      return response;
    }
    if (request.method === "GET" && segments.length === 1 && segments[0] === "runners") return Response.json({ runners: this.listRunners() });
    if (request.method === "GET" && segments.length === 1 && segments[0] === "dashboard") return Response.json(this.dashboardSnapshot());
    if (request.method === "GET" && segments.length === 2 && segments[0] === "status" && segments[1] === "features") return Response.json({ features: this.featureHealthSnapshot(now) });
    if (segments.length === 2 && segments[0] === "distribution" && segments[1] === "dev-runner-release") {
      if (request.method === "GET") {
        const cached = await this.ctx.storage.get<unknown>(VERIFIED_DEV_RELEASE_STORAGE_KEY);
        return cached === undefined ? new Response("not found", { status: 404, headers: { "cache-control": "no-store" } }) : Response.json(cached, { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "POST") {
        const verifiedAtMs = integerField(input, "verified_at_ms");
        if (input.schema_version !== 1 || verifiedAtMs === undefined || verifiedAtMs <= 0 || verifiedAtMs > now + 60_000 || typeof input.descriptor !== "object" || input.descriptor === null || Array.isArray(input.descriptor)) return Response.json({ error: "invalid development release cache record" }, { status: 400 });
        const current = await this.ctx.storage.get<{ readonly verified_at_ms?: unknown }>(VERIFIED_DEV_RELEASE_STORAGE_KEY);
        if (current !== undefined && Number.isSafeInteger(current.verified_at_ms) && Number(current.verified_at_ms) >= verifiedAtMs) return new Response(null, { status: 204 });
        await this.ctx.storage.put(VERIFIED_DEV_RELEASE_STORAGE_KEY, input);
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }
    const runnerId = segments[0] === "runners" ? parsePathIdentifier(segments[1]) : undefined;
    const action = segments[2]; const itemId = segments[3];
    if (runnerId === undefined || segments.length > 4) return new Response("not found", { status: 404 });
    const route = { method: request.method, runnerId, action, itemId, input, nowMs: now, url };
    const synchronous = this.runnerLifecycleRoutes(route) ?? this.runnerPolicyReadRoutes(route);
    if (synchronous !== undefined) return synchronous;
    if (["auth", "connect", "disconnect"].includes(action ?? "")) return await this.runnerTransportRoutes(route) ?? new Response("not found", { status: 404 });
    if (["history-settings", "sync", "event", "jobs", "mcp-calls"].includes(action ?? "")) return await this.runnerHistoryRoutes(route) ?? new Response("not found", { status: 404 });

    return new Response("not found", { status: 404 });
  }

  private policyAcknowledgementFromInput(runnerId: string, input: InternalInput, nowMs: number): PolicyAcknowledgementResult | undefined {
    const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const desiredRevision = integerField(input, "desired_revision"); const desiredChecksum = stringField(input, "desired_checksum", 64); const appliedRevision = nullableIntegerField(input, "applied_revision"); const appliedChecksum = nullableChecksumField(input, "applied_checksum"); const reportedRevision = nullableIntegerField(input, "runner_reported_policy_revision"); const reportedChecksum = nullableChecksumField(input, "runner_reported_policy_checksum"); const status = input.status; const statuses = workspaceStatusesField(input.workspace_status); const identity = parseTransportIdentity(input);
    if (epoch === undefined || credentialVersion === undefined || desiredRevision === undefined || desiredChecksum === undefined || appliedRevision === undefined || appliedChecksum === undefined || reportedRevision === undefined || reportedChecksum === undefined || (status !== "applied" && status !== "pending" && status !== "invalid") || statuses === undefined || !identity.valid) return undefined;
    return this.acknowledgePolicy(runnerId, epoch, credentialVersion, { desired_revision: desiredRevision, desired_checksum: desiredChecksum, applied_revision: appliedRevision, applied_checksum: appliedChecksum, runner_reported_policy_revision: reportedRevision, runner_reported_policy_checksum: reportedChecksum, status, workspace_status: statuses }, nowMs, identity.lifecycleId, identity.sessionId);
  }

  private handleAuth(method: string, segments: string[], input: InternalInput, nowMs: number, url: URL): Response {
    const route = segments[0] === "clients" ? this.clientsRoutes
      : segments[0] === "runners" ? this.runnerPolicyRoutes
      : segments[0] === "mcp" ? this.identityRoutes : this.adminRoutes;
    return route({ method, segments, input, nowMs, url }) ?? new Response("not found", { status: 404 });
  }

  private settings(): AdminSettingsRow | undefined { return this.auth.settings(); }

  private getMcpClient(clientId: string): McpClientRecord | undefined { return this.auth.getMcpClient(clientId); }

  private runnerRow(runnerId: string): RunnerRow | undefined { return this.lifecycle.runnerRow(runnerId); }

  private createPolicySnapshot(runnerId: string, revision: number, nowMs: number, sourceRevision: number | null, mutationId: string): void { return this.policy.createPolicySnapshot(runnerId, revision, nowMs, sourceRevision, mutationId); }
}

export class RegistryDOv2 extends RegistryDO {}

async function readCappedBody(request: Request): Promise<string | undefined> { return readCappedText(request, MAX_INTERNAL_BODY_BYTES); }
