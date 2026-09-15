import type { PolicyReadiness } from "../contracts/runner-selection.js";
import { rpcPermissionRequirement } from "../mcp-authorization.js";
import { RunnerPolicySchema } from "@aloneio/runmesh-protocol";
import { intersectPermissionSets } from "@aloneio/runmesh-protocol";
import { permissionSetFromScopes } from "@aloneio/runmesh-protocol";
import { runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import { isSafeIdentifier } from "../security.js";
import { validityStatus } from "../validity.js";
import type { PolicyAcknowledgementResult, PermissionSet, WorkspaceValidationStatus, RunnerRecord, WorkspaceRecord, PolicyVersionRow, PolicyMutationKind, PolicyMutationRow, ManagedWorkspaceRow } from './records.js';
import { LOCKED_PERMISSIONS } from './records.js';
import { validLifecycleId, validSessionId, matchesTransportIdentity, decodeWorkspace, uniqueIds, parsePermissionSet, validPermissionSet, validWorkspaceInput, validPolicyJson, validOptionalMutationId, policyMutationFingerprint, expectedRegistryConflict } from './values.js';
import type { RegistryStorage } from './storage.js';
import type { PolicyPorts } from './ports.js';

/** Policy operations over a single Registry database. Construction has no I/O.
 * SQL text, arguments, transaction callbacks and await positions are retained. */
export class RegistryPolicy {
  public constructor(private readonly storage: RegistryStorage, private readonly ports: PolicyPorts, private readonly jobHistoryBackend: string | undefined) {}
  public authorizeMcpRpc(input: Record<string, unknown>): { ok: true } | { ok: false; code: string } {
    const deny = (code = "permission_denied") => ({ ok: false as const, code });
    const client = this.ports.revalidateMcpClient(input.client_id, input.secret_version);
    const runnerId = input.runner_id;
    const requirement = typeof input.method === "string" ? rpcPermissionRequirement(input.method) : undefined;
    if (client === undefined || typeof runnerId !== "string" || !isSafeIdentifier(runnerId) || requirement === undefined) return deny();
    if (!client.scopes.includes(requirement.scope)) return deny("insufficient_scope");
    const selection = this.ports.getMcpClientActiveRunner(client.client_id);
    if (selection?.active_runner_id !== runnerId) return deny();
    const readiness = this.getPolicyReadiness(runnerId);
    if (!readiness.ok || readiness.applied_revision !== input.policy_revision || readiness.active_checksum !== input.policy_checksum) return deny("stale_policy");
    let workspaceId = input.workspace_id;
    if (requirement.job) {
      if (typeof input.job_id !== "string" || !isSafeIdentifier(input.job_id)) return deny();
      if (input.workspace_bound === true || this.jobHistoryBackend === "d1") {
        // Old peers might ignore expected_workspace_id. Never permit the new
        // history-independent path based only on a caller's assertion.
        const version = this.ports.runnerRow(runnerId)?.current_runner_version;
        const parts = typeof version === "string" ? /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version) : null;
        if (parts === null || !(Number(parts[1]) > 0 || Number(parts[2]) > 1 || (Number(parts[2]) === 1 && Number(parts[3]) >= 1))) return deny("runner_upgrade_required");
      } else {
        const job = this.ports.getJob(runnerId, input.job_id);
        if (typeof job !== "object" || job === null || Array.isArray(job) || (job as Record<string, unknown>).workspace_id !== workspaceId) return deny();
      }
    }
    if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return deny();
    const permissions = this.effectivePermissions(client.client_id, runnerId, workspaceId);
    return permissions?.[requirement.permission] === true ? { ok: true } : deny();
  }

  public effectiveWorkspaceList(clientId: string, runnerId: string): { runner_id: string; revision: number; checksum: string; workspaces: Array<{ workspace_id: string; enabled: boolean; permissions: PermissionSet }> } | undefined {
    const client = this.ports.getMcpClient(clientId);
    if (client === undefined || client.revoked_at_ms !== null || !client.scopes.includes("coding:read") || !this.getSnapshotAuthorization(runnerId).ok) return undefined;
    const policy = this.getActivePolicySnapshot(runnerId);
    if (policy === undefined) return undefined;
    const workspaces = policy.workspaces.flatMap((workspace) => {
      const permissions = this.effectivePermissions(clientId, runnerId, workspace.workspace_id);
      return permissions?.read === true ? [{ workspace_id: workspace.workspace_id, enabled: true, permissions }] : [];
    });
    return { runner_id: runnerId, revision: policy.revision, checksum: policy.checksum, workspaces };
  }

  public setClientRunnerOverride(clientId: string, runnerId: string, permissions: PermissionSet, nowMs: number): boolean {
    if (!isSafeIdentifier(clientId) || !isSafeIdentifier(runnerId) || this.ports.getMcpClient(clientId) === undefined || this.ports.runnerRow(runnerId) === undefined || !validPermissionSet(permissions)) return false;
    this.storage.sql.exec(`INSERT INTO client_runner_overrides (client_id, runner_id, permissions_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id, runner_id) DO UPDATE SET permissions_json = excluded.permissions_json, updated_at_ms = excluded.updated_at_ms`, clientId, runnerId, JSON.stringify(permissions), nowMs, nowMs);
    return true;
  }

  public clientRunnerPermissions(clientId: string, runnerId: string): PermissionSet | undefined {
    const row = this.storage.sql.exec<{ permissions_json: string }>("SELECT permissions_json FROM client_runner_overrides WHERE client_id = ? AND runner_id = ?", clientId, runnerId).toArray()[0];
    return row === undefined ? undefined : parsePermissionSet(row.permissions_json) ?? { ...LOCKED_PERMISSIONS };
  }

  public listClientRunnerOverrides(clientId: string): Array<{ runner_id: string; permissions: PermissionSet }> {
    return this.storage.sql.exec<{ runner_id: string; permissions_json: string }>("SELECT runner_id, permissions_json FROM client_runner_overrides WHERE client_id = ? ORDER BY runner_id", clientId).toArray().flatMap((row) => {
      const permissions = parsePermissionSet(row.permissions_json);
      return permissions === undefined ? [] : [{ runner_id: row.runner_id, permissions }];
    });
  }

  public deleteClientRunnerOverride(clientId: string, runnerId: string): boolean {
    if (!isSafeIdentifier(clientId) || !isSafeIdentifier(runnerId)) return false;
    return this.storage.sql.exec("DELETE FROM client_runner_overrides WHERE client_id = ? AND runner_id = ?", clientId, runnerId).rowsWritten === 1;
  }

  public effectivePermissions(clientId: string, runnerId: string, workspaceId: string): PermissionSet | undefined {
    if (!this.ports.runnerAccess(runnerId).allowed) return undefined;
    const client = this.ports.getMcpClient(clientId);
    const policy = this.getActivePolicySnapshot(runnerId);
    if (client === undefined || client.revoked_at_ms !== null || policy === undefined) return undefined;
    const workspace = policy.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (workspace === undefined || !workspace.enabled) return undefined;
    const override = this.clientRunnerPermissions(clientId, runnerId) ?? { read: true, edit: true, shell: true, job_control: true };
    return intersectPermissionSets(permissionSetFromScopes(client.scopes), override, policy.runner_permissions, workspace.permissions);
  }

  public getSnapshotAuthorization(runnerId: string): { readonly ok: true; readonly revision: number; readonly checksum: string } | { readonly ok: false; readonly code: "policy_pending" | "stale_policy"; readonly reason: string } {
    const runner = this.ports.runnerRow(runnerId);
    if (runner === undefined) return { ok: false, code: "stale_policy", reason: "runner is missing" };
    if (validityStatus(runner) !== "active") return { ok: false, code: "stale_policy", reason: "runner authorization is outside its validity window" };
    if (runner.policy_status !== "applied" || runner.desired_policy_revision !== runner.applied_policy_revision || runner.applied_policy_revision !== runner.runner_reported_policy_revision
      || runner.desired_policy_checksum !== runner.active_policy_checksum || runner.active_policy_checksum !== runner.runner_reported_policy_checksum) return { ok: false, code: "policy_pending", reason: "policy identity is not fully applied" };
    const revision = runner.applied_policy_revision;
    const checksum = runner.active_policy_checksum;
    if (!Number.isSafeInteger(revision) || revision === null || revision <= 0 || typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return { ok: false, code: "policy_pending", reason: "active policy identity is incomplete" };
    const active = this.getActivePolicySnapshot(runnerId);
    if (active === undefined || active.revision !== revision || active.checksum !== checksum) return { ok: false, code: "stale_policy", reason: "immutable active policy snapshot is unavailable" };
    return { ok: true, revision, checksum };
  }

  public getDesiredPolicySnapshot(runnerId: string): RunnerPolicy | undefined {
    const runner = this.ports.runnerRow(runnerId);
    if (runner === undefined) return undefined;
    return this.policySnapshot(runnerId, runner.desired_policy_revision, runner.desired_policy_checksum);
  }

  public getActivePolicySnapshot(runnerId: string): RunnerPolicy | undefined {
    const runner = this.ports.runnerRow(runnerId);
    if (runner === undefined || runner.applied_policy_revision === null || runner.active_policy_checksum === null) return undefined;
    return this.policySnapshot(runnerId, runner.applied_policy_revision, runner.active_policy_checksum, "applied");
  }

  public getActiveWorkspacePolicy(runnerId: string, workspaceId: string): RunnerPolicy["workspaces"][number] | undefined {
    return this.getActivePolicySnapshot(runnerId)?.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
  }

  public getPolicyReadiness(runnerId: string): PolicyReadiness {
    const runner = this.ports.runnerRow(runnerId);
    if (runner === undefined) return { ok: false, code: "stale_policy", reason: "runner is missing" };
    const checksum = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    if (runner.state !== "online" || !revision(runner.connection_epoch) || !revision(runner.credential_version) || typeof runner.session_id !== "string" || !validSessionId(runner.session_id)) {
      return { ok: false, code: "stale_policy", reason: "runner session is not current" };
    }
    if (runner.policy_status !== "applied") return { ok: false, code: "policy_pending", reason: "policy is not applied" };
    if (!revision(runner.desired_policy_revision) || !revision(runner.applied_policy_revision) || !revision(runner.runner_reported_policy_revision)
      || !checksum(runner.desired_policy_checksum) || !checksum(runner.active_policy_checksum) || !checksum(runner.runner_reported_policy_checksum)) {
      return { ok: false, code: "policy_pending", reason: "policy identity is incomplete" };
    }
    if (runner.desired_policy_revision !== runner.applied_policy_revision || runner.applied_policy_revision !== runner.runner_reported_policy_revision
      || runner.desired_policy_checksum !== runner.active_policy_checksum || runner.active_policy_checksum !== runner.runner_reported_policy_checksum) {
      return { ok: false, code: "stale_policy", reason: "policy identity mismatch" };
    }
    // A malformed lifecycle cannot safely authorize a protected transport
    // session. Fail closed if persistent state is incomplete.
    if (!validLifecycleId(runner.lifecycle_id)) return { ok: false, code: "stale_policy", reason: "runner lifecycle identity is unavailable" };
    if (runner.session_id === null || !validSessionId(runner.session_id)) return { ok: false, code: "stale_policy", reason: "runner session identity is unavailable" };
    const active = this.getActivePolicySnapshot(runnerId);
    const desired = this.getDesiredPolicySnapshot(runnerId);
    if (active === undefined || desired === undefined || active.revision !== runner.applied_policy_revision || active.checksum !== runner.active_policy_checksum
      || desired.revision !== runner.desired_policy_revision || desired.checksum !== runner.desired_policy_checksum) {
      return { ok: false, code: "stale_policy", reason: "immutable policy snapshot is unavailable" };
    }
    return {
      ok: true,
      policy_status: "applied",
      desired_revision: runner.desired_policy_revision,
      desired_checksum: runner.desired_policy_checksum,
      applied_revision: runner.applied_policy_revision,
      active_checksum: runner.active_policy_checksum,
      runner_reported_policy_revision: runner.runner_reported_policy_revision,
      runner_reported_policy_checksum: runner.runner_reported_policy_checksum,
      connection_epoch: runner.connection_epoch,
      credential_version: runner.credential_version,
      lifecycle_id: runner.lifecycle_id,
      session_id: runner.session_id,
    };
  }

  public policySnapshot(runnerId: string, revision: number | null, checksum: string | null, expectedStatus?: "applied"): RunnerPolicy | undefined {
    if (!Number.isSafeInteger(revision) || revision === null || revision <= 0 || typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return undefined;
    const row = this.storage.sql.exec<PolicyVersionRow>("SELECT * FROM runner_policy_versions WHERE runner_id = ? AND revision = ?", runnerId, revision).toArray()[0];
    if (row === undefined || row.runner_id !== runnerId || row.revision !== revision || row.checksum !== checksum || (expectedStatus !== undefined && row.status !== expectedStatus) || !/^[a-f0-9]{64}$/.test(row.checksum)) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(row.policy_json) as unknown; } catch { return undefined; }
    const result = RunnerPolicySchema.safeParse(parsed);
    if (!result.success || !validPolicyJson(parsed as { runner_permissions?: unknown; workspaces?: unknown }) || result.data.runner_id !== runnerId || result.data.revision !== revision || result.data.checksum !== checksum) return undefined;
    try {
      if (runnerPolicyChecksum({ schema_version: result.data.schema_version, runner_id: result.data.runner_id, revision: result.data.revision, runner_permissions: result.data.runner_permissions, workspaces: result.data.workspaces }) !== checksum) return undefined;
    } catch { return undefined; }
    if (new Set(result.data.workspaces.map((workspace) => workspace.workspace_id)).size !== result.data.workspaces.length) return undefined;
    return result.data;
  }

  public desiredPolicy(runnerId: string): RunnerPolicy | undefined {
    return this.getDesiredPolicySnapshot(runnerId);
  }

  public listPolicyVersions(runnerId: string): Array<{ runner_id: string; revision: number; checksum: string; policy_json: string; status: string; created_at_ms: number; acknowledged_at_ms: number | null; validation_summary_json: string | null; source_revision: number | null; mutation_id: string | null }> {
    return this.storage.sql.exec<PolicyVersionRow>("SELECT * FROM runner_policy_versions WHERE runner_id = ? ORDER BY revision DESC LIMIT 50", runnerId).toArray();
  }

  public listManagedWorkspaces(runnerId: string): WorkspaceRecord[] {
    return this.storage.sql.exec<ManagedWorkspaceRow>("SELECT * FROM managed_workspaces WHERE runner_id = ? ORDER BY created_at_ms, workspace_id", runnerId).toArray().flatMap((row) => decodeWorkspace(row));
  }

  public getManagedWorkspace(runnerId: string, workspaceId: string): WorkspaceRecord | undefined {
    const row = this.storage.sql.exec<ManagedWorkspaceRow>("SELECT * FROM managed_workspaces WHERE runner_id = ? AND workspace_id = ?", runnerId, workspaceId).toArray()[0];
    return row === undefined ? undefined : decodeWorkspace(row)[0];
  }

  public createManagedWorkspace(runnerId: string, input: { workspace_id: string; display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number, mutationId?: string): WorkspaceRecord | undefined {
    if (this.ports.runnerRow(runnerId) === undefined || !validWorkspaceInput(input) || !validOptionalMutationId(mutationId)) return undefined;
    const fingerprint = policyMutationFingerprint("workspace_create", input);
    try {
      this.storage.transactionSync(() => {
        const mutation = mutationId === undefined ? "new" : this.policyMutationStatus(runnerId, mutationId, "workspace_create", fingerprint);
        if (mutation === "conflict") throw new Error("policy mutation conflict");
        if (mutation === "committed") return;
        this.storage.sql.exec(`INSERT INTO managed_workspaces (runner_id, workspace_id, display_name, root_path, enabled, permissions_json, created_at_ms, updated_at_ms, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`, runnerId, input.workspace_id, input.display_name, input.root_path, input.enabled ? 1 : 0, JSON.stringify(input.permissions), nowMs, nowMs);
        const revision = this.bumpDesiredPolicy(runnerId, nowMs, mutationId);
        if (mutationId !== undefined) this.recordPolicyMutation(runnerId, mutationId, "workspace_create", fingerprint, revision, nowMs);
      });
    } catch (error) { if (expectedRegistryConflict(error, ["policy mutation conflict"])) return undefined; throw error; }
    return this.getManagedWorkspace(runnerId, input.workspace_id);
  }

  public updateManagedWorkspace(runnerId: string, workspaceId: string, input: { display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number, mutationId?: string): WorkspaceRecord | undefined {
    if (!isSafeIdentifier(workspaceId) || !validWorkspaceInput({ workspace_id: workspaceId, ...input }) || !validOptionalMutationId(mutationId) || this.ports.runnerRow(runnerId) === undefined) return undefined;
    const fingerprint = policyMutationFingerprint("workspace_update", { workspace_id: workspaceId, ...input });
    try {
      this.storage.transactionSync(() => {
        const mutation = mutationId === undefined ? "new" : this.policyMutationStatus(runnerId, mutationId, "workspace_update", fingerprint);
        if (mutation === "conflict") throw new Error("policy mutation conflict");
        if (mutation === "committed") return;
        if (this.getManagedWorkspace(runnerId, workspaceId) === undefined) throw new Error("workspace not found");
        this.storage.sql.exec(`UPDATE managed_workspaces SET display_name = ?, root_path = ?, enabled = ?, permissions_json = ?, updated_at_ms = ?, revision = revision + 1, validation_status = NULL
          WHERE runner_id = ? AND workspace_id = ?`, input.display_name, input.root_path, input.enabled ? 1 : 0, JSON.stringify(input.permissions), nowMs, runnerId, workspaceId);
        const revision = this.bumpDesiredPolicy(runnerId, nowMs, mutationId);
        if (mutationId !== undefined) this.recordPolicyMutation(runnerId, mutationId, "workspace_update", fingerprint, revision, nowMs);
      });
    } catch (error) { if (expectedRegistryConflict(error, ["policy mutation conflict", "workspace not found"])) return undefined; throw error; }
    return this.getManagedWorkspace(runnerId, workspaceId);
  }

  public deleteManagedWorkspace(runnerId: string, workspaceId: string, nowMs: number, mutationId?: string): boolean {
    if (!isSafeIdentifier(workspaceId) || !validOptionalMutationId(mutationId)) return false;
    return this.storage.transactionSync(() => {
      const fingerprint = policyMutationFingerprint("workspace_delete", { workspace_id: workspaceId });
      const mutation = mutationId === undefined ? "new" : this.policyMutationStatus(runnerId, mutationId, "workspace_delete", fingerprint);
      if (mutation === "conflict") return false;
      if (mutation === "committed") return true;
      const result = this.storage.sql.exec("DELETE FROM managed_workspaces WHERE runner_id = ? AND workspace_id = ?", runnerId, workspaceId);
      if (result.rowsWritten !== 1) return false;
      const revision = this.bumpDesiredPolicy(runnerId, nowMs, mutationId);
      if (mutationId !== undefined) this.recordPolicyMutation(runnerId, mutationId, "workspace_delete", fingerprint, revision, nowMs);
      return true;
    });
  }

  public setRunnerPermissions(runnerId: string, permissions: PermissionSet, nowMs: number, mutationId?: string): RunnerRecord | undefined {
    if (this.ports.runnerRow(runnerId) === undefined || !validPermissionSet(permissions) || !validOptionalMutationId(mutationId)) return undefined;
    return this.setRunnerPermissionsWithKind(runnerId, permissions, nowMs, mutationId, "permissions");
  }

  public setRunnerPermissionsWithKind(runnerId: string, permissions: PermissionSet, nowMs: number, mutationId: string | undefined, kind: "permissions" | "emergency_lock"): RunnerRecord | undefined {
    const fingerprint = policyMutationFingerprint(kind, { permissions });
    try {
      this.storage.transactionSync(() => {
        const mutation = mutationId === undefined ? "new" : this.policyMutationStatus(runnerId, mutationId, kind, fingerprint);
        if (mutation === "conflict") throw new Error("policy mutation conflict");
        if (mutation === "committed") return;
        this.storage.sql.exec("UPDATE runners SET runner_permissions_json = ?, updated_at_ms = ? WHERE runner_id = ?", JSON.stringify(permissions), nowMs, runnerId);
        const revision = this.bumpDesiredPolicy(runnerId, nowMs, mutationId);
        if (mutationId !== undefined) this.recordPolicyMutation(runnerId, mutationId, kind, fingerprint, revision, nowMs);
      });
    } catch (error) { if (expectedRegistryConflict(error, ["policy mutation conflict"])) return undefined; throw error; }
    return this.ports.getRunner(runnerId);
  }

  public emergencyLockRunner(runnerId: string, confirmation: string, nowMs: number, mutationId?: string): RunnerRecord | undefined { return confirmation === runnerId ? this.setRunnerPermissionsWithKind(runnerId, LOCKED_PERMISSIONS, nowMs, mutationId, "emergency_lock") : undefined; }

  public acknowledgePolicy(runnerId: string, epoch: number, credentialVersion: number, input: { desired_revision: number; desired_checksum: string; applied_revision: number | null; applied_checksum: string | null; runner_reported_policy_revision: number | null; runner_reported_policy_checksum: string | null; status: "applied" | "pending" | "invalid"; workspace_status: readonly { workspace_id: string; status: WorkspaceValidationStatus }[] }, nowMs: number, lifecycleId: string, sessionId: string): PolicyAcknowledgementResult | undefined {
    if (!this.ports.sessionIsCurrent(runnerId, epoch, credentialVersion, true, lifecycleId, sessionId) || input.workspace_status.length > 64 || !uniqueIds(input.workspace_status.map((item) => item.workspace_id)) || input.workspace_status.some((item) => !isSafeIdentifier(item.workspace_id))) return undefined;
    const runner = this.ports.runnerRow(runnerId);
    const desired = runner === undefined ? undefined : this.desiredPolicy(runnerId);
    if (runner === undefined || desired === undefined) return undefined;
    if (input.desired_revision < runner.desired_policy_revision) return "stale";
    const expectedStatuses = desired.workspaces.map((workspace) => workspace.workspace_id).sort();
    const actualStatuses = input.workspace_status.map((item) => item.workspace_id).sort();
    const appliedPair = (input.applied_revision === null) === (input.applied_checksum === null);
    const reportedPair = (input.runner_reported_policy_revision === null) === (input.runner_reported_policy_checksum === null);
    if (!appliedPair || !reportedPair || input.applied_revision !== input.runner_reported_policy_revision || input.applied_checksum !== input.runner_reported_policy_checksum) return undefined;
    if (input.desired_revision !== runner.desired_policy_revision || input.desired_checksum !== desired.checksum || actualStatuses.length !== expectedStatuses.length || actualStatuses.some((id, index) => id !== expectedStatuses[index])) return undefined;
    if (input.status === "applied" && (input.applied_revision !== input.desired_revision || input.applied_checksum !== input.desired_checksum || input.workspace_status.some((item) => item.status !== "valid"))) return undefined;
    if (input.status !== "applied" && input.applied_revision !== runner.applied_policy_revision && !(input.applied_revision === null && runner.applied_policy_revision === null)) return undefined;
    if (input.status === "invalid" && input.applied_revision !== runner.applied_policy_revision) return undefined;
    const result = this.storage.transactionSync<PolicyAcknowledgementResult | undefined>(() => {
      const current = this.ports.runnerRow(runnerId);
      // The initial session check above is only an optimistic read. A revoke,
      // reconnect, heartbeat timeout, or newer connection can win before this
      // transaction starts. Re-check the complete session fence while holding
      // the transaction so an old Runner cannot acknowledge policy for a newer
      // credential/connection and make protected RPCs appear ready.
      if (current === undefined || current.connection_epoch !== epoch || current.credential_version !== credentialVersion || current.state !== "online" || !matchesTransportIdentity(current, lifecycleId, sessionId)
        || current.desired_policy_revision !== input.desired_revision || current.desired_policy_checksum !== input.desired_checksum) return undefined;
      const version = this.storage.sql.exec<PolicyVersionRow>("SELECT * FROM runner_policy_versions WHERE runner_id = ? AND revision = ?", runnerId, input.desired_revision).toArray()[0];
      if (version === undefined || version.checksum !== input.desired_checksum) return undefined;
      // Keep the complete transport identity in the conditional write as well
      // as the transaction read. This prevents a delayed socket from
      // acknowledging a replacement lifecycle even if the read/write split is
      // changed in a future refactor.
      const fence = " AND connection_epoch = ? AND credential_version = ? AND state = 'online' AND desired_policy_revision = ? AND desired_policy_checksum = ? AND lifecycle_id = ? AND session_id = ?";
      if (input.status === "invalid") {
        const updated = this.storage.sql.exec(`UPDATE runners SET runner_reported_policy_revision = ?, runner_reported_policy_checksum = ?, policy_status = ?, policy_acked_at_ms = ?, policy_error_code = ?, updated_at_ms = ? WHERE runner_id = ?${fence}`, input.runner_reported_policy_revision, input.runner_reported_policy_checksum, input.status, nowMs, "policy_validation_failed", nowMs, runnerId, epoch, credentialVersion, input.desired_revision, input.desired_checksum, lifecycleId, sessionId);
        if (updated.rowsWritten !== 1) return undefined;
      } else {
        const updated = this.storage.sql.exec(`UPDATE runners SET applied_policy_revision = ?, active_policy_checksum = ?, runner_reported_policy_revision = ?, runner_reported_policy_checksum = ?, policy_status = ?, policy_acked_at_ms = ?, updated_at_ms = ? WHERE runner_id = ?${fence}`, input.applied_revision, input.applied_checksum, input.runner_reported_policy_revision, input.runner_reported_policy_checksum, input.status, nowMs, nowMs, runnerId, epoch, credentialVersion, input.desired_revision, input.desired_checksum, lifecycleId, sessionId);
        if (updated.rowsWritten !== 1) return undefined;
      }
      this.storage.sql.exec("UPDATE runner_policy_versions SET status = ?, acknowledged_at_ms = ?, validation_summary_json = ? WHERE runner_id = ? AND revision = ?", input.status, nowMs, JSON.stringify(input.workspace_status), runnerId, input.desired_revision);
      for (const item of input.workspace_status) this.storage.sql.exec("UPDATE managed_workspaces SET validation_status = ? WHERE runner_id = ? AND workspace_id = ?", item.status, runnerId, item.workspace_id);
      return input.status === "applied" ? "applied" : "invalid";
    });
    return result;
  }

  public policyMutationRow(runnerId: string, mutationId: string): PolicyMutationRow | undefined {
    return this.storage.sql.exec<PolicyMutationRow>("SELECT runner_id, mutation_id, kind, fingerprint, revision, committed_at_ms FROM runner_policy_mutations WHERE runner_id = ? AND mutation_id = ?", runnerId, mutationId).toArray()[0];
  }

  public policyMutationStatus(runnerId: string, mutationId: string, kind: PolicyMutationKind, fingerprint: string): "new" | "committed" | "conflict" {
    const existing = this.policyMutationRow(runnerId, mutationId);
    if (existing === undefined) return "new";
    return existing.kind === kind && existing.fingerprint === fingerprint ? "committed" : "conflict";
  }

  public recordPolicyMutation(runnerId: string, mutationId: string, kind: PolicyMutationKind, fingerprint: string, revision: number, nowMs: number): void {
    this.storage.sql.exec("INSERT INTO runner_policy_mutations (runner_id, mutation_id, kind, fingerprint, revision, committed_at_ms) VALUES (?, ?, ?, ?, ?, ?)", runnerId, mutationId, kind, fingerprint, revision, nowMs);
  }

  public bumpDesiredPolicy(runnerId: string, nowMs: number, mutationId?: string): number {
    const runner = this.ports.runnerRow(runnerId);
    if (runner === undefined) throw new Error("runner not found");
    const revision = Math.max(1, runner.desired_policy_revision + 1);
    this.createPolicySnapshot(runnerId, revision, nowMs, runner.desired_policy_revision > 0 ? runner.desired_policy_revision : null, mutationId ?? crypto.randomUUID());
    return revision;
  }

  public createPolicySnapshot(runnerId: string, revision: number, nowMs: number, sourceRevision: number | null, mutationId: string): void {
    const runner = this.ports.runnerRow(runnerId);
    if (runner === undefined) throw new Error("runner not found");
    const unsigned = {
      schema_version: 1 as const,
      runner_id: runnerId,
      revision,
      runner_permissions: parsePermissionSet(runner.runner_permissions_json) ?? LOCKED_PERMISSIONS,
      workspaces: this.listManagedWorkspaces(runnerId).map((workspace) => ({ workspace_id: workspace.workspace_id, root_path: workspace.root_path, enabled: workspace.enabled, permissions: workspace.permissions })),
    };
    const checksum = runnerPolicyChecksum(unsigned);
    const policy = { ...unsigned, checksum };
    this.storage.sql.exec("INSERT INTO runner_policy_versions (runner_id, revision, checksum, policy_json, status, created_at_ms, acknowledged_at_ms, validation_summary_json, source_revision, mutation_id) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)", runnerId, revision, checksum, JSON.stringify(policy), nowMs, sourceRevision, mutationId);
    this.storage.sql.exec("UPDATE runners SET desired_policy_revision = ?, desired_policy_checksum = ?, policy_status = ?, policy_updated_at_ms = ?, updated_at_ms = ? WHERE runner_id = ?", revision, checksum, runner.state === "online" ? "pending" : "offline_pending", nowMs, nowMs, runnerId);
    this.storage.sql.exec("DELETE FROM runner_policy_versions WHERE runner_id = ? AND revision NOT IN (SELECT revision FROM runner_policy_versions WHERE runner_id = ? ORDER BY revision DESC LIMIT 50) AND revision <> COALESCE((SELECT desired_policy_revision FROM runners WHERE runner_id = ?), -1) AND revision <> COALESCE((SELECT applied_policy_revision FROM runners WHERE runner_id = ?), -1)", runnerId, runnerId, runnerId, runnerId);
  }
}
