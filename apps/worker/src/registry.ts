import {
  JobCompletedSchema,
  JobStartedSchema,
  JobStatusMessageSchema,
  IdentifierSchema,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  RunnerMetadataSchema,
  RunnerPolicySchema,
  RunnerSyncSchema,
  intersectPermissionSets,
  permissionSetFromScopes,
  runnerPolicyChecksum,
  validatePermissionSet,
  type RunnerMetadata,
  type RunnerPolicy,
} from "@aloneio/runmesh-protocol";
import { constantTimeEqual, isSafeIdentifier, runnerTokenVerifier, verifyInternalRequest } from "./security.js";

export type RunnerConnectionState = "online" | "offline" | "stale";

export type PolicyReadiness =
  | {
      readonly ok: true;
      readonly desired_revision: number;
      readonly desired_checksum: string;
      readonly applied_revision: number;
      readonly active_checksum: string;
      readonly runner_reported_policy_revision: number;
      readonly runner_reported_policy_checksum: string;
      readonly connection_epoch: number;
      readonly credential_version: number;
      readonly session_id: string;
    }
  | { readonly ok: false; readonly code: "policy_pending" | "stale_policy"; readonly reason: string };
export type CodingScope = "coding:read" | "coding:write" | "coding:exec";
const VALID_SCOPES = new Set<CodingScope>(["coding:read", "coding:write", "coding:exec"]);

export type PermissionBit = "read" | "edit" | "shell" | "job_control";
export type PermissionSet = Record<PermissionBit, boolean>;
export type RunnerProfilePreset = "locked" | "read_only" | "coding" | "full_control";
export type WorkspaceValidationStatus = "valid" | "missing" | "not_directory" | "permission_denied" | "invalid_path";
export type RunnerUpdateChannel = "stable" | "pinned";
export type RunnerProtocolCompatibility = "unknown" | "compatible" | "incompatible";
export type RunnerUpdateStatus = "unknown" | "up_to_date" | "update_available" | "pinned" | "incompatible";
const LOCKED_PERMISSIONS: PermissionSet = { read: false, edit: false, shell: false, job_control: false };
const READ_ONLY_PERMISSIONS: PermissionSet = { read: true, edit: false, shell: false, job_control: false };

export interface RunnerPublicInfo {
  readonly platform: string;
  readonly architecture: string;
  readonly hostname: string;
  readonly runner_version: string;
  readonly protocol_version: number;
}
export interface RunnerRecord {
  readonly runner_id: string;
  readonly display_name: string;
  readonly state: RunnerConnectionState;
  readonly connection_epoch: number;
  readonly credential_version: number;
  readonly management_mode: "central" | "legacy_local";
  readonly session_id: string | null;
  readonly metadata: RunnerMetadata | null;
  /** Safe enrollment-time identity/version data, intentionally excluding paths and credentials. */
  readonly public_info: RunnerPublicInfo | null;
  readonly last_heartbeat_ms: number | null;
  readonly last_sync_sequence: number | null;
  readonly desired_policy_revision: number;
  readonly desired_policy_checksum: string | null;
  readonly applied_policy_revision: number | null;
  readonly active_policy_checksum: string | null;
  readonly runner_reported_policy_revision: number | null;
  readonly runner_reported_policy_checksum: string | null;
  readonly policy_status: "pending" | "offline_pending" | "applied" | "invalid";
  readonly runner_permissions: PermissionSet;
  /** Last actual Runner package/version observed at enrollment or handshake. */
  readonly current_runner_version: string | null;
  readonly protocol_min_version: number | null;
  readonly protocol_max_version: number | null;
  readonly protocol_compatibility: RunnerProtocolCompatibility;
  readonly update_channel: RunnerUpdateChannel;
  /** The exact requested version when the operator pins this Runner. */
  readonly desired_runner_version: string | null;
  /** Last stable descriptor version observed by an admin policy save. */
  readonly latest_runner_version: string | null;
  readonly update_status: RunnerUpdateStatus;
  readonly updated_at_ms: number;
}
export interface WorkspaceRecord {
  readonly runner_id: string;
  readonly workspace_id: string;
  readonly display_name: string;
  /** Admin/control-plane only; never use this type in MCP output. */
  readonly root_path: string;
  readonly enabled: boolean;
  readonly permissions: PermissionSet;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly revision: number;
  readonly validation_status: WorkspaceValidationStatus | null;
}
export interface DashboardRunnerRecord extends RunnerRecord {
  readonly workspace_count: number;
  readonly active_job_count: number;
}
export interface DashboardJobRecord {
  readonly runner_id: string;
  readonly job_id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly updated_at_ms: number;
}
export interface DashboardSnapshot {
  readonly runners: readonly DashboardRunnerRecord[];
  readonly jobs: readonly DashboardJobRecord[];
}
export interface McpClientRecord {
  readonly client_id: string;
  readonly label: string;
  readonly secret_prefix: string;
  readonly scopes: readonly CodingScope[];
  readonly secret_version: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly last_used_at_ms: number | null;
  readonly revoked_at_ms: number | null;
  /** Per-client MCP routing state. It survives client rename and key rotation. */
  readonly active_runner_id: string | null;
  readonly active_runner_updated_at_ms: number | null;
}
export interface ActiveRunnerContext {
  readonly runner_id: string;
  readonly state: RunnerConnectionState | "unavailable";
  readonly available: boolean;
  readonly updated_at_ms: number | null;
}
export interface McpClientActiveRunner {
  readonly active_runner_id: string | null;
  readonly active_runner_updated_at_ms: number | null;
  readonly runner: ActiveRunnerContext | null;
}
export type McpRunnerSelectionResult =
  | { readonly ok: true; readonly selection: McpClientActiveRunner; readonly changed: boolean }
  | { readonly ok: false; readonly code: "client_not_found" | "runner_not_found" | "runner_unavailable" | "runner_switch_confirmation_required"; readonly selection?: McpClientActiveRunner };
export interface VerifiedMcpClient {
  readonly client_id: string;
  readonly label: string;
  readonly scopes: readonly CodingScope[];
  readonly secret_version: number;
}

type RunnerRow = {
  runner_id: string;
  display_name: string;
  token_verifier: string;
  state: RunnerConnectionState;
  connection_epoch: number;
  credential_version: number;
  management_mode: "central" | "legacy_local";
  session_id: string | null;
  metadata_json: string | null;
  public_info_json: string | null;
  last_heartbeat_ms: number | null;
  last_sync_sequence: number | null;
  desired_policy_revision: number;
  desired_policy_checksum: string | null;
  applied_policy_revision: number | null;
  active_policy_checksum: string | null;
  runner_reported_policy_revision: number | null;
  runner_reported_policy_checksum: string | null;
  policy_status: "pending" | "offline_pending" | "applied" | "invalid";
  runner_permissions_json: string;
  current_runner_version: string | null;
  protocol_min_version: number | null;
  protocol_max_version: number | null;
  protocol_compatibility: RunnerProtocolCompatibility;
  update_channel: RunnerUpdateChannel;
  desired_runner_version: string | null;
  latest_runner_version: string | null;
  update_status: RunnerUpdateStatus;
  updated_at_ms: number;
};
type EnrollmentRow = { enrollment_id: string; runner_id: string; verifier: string; created_at_ms: number; expires_at_ms: number; used_at_ms: number | null };
type PolicyVersionRow = {
  runner_id: string; revision: number; checksum: string; policy_json: string; status: string;
  created_at_ms: number; acknowledged_at_ms: number | null; validation_summary_json: string | null;
  source_revision: number | null; mutation_id: string | null;
};

type WorkspaceRow = { workspace_json: string };
type ManagedWorkspaceRow = {
  runner_id: string; workspace_id: string; display_name: string; root_path: string; enabled: number;
  permissions_json: string; created_at_ms: number; updated_at_ms: number; revision: number; validation_status: WorkspaceValidationStatus | null;
};
type JobRow = { job_json: string };
type AdminSettingsRow = { password_verifier: string; session_version: number; created_at_ms: number; updated_at_ms: number };
type AuthThrottleRow = { id: string; failed_attempts: number; blocked_until_ms: number; updated_at_ms: number };
type AuthThrottleKind = "login" | "setup";
type SessionRow = { csrf_hash: string; expires_at_ms: number; session_version: number };
type McpClientRow = {
  client_id: string; label: string; secret_verifier: string; secret_prefix: string; scopes_json: string;
  secret_version: number; created_at_ms: number; updated_at_ms: number; last_used_at_ms: number | null; revoked_at_ms: number | null;
  active_runner_id: string | null; active_runner_updated_at_ms: number | null;
};
type InternalInput = Record<string, unknown>;
const MAX_INTERNAL_BODY_BYTES = 1_048_576;
const MAX_SYNC_ITEMS = 1_000;
/** Keep active jobs indefinitely; only old terminal metadata is bounded. */
const MAX_TERMINAL_JOBS_PER_RUNNER = 1_000;
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "succeeded", "failed", "interrupted"]);
const CLIENT_LAST_USED_WRITE_INTERVAL_MS = 60_000;
const RUNNER_ENROLLMENT_TTL_MS = 30 * 60 * 1_000;
const AUTH_THROTTLE_FAILURE_THRESHOLD = 5;
const AUTH_THROTTLE_INITIAL_BLOCK_MS = 30_000;
const AUTH_THROTTLE_MAX_BLOCK_MS = 15 * 60_000;

/**
 * Global Registry durable object. In addition to Runner metadata, it owns the
 * self-hosted single-admin state. Browser/MCP credentials never bypass the
 * Worker: every Registry entrypoint still requires Worker/RunnerDO HMAC proof.
 */
export class RegistryDO {
  public constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: { INTERNAL_CONTROL_SECRET?: string; RUNNER_TOKEN_PEPPER?: string },
  ) {
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS runners (
          runner_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_verifier TEXT NOT NULL, state TEXT NOT NULL,
          connection_epoch INTEGER NOT NULL DEFAULT 0, credential_version INTEGER NOT NULL DEFAULT 1, management_mode TEXT NOT NULL DEFAULT 'legacy_local',
          session_id TEXT, metadata_json TEXT, public_info_json TEXT, last_heartbeat_ms INTEGER, last_sync_sequence INTEGER,
          desired_policy_revision INTEGER NOT NULL DEFAULT 0, desired_policy_checksum TEXT, applied_policy_revision INTEGER, active_policy_checksum TEXT,
          runner_reported_policy_revision INTEGER, runner_reported_policy_checksum TEXT, policy_status TEXT NOT NULL DEFAULT 'pending',
          policy_error_code TEXT, policy_updated_at_ms INTEGER, policy_acked_at_ms INTEGER,
          runner_permissions_json TEXT NOT NULL DEFAULT '{"read":false,"edit":false,"shell":false,"job_control":false}',
          current_runner_version TEXT, protocol_min_version INTEGER, protocol_max_version INTEGER,
          protocol_compatibility TEXT NOT NULL DEFAULT 'unknown', update_channel TEXT NOT NULL DEFAULT 'stable',
          desired_runner_version TEXT, latest_runner_version TEXT, update_status TEXT NOT NULL DEFAULT 'unknown', updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runner_policy_versions (
          runner_id TEXT NOT NULL, revision INTEGER NOT NULL, checksum TEXT NOT NULL, policy_json TEXT NOT NULL,
          status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, acknowledged_at_ms INTEGER,
          validation_summary_json TEXT, source_revision INTEGER, mutation_id TEXT,
          PRIMARY KEY (runner_id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_runner_policy_versions_retention ON runner_policy_versions(runner_id, revision DESC);
        CREATE TABLE IF NOT EXISTS workspaces (
          runner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL, PRIMARY KEY (runner_id, workspace_id)
        );
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
        CREATE TABLE IF NOT EXISTS admin_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1), password_verifier TEXT NOT NULL,
          session_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_throttle (
          id TEXT PRIMARY KEY CHECK (id IN ('login', 'setup')), failed_attempts INTEGER NOT NULL DEFAULT 0,
          blocked_until_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
        );
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
          created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_runner_enrollments_expiry ON runner_enrollments(expires_at_ms);
        CREATE INDEX IF NOT EXISTS idx_runner_enrollments_runner ON runner_enrollments(runner_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_clients_secret ON mcp_clients(secret_verifier);
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at_ms);
      `);
      this.ensureSchema();
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    });
  }

  public async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = 'stale', updated_at_ms = ?
       WHERE state = 'online' AND (last_heartbeat_ms IS NULL OR last_heartbeat_ms < ?)`, nowMs, nowMs - 45_000,
    );
    this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE expires_at_ms <= ?", nowMs);
    this.ctx.storage.sql.exec("DELETE FROM internal_request_nonces WHERE expires_at_ms <= ?", nowMs);
    // Used enrollment records have no continuing value; retain unexpired rows only.
    this.ctx.storage.sql.exec("DELETE FROM runner_enrollments WHERE expires_at_ms <= ? OR used_at_ms IS NOT NULL", nowMs);
    await this.ctx.storage.setAlarm(nowMs + 30_000);
  }

  /** Atomically remembers a verified nonce until its signed request expires. */
  public consumeInternalNonce(nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean {
    if (!/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM internal_request_nonces WHERE expires_at_ms <= ?", nowMs);
      try {
        this.ctx.storage.sql.exec("INSERT INTO internal_request_nonces (nonce, expires_at_ms) VALUES (?, ?)", nonce, expiresAtMs);
        return true;
      } catch {
        return false;
      }
    });
  }

  public adminStatus(): { initialized: boolean } { return { initialized: this.settings() !== undefined }; }
  public adminPasswordVerifier(): string | undefined { return this.settings()?.password_verifier; }

  /**
   * Atomically reserve a password-KDF attempt. Reserving before the KDF prevents
   * concurrent Worker requests from racing past the per-instance limit. A
   * successful record clears it; a failed record preserves the reservation.
   */
  public checkAuthThrottle(kind: AuthThrottleKind, nowMs: number): { allowed: boolean; retry_after_ms: number } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.authThrottleRow(kind);
      const retryAfter = row === undefined ? 0 : Math.max(0, row.blocked_until_ms - nowMs);
      if (retryAfter > 0) return { allowed: false, retry_after_ms: retryAfter };
      const failedAttempts = (row?.failed_attempts ?? 0) + 1;
      const exponent = Math.min(Math.max(0, failedAttempts - AUTH_THROTTLE_FAILURE_THRESHOLD), 30);
      const blockMs = failedAttempts < AUTH_THROTTLE_FAILURE_THRESHOLD
        ? 0
        : Math.min(AUTH_THROTTLE_MAX_BLOCK_MS, AUTH_THROTTLE_INITIAL_BLOCK_MS * (2 ** exponent));
      this.ctx.storage.sql.exec(
        `INSERT INTO auth_throttle (id, failed_attempts, blocked_until_ms, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET failed_attempts = excluded.failed_attempts, blocked_until_ms = excluded.blocked_until_ms, updated_at_ms = excluded.updated_at_ms`,
        kind, failedAttempts, blockMs === 0 ? 0 : nowMs + blockMs, nowMs,
      );
      // The attempt that reaches the threshold is admitted; only subsequent
      // attempts are blocked, so this means five failed KDFs then a delay.
      return { allowed: true, retry_after_ms: 0 };
    });
  }

  /** Record only the outcome of a credential operation; no password is stored. */
  public recordAuthAttempt(kind: AuthThrottleKind, success: boolean, nowMs: number): void {
    if (!success) {
      // checkAuthThrottle already reserved and persisted the failure before the
      // expensive KDF. Keep an outcome timestamp without exposing any secret.
      this.ctx.storage.sql.exec("UPDATE auth_throttle SET updated_at_ms = ? WHERE id = ?", nowMs, kind);
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO auth_throttle (id, failed_attempts, blocked_until_ms, updated_at_ms) VALUES (?, 0, 0, ?)
       ON CONFLICT(id) DO UPDATE SET failed_attempts = 0, blocked_until_ms = 0, updated_at_ms = excluded.updated_at_ms`,
      kind, nowMs,
    );
  }

  /** Compare-and-set setup. transactionSync makes two concurrent first setup requests deterministic. */
  public setupAdmin(passwordVerifier: string, nowMs: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.settings() !== undefined) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO admin_settings (id, password_verifier, session_version, created_at_ms, updated_at_ms) VALUES (1, ?, 1, ?, ?)",
        passwordVerifier, nowMs, nowMs,
      );
      return true;
    });
  }

  public createAdminSession(sessionHash: string, csrfHash: string, expiresAtMs: number, nowMs: number): boolean {
    const settings = this.settings();
    if (settings === undefined) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO admin_sessions (session_hash, csrf_hash, created_at_ms, expires_at_ms, session_version) VALUES (?, ?, ?, ?, ?)",
      sessionHash, csrfHash, nowMs, expiresAtMs, settings.session_version,
    );
    return true;
  }

  public verifyAdminSession(sessionHash: string, nowMs: number): { csrf_hash: string } | undefined {
    const row = this.ctx.storage.sql.exec<SessionRow>(
      `SELECT s.csrf_hash, s.expires_at_ms, s.session_version FROM admin_sessions s
       JOIN admin_settings a ON a.id = 1 WHERE s.session_hash = ?`, sessionHash,
    ).toArray()[0];
    const settings = this.settings();
    if (row === undefined || settings === undefined || row.expires_at_ms <= nowMs || row.session_version !== settings.session_version) {
      if (row !== undefined) this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE session_hash = ?", sessionHash);
      return undefined;
    }
    return { csrf_hash: row.csrf_hash };
  }

  public logoutAdminSession(sessionHash: string): void { this.ctx.storage.sql.exec("DELETE FROM admin_sessions WHERE session_hash = ?", sessionHash); }

  /** Replacing the password increments session_version and removes every opaque session. */
  public changeAdminPassword(passwordVerifier: string, nowMs: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.settings() === undefined) return false;
      this.ctx.storage.sql.exec(
        "UPDATE admin_settings SET password_verifier = ?, session_version = session_version + 1, updated_at_ms = ? WHERE id = 1",
        passwordVerifier, nowMs,
      );
      this.ctx.storage.sql.exec("DELETE FROM admin_sessions");
      return true;
    });
  }

  public listMcpClients(): McpClientRecord[] {
    return this.ctx.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients ORDER BY created_at_ms DESC, client_id").toArray().map(decodeMcpClient);
  }
  public createMcpClient(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string; scopes: readonly CodingScope[] }, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(input.client_id) || !validLabel(input.label) || !validScopes(input.scopes) || !validVerifier(input.secret_verifier) || !/^[A-Za-z0-9_-]{4,16}$/.test(input.secret_prefix)) return undefined;
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO mcp_clients (client_id, label, secret_verifier, secret_prefix, scopes_json, secret_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, input.client_id, input.label, input.secret_verifier, input.secret_prefix, JSON.stringify(input.scopes), nowMs, nowMs,
      );
    } catch { return undefined; }
    return this.getMcpClient(input.client_id);
  }
  public renameMcpClient(clientId: string, label: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId) || !validLabel(label)) return undefined;
    this.ctx.storage.sql.exec("UPDATE mcp_clients SET label = ?, updated_at_ms = ? WHERE client_id = ?", label, nowMs, clientId);
    return this.getMcpClient(clientId);
  }
  public rotateMcpClient(clientId: string, secretVerifier: string, secretPrefix: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId) || !validVerifier(secretVerifier) || !/^[A-Za-z0-9_-]{4,16}$/.test(secretPrefix)) return undefined;
    try {
      this.ctx.storage.sql.exec(
        `UPDATE mcp_clients SET secret_verifier = ?, secret_prefix = ?, secret_version = secret_version + 1,
         revoked_at_ms = NULL, updated_at_ms = ? WHERE client_id = ?`, secretVerifier, secretPrefix, nowMs, clientId,
      );
    } catch { return undefined; }
    return this.getMcpClient(clientId);
  }
  public revokeMcpClient(clientId: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId)) return undefined;
    this.ctx.storage.sql.exec("UPDATE mcp_clients SET revoked_at_ms = ?, updated_at_ms = ? WHERE client_id = ?", nowMs, nowMs, clientId);
    return this.getMcpClient(clientId);
  }
  /** Live verifier lookup makes rotate/revoke effective on the next MCP request. */
  public verifyMcpClient(secretVerifier: string, nowMs: number): VerifiedMcpClient | undefined {
    if (!validVerifier(secretVerifier)) return undefined;
    const row = this.ctx.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients WHERE secret_verifier = ?", secretVerifier).toArray()[0];
    if (row === undefined || row.revoked_at_ms !== null) return undefined;
    const scopes = parseScopes(row.scopes_json);
    if (scopes === undefined) return undefined;
    if (row.last_used_at_ms === null || row.last_used_at_ms <= nowMs - CLIENT_LAST_USED_WRITE_INTERVAL_MS) {
      this.ctx.storage.sql.exec("UPDATE mcp_clients SET last_used_at_ms = ? WHERE client_id = ?", nowMs, row.client_id);
    }
    return { client_id: row.client_id, label: row.label, scopes, secret_version: row.secret_version };
  }

  public setClientRunnerOverride(clientId: string, runnerId: string, permissions: PermissionSet, nowMs: number): boolean {
    if (!isSafeIdentifier(clientId) || !isSafeIdentifier(runnerId) || this.getMcpClient(clientId) === undefined || this.runnerRow(runnerId) === undefined || !validPermissionSet(permissions)) return false;
    this.ctx.storage.sql.exec(`INSERT INTO client_runner_overrides (client_id, runner_id, permissions_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id, runner_id) DO UPDATE SET permissions_json = excluded.permissions_json, updated_at_ms = excluded.updated_at_ms`, clientId, runnerId, JSON.stringify(permissions), nowMs, nowMs);
    return true;
  }
  public clientRunnerPermissions(clientId: string, runnerId: string): PermissionSet | undefined {
    const row = this.ctx.storage.sql.exec<{ permissions_json: string }>("SELECT permissions_json FROM client_runner_overrides WHERE client_id = ? AND runner_id = ?", clientId, runnerId).toArray()[0];
    return row === undefined ? undefined : parsePermissionSet(row.permissions_json);
  }
  public listClientRunnerOverrides(clientId: string): Array<{ runner_id: string; permissions: PermissionSet }> {
    return this.ctx.storage.sql.exec<{ runner_id: string; permissions_json: string }>("SELECT runner_id, permissions_json FROM client_runner_overrides WHERE client_id = ? ORDER BY runner_id", clientId).toArray().flatMap((row) => {
      const permissions = parsePermissionSet(row.permissions_json);
      return permissions === undefined ? [] : [{ runner_id: row.runner_id, permissions }];
    });
  }
  public deleteClientRunnerOverride(clientId: string, runnerId: string): boolean {
    if (!isSafeIdentifier(clientId) || !isSafeIdentifier(runnerId)) return false;
    return this.ctx.storage.sql.exec("DELETE FROM client_runner_overrides WHERE client_id = ? AND runner_id = ?", clientId, runnerId).rowsWritten === 1;
  }
  public effectivePermissions(clientId: string, runnerId: string, workspaceId: string): PermissionSet | undefined {
    if (!this.getPolicyReadiness(runnerId).ok) return undefined;
    const client = this.getMcpClient(clientId);
    const policy = this.getActivePolicySnapshot(runnerId);
    if (client === undefined || policy === undefined) return undefined;
    const workspace = policy.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (workspace === undefined || !workspace.enabled) return undefined;
    const override = this.clientRunnerPermissions(clientId, runnerId) ?? { read: true, edit: true, shell: true, job_control: true };
    return intersectPermissionSets(permissionSetFromScopes(client.scopes), override, policy.runner_permissions, workspace.permissions);
  }

  /** Desired policy is exclusively the immutable desired revision row. */
  public getDesiredPolicySnapshot(runnerId: string): RunnerPolicy | undefined {
    const runner = this.runnerRow(runnerId);
    if (runner === undefined) return undefined;
    return this.policySnapshot(runnerId, runner.desired_policy_revision, runner.desired_policy_checksum);
  }

  /** Active policy is exclusively the immutable applied revision/checksum pair. */
  public getActivePolicySnapshot(runnerId: string): RunnerPolicy | undefined {
    const runner = this.runnerRow(runnerId);
    if (runner === undefined || runner.applied_policy_revision === null || runner.active_policy_checksum === null) return undefined;
    return this.policySnapshot(runnerId, runner.applied_policy_revision, runner.active_policy_checksum, "applied");
  }

  public getActiveWorkspacePolicy(runnerId: string, workspaceId: string): RunnerPolicy["workspaces"][number] | undefined {
    return this.getActivePolicySnapshot(runnerId)?.workspaces.find((workspace) => workspace.workspace_id === workspaceId);
  }

  /**
   * Protected operations require an established live session and an exact
   * desired/applied/reported immutable policy identity triad. Any missing or
   * malformed identity fails closed; mutable configuration is never consulted.
   */
  public getPolicyReadiness(runnerId: string): PolicyReadiness {
    const runner = this.runnerRow(runnerId);
    if (runner === undefined) return { ok: false, code: "stale_policy", reason: "runner is missing" };
    const checksum = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    if (runner.state !== "online" || !revision(runner.connection_epoch) || !revision(runner.credential_version) || typeof runner.session_id !== "string" || runner.session_id.length === 0) {
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
    const active = this.getActivePolicySnapshot(runnerId);
    const desired = this.getDesiredPolicySnapshot(runnerId);
    if (active === undefined || desired === undefined || active.revision !== runner.applied_policy_revision || active.checksum !== runner.active_policy_checksum
      || desired.revision !== runner.desired_policy_revision || desired.checksum !== runner.desired_policy_checksum) {
      return { ok: false, code: "stale_policy", reason: "immutable policy snapshot is unavailable" };
    }
    return {
      ok: true,
      desired_revision: runner.desired_policy_revision,
      desired_checksum: runner.desired_policy_checksum,
      applied_revision: runner.applied_policy_revision,
      active_checksum: runner.active_policy_checksum,
      runner_reported_policy_revision: runner.runner_reported_policy_revision,
      runner_reported_policy_checksum: runner.runner_reported_policy_checksum,
      connection_epoch: runner.connection_epoch,
      credential_version: runner.credential_version,
      session_id: runner.session_id,
    };
  }

  /** Resolve an MCP client's sticky runner selection without silently changing it. */
  public getMcpClientActiveRunner(clientId: string): McpClientActiveRunner | undefined {
    const client = this.getMcpClient(clientId);
    if (client === undefined) return undefined;
    return {
      active_runner_id: client.active_runner_id,
      active_runner_updated_at_ms: client.active_runner_updated_at_ms,
      runner: client.active_runner_id === null ? null : this.activeRunnerContext(client.active_runner_id, client.active_runner_updated_at_ms),
    };
  }
  /** First selection is direct; changing an existing selection requires explicit confirmation. */
  public selectMcpClientRunner(clientId: string, runnerId: string, confirmSwitch: boolean, nowMs: number): McpRunnerSelectionResult {
    if (!isSafeIdentifier(clientId)) return { ok: false, code: "client_not_found" };
    const target = isSafeIdentifier(runnerId) ? this.runnerRow(runnerId) : undefined;
    if (target === undefined) return { ok: false, code: "runner_not_found" };
    if (target.token_verifier.length === 0) return { ok: false, code: "runner_unavailable" };
    return this.ctx.storage.transactionSync(() => {
      const selection = this.getMcpClientActiveRunner(clientId);
      if (selection === undefined) return { ok: false, code: "client_not_found" };
      if (selection.active_runner_id !== null && selection.active_runner_id !== runnerId && !confirmSwitch) {
        return { ok: false, code: "runner_switch_confirmation_required", selection };
      }
      const changed = selection.active_runner_id !== runnerId;
      if (changed) this.ctx.storage.sql.exec(
        "UPDATE mcp_clients SET active_runner_id = ?, active_runner_updated_at_ms = ?, updated_at_ms = ? WHERE client_id = ?",
        runnerId, nowMs, nowMs, clientId,
      );
      const updated = this.getMcpClientActiveRunner(clientId);
      return updated === undefined ? { ok: false, code: "client_not_found" } : { ok: true, selection: updated, changed };
    });
  }
  public resetMcpClientRunner(clientId: string, nowMs: number): McpClientActiveRunner | undefined {
    if (!isSafeIdentifier(clientId) || this.getMcpClient(clientId) === undefined) return undefined;
    this.ctx.storage.sql.exec("UPDATE mcp_clients SET active_runner_id = NULL, active_runner_updated_at_ms = ?, updated_at_ms = ? WHERE client_id = ?", nowMs, nowMs, clientId);
    return this.getMcpClientActiveRunner(clientId);
  }
  /** A deterministic convenience selection for an unselected client only. */
  public autoSelectOnlyRunner(clientId: string, nowMs: number): McpRunnerSelectionResult | undefined {
    const selection = this.getMcpClientActiveRunner(clientId);
    if (selection === undefined) return { ok: false, code: "client_not_found" };
    if (selection.active_runner_id !== null) return { ok: true, selection, changed: false };
    const runners = this.listRunners();
    if (runners.length !== 1) return undefined;
    return this.selectMcpClientRunner(clientId, runners[0]?.runner_id ?? "", false, nowMs);
  }

  private policySnapshot(runnerId: string, revision: number | null, checksum: string | null, expectedStatus?: "applied"): RunnerPolicy | undefined {
    if (!Number.isSafeInteger(revision) || revision === null || revision <= 0 || typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) return undefined;
    const row = this.ctx.storage.sql.exec<PolicyVersionRow>("SELECT * FROM runner_policy_versions WHERE runner_id = ? AND revision = ?", runnerId, revision).toArray()[0];
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

  private desiredPolicy(runnerId: string): RunnerPolicy | undefined {
    return this.getDesiredPolicySnapshot(runnerId);
  }
  public listPolicyVersions(runnerId: string): Array<{ runner_id: string; revision: number; checksum: string; policy_json: string; status: string; created_at_ms: number; acknowledged_at_ms: number | null; validation_summary_json: string | null; source_revision: number | null; mutation_id: string | null }> {
    return this.ctx.storage.sql.exec<PolicyVersionRow>("SELECT * FROM runner_policy_versions WHERE runner_id = ? ORDER BY revision DESC LIMIT 50", runnerId).toArray();
  }
  public listManagedWorkspaces(runnerId: string): WorkspaceRecord[] {
    return this.ctx.storage.sql.exec<ManagedWorkspaceRow>("SELECT * FROM managed_workspaces WHERE runner_id = ? ORDER BY created_at_ms, workspace_id", runnerId).toArray().flatMap((row) => decodeWorkspace(row));
  }
  public getManagedWorkspace(runnerId: string, workspaceId: string): WorkspaceRecord | undefined {
    const row = this.ctx.storage.sql.exec<ManagedWorkspaceRow>("SELECT * FROM managed_workspaces WHERE runner_id = ? AND workspace_id = ?", runnerId, workspaceId).toArray()[0];
    return row === undefined ? undefined : decodeWorkspace(row)[0];
  }
  public createManagedWorkspace(runnerId: string, input: { workspace_id: string; display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number): WorkspaceRecord | undefined {
    if (this.runnerRow(runnerId) === undefined || !validWorkspaceInput(input)) return undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`INSERT INTO managed_workspaces (runner_id, workspace_id, display_name, root_path, enabled, permissions_json, created_at_ms, updated_at_ms, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`, runnerId, input.workspace_id, input.display_name, input.root_path, input.enabled ? 1 : 0, JSON.stringify(input.permissions), nowMs, nowMs);
        this.bumpDesiredPolicy(runnerId, nowMs);
      });
    } catch { return undefined; }
    return this.getManagedWorkspace(runnerId, input.workspace_id);
  }
  public updateManagedWorkspace(runnerId: string, workspaceId: string, input: { display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }, nowMs: number): WorkspaceRecord | undefined {
    if (!isSafeIdentifier(workspaceId) || !validWorkspaceInput({ workspace_id: workspaceId, ...input }) || this.getManagedWorkspace(runnerId, workspaceId) === undefined) return undefined;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE managed_workspaces SET display_name = ?, root_path = ?, enabled = ?, permissions_json = ?, updated_at_ms = ?, revision = revision + 1, validation_status = NULL
        WHERE runner_id = ? AND workspace_id = ?`, input.display_name, input.root_path, input.enabled ? 1 : 0, JSON.stringify(input.permissions), nowMs, runnerId, workspaceId);
      this.bumpDesiredPolicy(runnerId, nowMs);
    });
    return this.getManagedWorkspace(runnerId, workspaceId);
  }
  public deleteManagedWorkspace(runnerId: string, workspaceId: string, nowMs: number): boolean {
    if (!isSafeIdentifier(workspaceId)) return false;
    return this.ctx.storage.transactionSync(() => {
      const result = this.ctx.storage.sql.exec("DELETE FROM managed_workspaces WHERE runner_id = ? AND workspace_id = ?", runnerId, workspaceId);
      if (result.rowsWritten !== 1) return false;
      this.bumpDesiredPolicy(runnerId, nowMs);
      return true;
    });
  }
  public setRunnerPermissions(runnerId: string, permissions: PermissionSet, nowMs: number): RunnerRecord | undefined {
    if (this.runnerRow(runnerId) === undefined || !validPermissionSet(permissions)) return undefined;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE runners SET runner_permissions_json = ?, updated_at_ms = ? WHERE runner_id = ?", JSON.stringify(permissions), nowMs, runnerId);
      this.bumpDesiredPolicy(runnerId, nowMs);
    });
    return this.getRunner(runnerId);
  }
  /**
   * Records an operator-only update policy. This intentionally changes no
   * Runner process: download, install, self-update, and rollback are deferred.
   */
  public setRunnerVersionPolicy(runnerId: string, input: { update_channel: RunnerUpdateChannel; desired_runner_version?: string; latest_runner_version?: string }, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || this.runnerRow(runnerId) === undefined || !validUpdateChannel(input.update_channel) || (input.desired_runner_version !== undefined && !validRunnerVersion(input.desired_runner_version)) || (input.latest_runner_version !== undefined && !validRunnerVersion(input.latest_runner_version)) || (input.update_channel === "pinned" && input.desired_runner_version === undefined)) return undefined;
    this.ctx.storage.sql.exec(
      "UPDATE runners SET update_channel = ?, desired_runner_version = ?, latest_runner_version = ?, update_status = ?, updated_at_ms = ? WHERE runner_id = ?",
      input.update_channel, input.desired_runner_version ?? null, input.latest_runner_version ?? null,
      updateStatus(input.update_channel, input.desired_runner_version, input.latest_runner_version, this.runnerRow(runnerId)), nowMs, runnerId,
    );
    return this.getRunner(runnerId);
  }
  public emergencyLockRunner(runnerId: string, nowMs: number): RunnerRecord | undefined { return this.setRunnerPermissions(runnerId, LOCKED_PERMISSIONS, nowMs); }
  public acknowledgePolicy(runnerId: string, epoch: number, credentialVersion: number, input: { desired_revision: number; desired_checksum: string; applied_revision: number | null; applied_checksum: string | null; runner_reported_policy_revision: number | null; runner_reported_policy_checksum: string | null; status: "applied" | "pending" | "invalid"; workspace_status: readonly { workspace_id: string; status: WorkspaceValidationStatus }[] }, nowMs: number): boolean {
    if (!this.sessionIsCurrent(runnerId, epoch, credentialVersion, true) || input.workspace_status.length > 64 || !uniqueIds(input.workspace_status.map((item) => item.workspace_id)) || input.workspace_status.some((item) => !isSafeIdentifier(item.workspace_id))) return false;
    const runner = this.runnerRow(runnerId);
    const desired = runner === undefined ? undefined : this.desiredPolicy(runnerId);
    if (runner === undefined || desired === undefined) return false;
    if (input.desired_revision < runner.desired_policy_revision) return true;
    const expectedStatuses = desired.workspaces.map((workspace) => workspace.workspace_id).sort();
    const actualStatuses = input.workspace_status.map((item) => item.workspace_id).sort();
    const appliedPair = (input.applied_revision === null) === (input.applied_checksum === null);
    const reportedPair = (input.runner_reported_policy_revision === null) === (input.runner_reported_policy_checksum === null);
    if (!appliedPair || !reportedPair || input.applied_revision !== input.runner_reported_policy_revision || input.applied_checksum !== input.runner_reported_policy_checksum) return false;
    if (input.desired_revision !== runner.desired_policy_revision || input.desired_checksum !== desired.checksum || actualStatuses.length !== expectedStatuses.length || actualStatuses.some((id, index) => id !== expectedStatuses[index])) return false;
    if (input.status === "applied" && (input.applied_revision !== input.desired_revision || input.applied_checksum !== input.desired_checksum || input.workspace_status.some((item) => item.status !== "valid"))) return false;
    if (input.status !== "applied" && input.applied_revision !== runner.applied_policy_revision && !(input.applied_revision === null && runner.applied_policy_revision === null)) return false;
    if (input.status === "invalid" && input.applied_revision !== runner.applied_policy_revision) return false;
    this.ctx.storage.transactionSync(() => {
      const current = this.runnerRow(runnerId);
      if (current === undefined || current.desired_policy_revision !== input.desired_revision || current.desired_policy_checksum !== input.desired_checksum) throw new Error("stale policy acknowledgement");
    if (input.status === "invalid") {
      this.ctx.storage.sql.exec("UPDATE runners SET runner_reported_policy_revision = ?, runner_reported_policy_checksum = ?, policy_status = ?, policy_acked_at_ms = ?, policy_error_code = ?, updated_at_ms = ? WHERE runner_id = ?", input.runner_reported_policy_revision, input.runner_reported_policy_checksum, input.status, nowMs, "policy_validation_failed", nowMs, runnerId);
    } else {
      this.ctx.storage.sql.exec("UPDATE runners SET applied_policy_revision = ?, active_policy_checksum = ?, runner_reported_policy_revision = ?, runner_reported_policy_checksum = ?, policy_status = ?, policy_acked_at_ms = ?, updated_at_ms = ? WHERE runner_id = ?", input.applied_revision, input.applied_checksum, input.runner_reported_policy_revision, input.runner_reported_policy_checksum, input.status, nowMs, nowMs, runnerId);
    }
      this.ctx.storage.sql.exec("UPDATE runner_policy_versions SET status = ?, acknowledged_at_ms = ?, validation_summary_json = ? WHERE runner_id = ? AND revision = ?", input.status, nowMs, JSON.stringify(input.workspace_status), runnerId, input.desired_revision);
      for (const item of input.workspace_status) this.ctx.storage.sql.exec("UPDATE managed_workspaces SET validation_status = ? WHERE runner_id = ? AND workspace_id = ?", item.status, runnerId, item.workspace_id);
    });
    return true;
  }

  public registerRunner(runnerId: string, tokenVerifier: string, nowMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO runners (runner_id, display_name, token_verifier, state, credential_version, updated_at_ms)
       VALUES (?, ?, ?, 'offline', 1, ?)
       ON CONFLICT(runner_id) DO UPDATE SET token_verifier = excluded.token_verifier,
         display_name = CASE WHEN runners.display_name = '' THEN excluded.display_name ELSE runners.display_name END,
         credential_version = runners.credential_version + 1, connection_epoch = runners.connection_epoch + 1,
         state = 'offline', session_id = NULL, metadata_json = NULL,
         last_heartbeat_ms = NULL, last_sync_sequence = NULL,
         policy_status = CASE WHEN desired_policy_revision = 0 THEN 'applied' ELSE 'pending' END, updated_at_ms = excluded.updated_at_ms`, runnerId, runnerId, tokenVerifier, nowMs,
    );
  }
  public addRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || !validLabel(displayName)) return undefined;
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO runners (runner_id, display_name, token_verifier, state, management_mode, credential_version, desired_policy_revision, desired_policy_checksum, policy_status, runner_permissions_json, updated_at_ms)
           VALUES (?, ?, '', 'offline', 'central', 0, 0, NULL, 'pending', ?, ?)`, runnerId, displayName, JSON.stringify(READ_ONLY_PERMISSIONS), nowMs,
        );
        this.createPolicySnapshot(runnerId, 1, nowMs, null, "runner-created");
      });
    } catch { return undefined; }
    return this.getRunner(runnerId);
  }
  public renameRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || !validLabel(displayName)) return undefined;
    this.ctx.storage.sql.exec("UPDATE runners SET display_name = ?, updated_at_ms = ? WHERE runner_id = ?", displayName, nowMs, runnerId);
    return this.getRunner(runnerId);
  }
  public deleteRunner(runnerId: string, confirmation: string, nowMs: number): boolean {
    if (!isSafeIdentifier(runnerId) || confirmation !== runnerId || this.runnerRow(runnerId) === undefined) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM client_runner_overrides WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM managed_workspaces WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM jobs WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("UPDATE mcp_clients SET active_runner_id = NULL, active_runner_updated_at_ms = ?, updated_at_ms = ? WHERE active_runner_id = ?", nowMs, nowMs, runnerId);
      this.ctx.storage.sql.exec("DELETE FROM runners WHERE runner_id = ?", runnerId);
    });
    return true;
  }
  public createRunnerEnrollment(runnerId: string, enrollmentId: string, verifier: string, nowMs: number): { enrollment_id: string; runner_id: string; expires_at_ms: number } | undefined {
    if (!isSafeIdentifier(runnerId) || !/^[A-Za-z0-9_-]{43}$/.test(enrollmentId) || !validVerifier(verifier) || this.runnerRow(runnerId) === undefined) return undefined;
    const expiresAtMs = nowMs + RUNNER_ENROLLMENT_TTL_MS;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ? AND used_at_ms IS NULL", runnerId);
      this.ctx.storage.sql.exec("INSERT INTO runner_enrollments (enrollment_id, runner_id, verifier, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)", enrollmentId, runnerId, verifier, nowMs, expiresAtMs);
    });
    return { enrollment_id: enrollmentId, runner_id: runnerId, expires_at_ms: expiresAtMs };
  }
  public async redeemRunnerEnrollment(verifier: string, tokenVerifier: string, publicInfo: RunnerPublicInfo, nowMs: number): Promise<{ runner_id: string } | undefined> {
    if (!validVerifier(verifier) || !validVerifier(tokenVerifier) || !validRunnerPublicInfo(publicInfo)) return undefined;
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<EnrollmentRow>(
        "SELECT * FROM runner_enrollments WHERE verifier = ? AND used_at_ms IS NULL AND expires_at_ms > ?", verifier, nowMs,
      ).toArray()[0];
      if (row === undefined) return undefined;
      const changed = this.ctx.storage.sql.exec("UPDATE runner_enrollments SET used_at_ms = ? WHERE enrollment_id = ? AND used_at_ms IS NULL AND expires_at_ms > ?", nowMs, row.enrollment_id, nowMs);
      if (changed.rowsWritten !== 1) return undefined;
      this.ctx.storage.sql.exec(
        `UPDATE runners SET token_verifier = ?, credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
         state = 'offline', session_id = NULL, metadata_json = NULL, public_info_json = ?, current_runner_version = ?,
         protocol_min_version = ?, protocol_max_version = ?, protocol_compatibility = ?, update_status = ?, last_heartbeat_ms = NULL,
         last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ?`,
        tokenVerifier, JSON.stringify(publicInfo), publicInfo.runner_version, publicInfo.protocol_version, publicInfo.protocol_version,
        protocolCompatibility(publicInfo.protocol_version, publicInfo.protocol_version),
        updateStatus(this.runnerRow(row.runner_id)?.update_channel ?? "stable", this.runnerRow(row.runner_id)?.desired_runner_version ?? undefined, this.runnerRow(row.runner_id)?.latest_runner_version ?? undefined, { current_runner_version: publicInfo.runner_version, protocol_compatibility: protocolCompatibility(publicInfo.protocol_version, publicInfo.protocol_version) }),
        nowMs, row.runner_id,
      );
      return this.runnerRow(row.runner_id) === undefined ? undefined : { runner_id: row.runner_id };
    });
  }
  public async authenticateRunner(runnerId: string, token: string): Promise<{ credential_version: number } | undefined> {
    if (this.env.RUNNER_TOKEN_PEPPER === undefined) return undefined;
    const tokenVerifier = await runnerTokenVerifier(token, this.env.RUNNER_TOKEN_PEPPER);
    const row = this.ctx.storage.sql.exec<Pick<RunnerRow, "token_verifier" | "credential_version">>("SELECT token_verifier, credential_version FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    return row !== undefined && row.token_verifier.length > 0 && constantTimeEqual(row.token_verifier, tokenVerifier) ? { credential_version: row.credential_version } : undefined;
  }
  public beginConnection(runnerId: string, metadata: RunnerMetadata, protocol: { min_protocol_version: number; max_protocol_version: number }, sessionId: string, credentialVersion: number, nowMs: number): number | undefined {
    const compatibility = protocolCompatibility(protocol.min_protocol_version, protocol.max_protocol_version);
    const prior = this.runnerRow(runnerId);
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = 'online', connection_epoch = connection_epoch + 1, session_id = ?, metadata_json = ?,
       current_runner_version = ?, protocol_min_version = ?, protocol_max_version = ?, protocol_compatibility = ?,
       update_status = ?, last_heartbeat_ms = ?, last_sync_sequence = NULL,
       policy_status = CASE WHEN desired_policy_revision = 0 THEN 'applied' ELSE 'pending' END, updated_at_ms = ? WHERE runner_id = ? AND credential_version = ?`,
      sessionId, JSON.stringify(metadata), metadata.runner_version, protocol.min_protocol_version, protocol.max_protocol_version, compatibility,
      updateStatus(prior?.update_channel ?? "stable", prior?.desired_runner_version ?? undefined, prior?.latest_runner_version ?? undefined, { ...prior, current_runner_version: metadata.runner_version, protocol_compatibility: compatibility }),
      nowMs, nowMs, runnerId, credentialVersion,
    );
    return this.getRunner(runnerId)?.credential_version === credentialVersion ? this.getRunner(runnerId)?.connection_epoch : undefined;
  }
  public sessionIsCurrent(runnerId: string, epoch: number, credentialVersion: number, requireOnline = false): boolean {
    const row = this.ctx.storage.sql.exec<Pick<RunnerRow, "connection_epoch" | "credential_version" | "state">>("SELECT connection_epoch, credential_version, state FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    return row?.connection_epoch === epoch && row.credential_version === credentialVersion && (!requireOnline || row.state === "online");
  }
  public recordHeartbeat(runnerId: string, epoch: number, credentialVersion: number, nowMs: number): boolean {
    this.ctx.storage.sql.exec("UPDATE runners SET state = 'online', last_heartbeat_ms = ?, updated_at_ms = ? WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ?", nowMs, nowMs, runnerId, epoch, credentialVersion);
    return this.sessionIsCurrent(runnerId, epoch, credentialVersion, true);
  }
  public markDisconnected(runnerId: string, epoch: number, credentialVersion: number, state: Exclude<RunnerConnectionState, "online">, nowMs: number): void {
    this.ctx.storage.sql.exec("UPDATE runners SET state = ?, session_id = NULL, updated_at_ms = ? WHERE runner_id = ? AND connection_epoch = ? AND credential_version = ?", state, nowMs, runnerId, epoch, credentialVersion);
  }
  public syncRunner(
    runnerId: string,
    epoch: number,
    credentialVersion: number,
    workspaces: readonly { readonly workspace_id: string }[],
    jobs: readonly { readonly job_id: string; readonly runner_id?: string | undefined; readonly updated_at_ms?: number }[],
    syncSequence: number,
    nowMs: number,
    requireOnline = true,
  ): boolean {
    if (!this.sessionIsCurrent(runnerId, epoch, credentialVersion, requireOnline)) return false;
    const prior = this.ctx.storage.sql.exec<Pick<RunnerRow, "last_sync_sequence">>("SELECT last_sync_sequence FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    if (prior?.last_sync_sequence !== null && prior?.last_sync_sequence !== undefined && syncSequence <= prior.last_sync_sequence) return false;
    this.ctx.storage.transactionSync(() => {
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspace_id));
      for (const workspace of workspaces) this.ctx.storage.sql.exec(
        `INSERT INTO workspaces (runner_id, workspace_id, workspace_json, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(runner_id, workspace_id) DO UPDATE SET workspace_json = excluded.workspace_json, updated_at_ms = excluded.updated_at_ms`, runnerId, workspace.workspace_id, JSON.stringify(workspace), nowMs,
      );
      // A sync is an upsert of a bounded recent snapshot, never an authoritative
      // delete of job history. Older jobs remain discoverable while offline.
      for (const job of jobs) this.upsertJob(runnerId, { ...job, runner_id: runnerId }, nowMs);
      this.deleteMissingWorkspaces(runnerId, workspaceIds);
      this.pruneTerminalJobs(runnerId);
      this.ctx.storage.sql.exec("UPDATE runners SET last_sync_sequence = ?, updated_at_ms = ? WHERE runner_id = ?", syncSequence, nowMs, runnerId);
    });
    return true;
  }
  public invalidateRunnerCredential(runnerId: string, nowMs: number): boolean {
    const result = this.ctx.storage.sql.exec(`UPDATE runners SET credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
      token_verifier = '', state = 'offline', session_id = NULL, last_heartbeat_ms = NULL, updated_at_ms = ? WHERE runner_id = ?`, nowMs, runnerId);
    return result.rowsWritten === 1;
  }
  public revokeRunner(runnerId: string, confirmation: string, nowMs: number): boolean {
    if (!isSafeIdentifier(runnerId) || confirmation !== runnerId || this.runnerRow(runnerId) === undefined) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE runners SET credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
       token_verifier = '', state = 'offline', session_id = NULL, metadata_json = NULL, last_heartbeat_ms = NULL,
       last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ?`, nowMs, runnerId);
    });
    return true;
  }
  public recordJobEvent(runnerId: string, epoch: number, credentialVersion: number, message: unknown, nowMs: number, requireOnline = true): boolean {
    if (!this.sessionIsCurrent(runnerId, epoch, credentialVersion, requireOnline)) return false;
    const event = parseJobEvent(message);
    if (event === undefined || event.job.runner_id !== runnerId) return false;
    this.upsertJob(runnerId, { ...event.job, runner_id: runnerId }, nowMs);
    this.pruneTerminalJobs(runnerId);
    return true;
  }
  public getRunner(runnerId: string): RunnerRecord | undefined {
    const staleBefore = Date.now() - 45_000;
    this.ctx.storage.sql.exec(`UPDATE runners SET state = 'stale', updated_at_ms = ? WHERE runner_id = ? AND state = 'online' AND last_heartbeat_ms < ?`, Date.now(), runnerId, staleBefore);
    const row = this.ctx.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
    return row === undefined ? undefined : decodeRunner(row);
  }
  public listWorkspaces(runnerId: string): unknown[] { return this.ctx.storage.sql.exec<WorkspaceRow>("SELECT workspace_json FROM workspaces WHERE runner_id = ? ORDER BY workspace_id", runnerId).toArray().map((row) => JSON.parse(row.workspace_json) as unknown); }
  public listJobs(runnerId: string, filters: { readonly workspace_id?: string; readonly status?: string; readonly limit?: number } = {}): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 100);
    let rows: JobRow[];
    if (filters.workspace_id !== undefined && filters.status !== undefined) {
      rows = this.ctx.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.workspace_id') = ? AND json_extract(job_json, '$.status') = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, filters.workspace_id, filters.status, limit,
      ).toArray();
    } else if (filters.workspace_id !== undefined) {
      rows = this.ctx.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.workspace_id') = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, filters.workspace_id, limit,
      ).toArray();
    } else if (filters.status !== undefined) {
      rows = this.ctx.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.status') = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, filters.status, limit,
      ).toArray();
    } else {
      rows = this.ctx.storage.sql.exec<JobRow>(
        "SELECT job_json FROM jobs WHERE runner_id = ? ORDER BY updated_at_ms DESC, job_id ASC LIMIT ?",
        runnerId, limit,
      ).toArray();
    }
    return rows.map((row) => JSON.parse(row.job_json) as unknown);
  }
  public listRunners(): RunnerRecord[] { return this.ctx.storage.sql.exec<RunnerRow>("SELECT * FROM runners ORDER BY display_name, runner_id").toArray().map(decodeRunner); }
  public dashboardSnapshot(): DashboardSnapshot {
    const runners = this.listRunners().map((runner) => ({
      ...runner,
      workspace_count: Number(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workspaces WHERE runner_id = ?", runner.runner_id).toArray()[0]?.count ?? 0),
      active_job_count: Number(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.status') IN ('queued', 'running', 'cancelling')", runner.runner_id).toArray()[0]?.count ?? 0),
    }));
    const jobs = this.ctx.storage.sql.exec<{ runner_id: string; job_json: string; updated_at_ms: number }>("SELECT runner_id, job_json, updated_at_ms FROM jobs ORDER BY updated_at_ms DESC, job_id ASC LIMIT 20").toArray().flatMap((row): DashboardJobRecord[] => {
      try {
        const job = JSON.parse(row.job_json) as Record<string, unknown>;
        return typeof job.job_id === "string" && typeof job.workspace_id === "string" && typeof job.status === "string"
          ? [{ runner_id: row.runner_id, job_id: job.job_id, workspace_id: job.workspace_id, status: job.status, updated_at_ms: row.updated_at_ms }]
          : [];
      } catch { return []; }
    });
    return { runners, jobs };
  }
  public getJob(runnerId: string, jobId: string): unknown | undefined { const row = this.ctx.storage.sql.exec<JobRow>("SELECT job_json FROM jobs WHERE runner_id = ? AND job_id = ?", runnerId, jobId).toArray()[0]; return row === undefined ? undefined : JSON.parse(row.job_json) as unknown; }

  public async fetch(request: Request): Promise<Response> {
    const rawBody = await readCappedBody(request);
    if (rawBody === undefined) return new Response("payload too large", { status: 413 });
    if (!await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, rawBody, (nonce, expiresAtMs) => this.consumeInternalNonce(nonce, expiresAtMs))) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const input = rawBody.length === 0 ? {} : parseJsonObject(rawBody);
    if (input === undefined) return Response.json({ error: "invalid JSON object" }, { status: 400 });
    const now = Date.now();
    if (request.method === "POST" && segments.length === 2 && segments[0] === "enrollments" && segments[1] === "redeem") {
      const verifier = stringField(input, "verifier", 64); const tokenVerifier = stringField(input, "token_verifier", 64); const publicInfo = runnerPublicInfoField(input.runner_public_info);
      const redeemed = verifier === undefined || tokenVerifier === undefined || publicInfo === undefined ? undefined : await this.redeemRunnerEnrollment(verifier, tokenVerifier, publicInfo, now);
      return redeemed === undefined ? new Response("invalid enrollment", { status: 401 }) : Response.json(redeemed);
    }
    if (segments[0] === "auth") return this.handleAuth(request.method, segments.slice(1), input, now, url);
    if (request.method === "GET" && segments.length === 1 && segments[0] === "runners") return Response.json({ runners: this.listRunners() });
    if (request.method === "GET" && segments.length === 1 && segments[0] === "dashboard") return Response.json(this.dashboardSnapshot());
    const runnerId = segments[0] === "runners" ? parseRunnerId(segments[1]) : undefined;
    const action = segments[2]; const itemId = segments[3];
    if (runnerId === undefined || segments.length > 4) return new Response("not found", { status: 404 });
    if (request.method === "PUT" && action === undefined) {
      const tokenVerifier = stringField(input, "token_verifier", 64);
      if (tokenVerifier === undefined || !validVerifier(tokenVerifier)) return Response.json({ error: "invalid token verifier" }, { status: 400 });
      this.registerRunner(runnerId, tokenVerifier, now); return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "auth") {
      const token = stringField(input, "token", 512); if (token === undefined || /\s/.test(token)) return new Response("unauthorized", { status: 401 });
      const authenticated = await this.authenticateRunner(runnerId, token); return authenticated === undefined ? new Response("unauthorized", { status: 401 }) : Response.json(authenticated);
    }
    if (request.method === "POST" && action === "connect") {
      const sessionId = stringField(input, "session_id", 128); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const metadata = RunnerMetadataSchema.safeParse(input.metadata); const protocolMin = integerField(input, "min_protocol_version"); const protocolMax = integerField(input, "max_protocol_version");
      if (!metadata.success || sessionId === undefined || credentialVersion === undefined || nowMs === undefined || protocolMin === undefined || protocolMax === undefined || protocolMin < 1 || protocolMin > protocolMax || protocolMax > 1_000) return Response.json({ error: "invalid connection metadata" }, { status: 400 });
      const epoch = this.beginConnection(runnerId, metadata.data, { min_protocol_version: protocolMin, max_protocol_version: protocolMax }, sessionId, credentialVersion, nowMs);
      const policy = epoch === undefined ? undefined : this.desiredPolicy(runnerId);
      return epoch === undefined ? new Response("stale credentials", { status: 409 }) : Response.json({ epoch, desired_policy: policy });
    }
    if (request.method === "POST" && action === "heartbeat") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); if (epoch === undefined || credentialVersion === undefined || nowMs === undefined) return Response.json({ error: "invalid heartbeat" }, { status: 400 }); return this.recordHeartbeat(runnerId, epoch, credentialVersion, nowMs) ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 }); }
    if (request.method === "POST" && action === "session") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); return epoch !== undefined && credentialVersion !== undefined && this.sessionIsCurrent(runnerId, epoch, credentialVersion, input.require_online === true) ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 }); }
    if (request.method === "POST" && action === "disconnect") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || (input.state !== "offline" && input.state !== "stale")) return Response.json({ error: "invalid disconnect" }, { status: 400 }); this.markDisconnected(runnerId, epoch, credentialVersion, input.state, nowMs); return new Response(null, { status: 204 }); }
    if (request.method === "POST" && action === "sync") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const message = RunnerSyncSchema.safeParse(input.message); if (!message.success || epoch === undefined || credentialVersion === undefined || nowMs === undefined || message.data.runner_id !== runnerId || message.data.workspaces.length > MAX_SYNC_ITEMS || message.data.jobs.length > MAX_SYNC_ITEMS || !uniqueIds(message.data.workspaces.map((workspace) => workspace.workspace_id)) || !uniqueIds(message.data.jobs.map((job) => job.job_id))) return Response.json({ error: "invalid sync" }, { status: 400 }); return this.syncRunner(runnerId, epoch, credentialVersion, message.data.workspaces, message.data.jobs, message.data.sync_sequence, nowMs) ? new Response(null, { status: 204 }) : new Response("stale sync or session", { status: 409 }); }
    if (request.method === "POST" && action === "event") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !this.recordJobEvent(runnerId, epoch, credentialVersion, input.message, nowMs)) return new Response("stale session or invalid event", { status: 409 }); return new Response(null, { status: 204 }); }
    if (request.method === "POST" && action === "add") {
      const displayName = stringField(input, "display_name", 256); const runner = displayName === undefined ? undefined : this.addRunner(runnerId, displayName, now);
      return runner === undefined ? new Response("conflict", { status: 409 }) : Response.json(runner);
    }
    if (request.method === "DELETE" && action === undefined) { const confirmation = stringField(input, "confirmation", 128); return confirmation !== undefined && this.deleteRunner(runnerId, confirmation, now) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 }); }
    if (request.method === "POST" && action === "rename") { const displayName = stringField(input, "display_name", 256); const runner = displayName === undefined ? undefined : this.renameRunner(runnerId, displayName, now); return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner); }
    if (request.method === "POST" && action === "enrollments") { const enrollmentId = stringField(input, "enrollment_id", 43); const verifier = stringField(input, "verifier", 64); const enrollment = enrollmentId === undefined || verifier === undefined ? undefined : this.createRunnerEnrollment(runnerId, enrollmentId, verifier, now); return enrollment === undefined ? new Response("not found", { status: 404 }) : Response.json(enrollment); }
    if (request.method === "POST" && action === "rotate") { this.invalidateRunnerCredential(runnerId, now); return new Response(null, { status: 204 }); }
    if (request.method === "POST" && action === "revoke") { const confirmation = stringField(input, "confirmation", 128); return confirmation !== undefined && this.revokeRunner(runnerId, confirmation, now) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 }); }
    if (request.method === "GET" && action === "active-workspaces" && itemId === undefined) {
      const policy = this.getActivePolicySnapshot(runnerId);
      if (policy === undefined) return new Response("not found", { status: 404 });
      return Response.json({ runner_id: runnerId, revision: policy.revision, checksum: policy.checksum, workspaces: policy.workspaces.map((workspace) => ({ workspace_id: workspace.workspace_id, enabled: workspace.enabled, permissions: workspace.permissions })) });
    }
    if (request.method === "GET" && action === "policy-readiness" && itemId === undefined) return Response.json(this.getPolicyReadiness(runnerId));
    if (request.method === "GET" && action === "workspaces" && itemId === undefined) return Response.json({ runner_id: runnerId, workspaces: this.listWorkspaces(runnerId) });
    if (request.method === "POST" && action === "policy-ack") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const desiredRevision = integerField(input, "desired_revision"); const desiredChecksum = stringField(input, "desired_checksum", 64); const appliedRevision = nullableIntegerField(input, "applied_revision"); const appliedChecksum = nullableChecksumField(input, "applied_checksum"); const reportedRevision = nullableIntegerField(input, "runner_reported_policy_revision"); const reportedChecksum = nullableChecksumField(input, "runner_reported_policy_checksum"); const status = input.status; const statuses = workspaceStatusesField(input.workspace_status); if (epoch === undefined || credentialVersion === undefined || desiredRevision === undefined || desiredChecksum === undefined || appliedRevision === undefined || appliedChecksum === undefined || reportedRevision === undefined || reportedChecksum === undefined || (status !== "applied" && status !== "pending" && status !== "invalid") || statuses === undefined) return Response.json({ error: "invalid policy acknowledgement" }, { status: 400 }); return this.acknowledgePolicy(runnerId, epoch, credentialVersion, { desired_revision: desiredRevision, desired_checksum: desiredChecksum, applied_revision: appliedRevision, applied_checksum: appliedChecksum, runner_reported_policy_revision: reportedRevision, runner_reported_policy_checksum: reportedChecksum, status, workspace_status: statuses }, now) ? new Response(null, { status: 204 }) : new Response("stale policy acknowledgement", { status: 409 }); }
    if (request.method === "GET" && action === "desired-policy" && itemId === undefined) { const policy = this.desiredPolicy(runnerId); return policy === undefined ? new Response("not found", { status: 404 }) : Response.json(policy); }
    if (request.method === "GET" && action === "policy-versions" && itemId === undefined) return Response.json({ runner_id: runnerId, versions: this.listPolicyVersions(runnerId).map((version) => ({ revision: version.revision, checksum: version.checksum.slice(0, 12), status: version.status, created_at_ms: version.created_at_ms, acknowledged_at_ms: version.acknowledged_at_ms, source_revision: version.source_revision, mutation_id: version.mutation_id, validation_summary: version.validation_summary_json === null ? null : JSON.parse(version.validation_summary_json) })) });
    if (request.method === "GET" && action === "policy-revision" && itemId === undefined) { const runner = this.getRunner(runnerId); return runner === undefined ? new Response("not found", { status: 404 }) : Response.json({ desired_policy_revision: runner.desired_policy_revision, desired_policy_checksum: runner.desired_policy_checksum, applied_policy_revision: runner.applied_policy_revision, active_policy_checksum: runner.active_policy_checksum, runner_reported_policy_revision: runner.runner_reported_policy_revision, runner_reported_policy_checksum: runner.runner_reported_policy_checksum, policy_status: runner.policy_status }); }
    if (request.method === "GET" && action === "jobs" && itemId === undefined) {
      const workspaceId = url.searchParams.get("workspace_id") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : /^\d+$/.test(rawLimit) ? Number(rawLimit) : undefined;
      if ((workspaceId !== undefined && !IdentifierSchema.safeParse(workspaceId).success) || (status !== undefined && !["queued", "running", "cancelling", "cancelled", "succeeded", "failed", "unknown", "interrupted"].includes(status)) || (rawLimit !== null && (limit === undefined || limit < 1 || limit > 100))) return Response.json({ error: "invalid job filters" }, { status: 400 });
      return Response.json({ runner_id: runnerId, jobs: this.listJobs(runnerId, { ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }), ...(status === undefined ? {} : { status }), ...(limit === undefined ? {} : { limit }) }) });
    }
    if (request.method === "GET" && action === "jobs" && itemId !== undefined && IdentifierSchema.safeParse(itemId).success) { const job = this.getJob(runnerId, itemId); return job === undefined ? Response.json({ error: "job not found" }, { status: 404 }) : Response.json(job); }
    if (request.method === "GET" && action === undefined && itemId === undefined) { const runner = this.getRunner(runnerId); return runner === undefined ? Response.json({ error: "runner not found" }, { status: 404 }) : Response.json(runner); }
    return new Response("not found", { status: 404 });
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
    if (method === "GET" && action === "settings" && clientId === undefined) { const verifier = this.adminPasswordVerifier(); return verifier === undefined ? new Response("not found", { status: 404 }) : Response.json({ password_verifier: verifier }); }
    if (method === "POST" && action === "setup" && clientId === undefined) { const verifier = stringField(input, "password_verifier", 4_096); return verifier === undefined ? Response.json({ error: "invalid verifier" }, { status: 400 }) : this.setupAdmin(verifier, nowMs) ? new Response(null, { status: 204 }) : new Response("already initialized", { status: 409 }); }
    if (method === "POST" && action === "throttle" && clientId === "check") {
      const kind = authThrottleKind(input.kind);
      return kind === undefined ? Response.json({ error: "invalid throttle kind" }, { status: 400 }) : Response.json(this.checkAuthThrottle(kind, nowMs));
    }
    if (method === "POST" && action === "throttle" && clientId === "record") {
      const kind = authThrottleKind(input.kind);
      if (kind === undefined || typeof input.success !== "boolean") return Response.json({ error: "invalid throttle record" }, { status: 400 });
      this.recordAuthAttempt(kind, input.success, nowMs);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && action === "sessions" && clientId === undefined) { const sessionHash = stringField(input, "session_hash", 64); const csrfHash = stringField(input, "csrf_hash", 64); const expires = integerField(input, "expires_at_ms"); if (sessionHash === undefined || csrfHash === undefined || expires === undefined || !validVerifier(sessionHash) || !validVerifier(csrfHash) || expires <= nowMs) return Response.json({ error: "invalid session" }, { status: 400 }); return this.createAdminSession(sessionHash, csrfHash, expires, nowMs) ? new Response(null, { status: 204 }) : new Response("not initialized", { status: 409 }); }
    if (method === "POST" && action === "sessions" && clientId === "verify") { const sessionHash = stringField(input, "session_hash", 64); if (sessionHash === undefined || !validVerifier(sessionHash)) return new Response("not found", { status: 404 }); const session = this.verifyAdminSession(sessionHash, nowMs); return session === undefined ? new Response("not found", { status: 404 }) : Response.json(session); }
    if (method === "POST" && action === "sessions" && clientId === "logout") { const sessionHash = stringField(input, "session_hash", 64); if (sessionHash !== undefined && validVerifier(sessionHash)) this.logoutAdminSession(sessionHash); return new Response(null, { status: 204 }); }
    if (method === "POST" && action === "password" && clientId === undefined) { const verifier = stringField(input, "password_verifier", 4_096); return verifier === undefined ? Response.json({ error: "invalid verifier" }, { status: 400 }) : this.changeAdminPassword(verifier, nowMs) ? new Response(null, { status: 204 }) : new Response("not initialized", { status: 409 }); }
    if (method === "GET" && action === "clients" && clientId === undefined) return Response.json({ clients: this.listMcpClients() });
    if (method === "POST" && action === "clients" && clientId === undefined) { const id = stringField(input, "client_id", 128); const label = stringField(input, "label", 256); const verifier = stringField(input, "secret_verifier", 64); const prefix = stringField(input, "secret_prefix", 16); const scopes = scopesField(input.scopes); if (id === undefined || label === undefined || verifier === undefined || prefix === undefined || scopes === undefined) return Response.json({ error: "invalid client" }, { status: 400 }); const client = this.createMcpClient({ client_id: id, label, secret_verifier: verifier, secret_prefix: prefix, scopes }, nowMs); return client === undefined ? new Response("conflict", { status: 409 }) : Response.json(client); }
    if (action === "clients" && clientId !== undefined && isSafeIdentifier(clientId)) {
      const subaction = segments[2];
      if (method === "POST" && subaction === "rename") { const label = stringField(input, "label", 256); const client = label === undefined ? undefined : this.renameMcpClient(clientId, label, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "rotate") { const verifier = stringField(input, "secret_verifier", 64); const prefix = stringField(input, "secret_prefix", 16); const client = verifier === undefined || prefix === undefined ? undefined : this.rotateMcpClient(clientId, verifier, prefix, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
      if (method === "POST" && subaction === "revoke") { const client = this.revokeMcpClient(clientId, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
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
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "managed-workspaces" && segments[3] === undefined) {
      if (!isSafeIdentifier(clientId)) return new Response("not found", { status: 404 });
      const workspaceId = stringField(input, "workspace_id", 128); const displayName = stringField(input, "display_name", 256); const rootPath = stringField(input, "root_path", 4_096); const permissions = permissionSetField(input.permissions);
      if (workspaceId === undefined || displayName === undefined || rootPath === undefined || permissions === undefined || typeof input.enabled !== "boolean") return Response.json({ error: "invalid workspace" }, { status: 400 });
      const workspace = this.createManagedWorkspace(clientId, { workspace_id: workspaceId, display_name: displayName, root_path: rootPath, enabled: input.enabled, permissions }, nowMs);
      return workspace === undefined ? new Response("conflict", { status: 409 }) : Response.json(workspace);
    }
    if (action === "runners" && clientId !== undefined && segments[2] === "managed-workspaces" && segments[3] !== undefined && isSafeIdentifier(clientId) && isSafeIdentifier(segments[3])) {
      const workspaceId = segments[3];
      if (method === "GET") { const workspace = this.getManagedWorkspace(clientId, workspaceId); return workspace === undefined ? new Response("not found", { status: 404 }) : Response.json(workspace); }
      if (method === "PUT") {
        const displayName = stringField(input, "display_name", 256); const rootPath = stringField(input, "root_path", 4_096); const permissions = permissionSetField(input.permissions);
        if (displayName === undefined || rootPath === undefined || permissions === undefined || typeof input.enabled !== "boolean") return Response.json({ error: "invalid workspace" }, { status: 400 });
        const workspace = this.updateManagedWorkspace(clientId, workspaceId, { display_name: displayName, root_path: rootPath, enabled: input.enabled, permissions }, nowMs);
        return workspace === undefined ? new Response("not found", { status: 404 }) : Response.json(workspace);
      }
      if (method === "DELETE") return this.deleteManagedWorkspace(clientId, workspaceId, nowMs) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "version-policy" && isSafeIdentifier(clientId)) {
      const channel = input.update_channel; const desired = input.desired_runner_version; const latest = input.latest_runner_version;
      if ((channel !== "stable" && channel !== "pinned") || (desired !== undefined && typeof desired !== "string") || (latest !== undefined && typeof latest !== "string")) return Response.json({ error: "invalid runner version policy" }, { status: 400 });
      const runner = this.setRunnerVersionPolicy(clientId, { update_channel: channel, ...(typeof desired === "string" ? { desired_runner_version: desired } : {}), ...(typeof latest === "string" ? { latest_runner_version: latest } : {}) }, nowMs);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "permissions" && isSafeIdentifier(clientId)) {
      const permissions = permissionSetField(input.permissions); const runner = permissions === undefined ? undefined : this.setRunnerPermissions(clientId, permissions, nowMs);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "emergency-lock" && isSafeIdentifier(clientId)) {
      const runner = this.emergencyLockRunner(clientId, nowMs);
      return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner);
    }
    if (method === "POST" && action === "runners" && clientId !== undefined && segments[2] === "policy-ack" && isSafeIdentifier(clientId)) {
      const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const desiredRevision = integerField(input, "desired_revision"); const desiredChecksum = stringField(input, "desired_checksum", 64); const appliedRevision = nullableIntegerField(input, "applied_revision"); const appliedChecksum = nullableChecksumField(input, "applied_checksum"); const reportedRevision = nullableIntegerField(input, "runner_reported_policy_revision"); const reportedChecksum = nullableChecksumField(input, "runner_reported_policy_checksum"); const status = input.status; const statuses = workspaceStatusesField(input.workspace_status);
      if (epoch === undefined || credentialVersion === undefined || desiredRevision === undefined || desiredChecksum === undefined || appliedRevision === undefined || appliedChecksum === undefined || reportedRevision === undefined || reportedChecksum === undefined || (status !== "applied" && status !== "pending" && status !== "invalid") || statuses === undefined) return Response.json({ error: "invalid policy acknowledgement" }, { status: 400 });
      return this.acknowledgePolicy(clientId, epoch, credentialVersion, { desired_revision: desiredRevision, desired_checksum: desiredChecksum, applied_revision: appliedRevision, applied_checksum: appliedChecksum, runner_reported_policy_revision: reportedRevision, runner_reported_policy_checksum: reportedChecksum, status, workspace_status: statuses }, nowMs) ? new Response(null, { status: 204 }) : new Response("stale policy acknowledgement", { status: 409 });
    }
    if (method === "POST" && action === "mcp" && clientId === "verify") { const verifier = stringField(input, "secret_verifier", 64); if (verifier === undefined) return new Response("not found", { status: 404 }); const client = this.verifyMcpClient(verifier, nowMs); return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client); }
    return new Response("not found", { status: 404 });
  }

  private settings(): AdminSettingsRow | undefined { return this.ctx.storage.sql.exec<AdminSettingsRow>("SELECT password_verifier, session_version, created_at_ms, updated_at_ms FROM admin_settings WHERE id = 1").toArray()[0]; }
  private authThrottleRow(kind: AuthThrottleKind): AuthThrottleRow | undefined { return this.ctx.storage.sql.exec<AuthThrottleRow>("SELECT id, failed_attempts, blocked_until_ms, updated_at_ms FROM auth_throttle WHERE id = ?", kind).toArray()[0]; }
  private getMcpClient(clientId: string): McpClientRecord | undefined { const row = this.ctx.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients WHERE client_id = ?", clientId).toArray()[0]; return row === undefined ? undefined : decodeMcpClient(row); }
  private runnerRow(runnerId: string): RunnerRow | undefined { return this.ctx.storage.sql.exec<RunnerRow>("SELECT * FROM runners WHERE runner_id = ?", runnerId).toArray()[0]; }
  private activeRunnerContext(runnerId: string, updatedAtMs: number | null): ActiveRunnerContext {
    const row = this.runnerRow(runnerId);
    if (row === undefined || row.token_verifier.length === 0) return { runner_id: runnerId, state: "unavailable", available: false, updated_at_ms: updatedAtMs };
    return safeRunnerContext(decodeRunner(row), updatedAtMs);
  }
  private ensureSchema(): void {
    const columns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(runners)").toArray().map((column) => column.name));
    if (!columns.has("token_verifier")) {
      this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN token_verifier TEXT");
      if (columns.has("token_hash")) this.ctx.storage.sql.exec("UPDATE runners SET token_verifier = token_hash WHERE token_verifier IS NULL");
      else this.ctx.storage.sql.exec("UPDATE runners SET token_verifier = '' WHERE token_verifier IS NULL");
    }
    if (!columns.has("credential_version")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1");
    if (!columns.has("display_name")) { this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN display_name TEXT"); this.ctx.storage.sql.exec("UPDATE runners SET display_name = runner_id WHERE display_name IS NULL OR display_name = ''"); }
    if (!columns.has("public_info_json")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN public_info_json TEXT");
    if (!columns.has("last_sync_sequence")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN last_sync_sequence INTEGER");
    if (!columns.has("management_mode")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN management_mode TEXT NOT NULL DEFAULT 'legacy_local'");
    if (!columns.has("desired_policy_revision")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN desired_policy_revision INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("applied_policy_revision")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN applied_policy_revision INTEGER");
    if (!columns.has("runner_reported_policy_revision")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN runner_reported_policy_revision INTEGER");
    if (!columns.has("policy_status")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN policy_status TEXT NOT NULL DEFAULT 'pending'");
    if (!columns.has("desired_policy_checksum")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN desired_policy_checksum TEXT");
    if (!columns.has("active_policy_checksum")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN active_policy_checksum TEXT");
    if (!columns.has("runner_reported_policy_checksum")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN runner_reported_policy_checksum TEXT");
    if (!columns.has("policy_error_code")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN policy_error_code TEXT");
    if (!columns.has("policy_updated_at_ms")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN policy_updated_at_ms INTEGER");
    if (!columns.has("policy_acked_at_ms")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN policy_acked_at_ms INTEGER");
    if (!columns.has("runner_permissions_json")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN runner_permissions_json TEXT NOT NULL DEFAULT '{\"read\":false,\"edit\":false,\"shell\":false,\"job_control\":false}'");
    if (!columns.has("current_runner_version")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN current_runner_version TEXT");
    if (!columns.has("protocol_min_version")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN protocol_min_version INTEGER");
    if (!columns.has("protocol_max_version")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN protocol_max_version INTEGER");
    if (!columns.has("protocol_compatibility")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN protocol_compatibility TEXT NOT NULL DEFAULT 'unknown'");
    if (!columns.has("update_channel")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN update_channel TEXT NOT NULL DEFAULT 'stable'");
    if (!columns.has("desired_runner_version")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN desired_runner_version TEXT");
    if (!columns.has("latest_runner_version")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN latest_runner_version TEXT");
    if (!columns.has("update_status")) this.ctx.storage.sql.exec("ALTER TABLE runners ADD COLUMN update_status TEXT NOT NULL DEFAULT 'unknown'");
    this.ctx.storage.sql.exec("UPDATE runners SET runner_permissions_json = ? WHERE runner_permissions_json IS NULL OR runner_permissions_json = ''", JSON.stringify(LOCKED_PERMISSIONS));
    this.ctx.storage.sql.exec("UPDATE runners SET update_channel = 'stable' WHERE update_channel IS NULL OR update_channel NOT IN ('stable', 'pinned')");
    this.ctx.storage.sql.exec("UPDATE runners SET protocol_compatibility = 'unknown' WHERE protocol_compatibility IS NULL OR protocol_compatibility NOT IN ('unknown', 'compatible', 'incompatible')");
    this.ctx.storage.sql.exec("UPDATE runners SET update_status = 'unknown' WHERE update_status IS NULL OR update_status NOT IN ('unknown', 'up_to_date', 'update_available', 'pinned', 'incompatible')");

    const mcpColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(mcp_clients)").toArray().map((column) => column.name));
    if (!mcpColumns.has("active_runner_id")) this.ctx.storage.sql.exec("ALTER TABLE mcp_clients ADD COLUMN active_runner_id TEXT");
    if (!mcpColumns.has("active_runner_updated_at_ms")) this.ctx.storage.sql.exec("ALTER TABLE mcp_clients ADD COLUMN active_runner_updated_at_ms INTEGER");
    // These CREATE statements are intentionally duplicated from the bootstrap
    // schema so an upgraded object can repair an older partial schema without
    // replacing data. Existing enrollment rows remain readable.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS managed_workspaces (
        runner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, display_name TEXT NOT NULL, root_path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, permissions_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, validation_status TEXT,
        PRIMARY KEY (runner_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS client_runner_overrides (
        client_id TEXT NOT NULL, runner_id TEXT NOT NULL, permissions_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (client_id, runner_id)
      );
      CREATE TABLE IF NOT EXISTS runner_enrollments (
        enrollment_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, verifier TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_throttle (
        id TEXT PRIMARY KEY CHECK (id IN ('login', 'setup')), failed_attempts INTEGER NOT NULL DEFAULT 0,
        blocked_until_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS internal_request_nonces (
        nonce TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_internal_request_nonces_expiry ON internal_request_nonces(expires_at_ms);
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runner_enrollments_expiry ON runner_enrollments(expires_at_ms)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runner_enrollments_runner ON runner_enrollments(runner_id)");
  }
  private bumpDesiredPolicy(runnerId: string, nowMs: number): void {
    const runner = this.runnerRow(runnerId);
    if (runner === undefined) throw new Error("runner not found");
    this.createPolicySnapshot(runnerId, Math.max(1, runner.desired_policy_revision + 1), nowMs, runner.desired_policy_revision > 0 ? runner.desired_policy_revision : null, crypto.randomUUID());
  }
  private createPolicySnapshot(runnerId: string, revision: number, nowMs: number, sourceRevision: number | null, mutationId: string): void {
    const runner = this.runnerRow(runnerId);
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
    this.ctx.storage.sql.exec("INSERT INTO runner_policy_versions (runner_id, revision, checksum, policy_json, status, created_at_ms, acknowledged_at_ms, validation_summary_json, source_revision, mutation_id) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)", runnerId, revision, checksum, JSON.stringify(policy), nowMs, sourceRevision, mutationId);
    this.ctx.storage.sql.exec("UPDATE runners SET desired_policy_revision = ?, desired_policy_checksum = ?, policy_status = ?, policy_updated_at_ms = ?, updated_at_ms = ? WHERE runner_id = ?", revision, checksum, runner.state === "online" ? "pending" : "offline_pending", nowMs, nowMs, runnerId);
    this.ctx.storage.sql.exec("DELETE FROM runner_policy_versions WHERE runner_id = ? AND revision NOT IN (SELECT revision FROM runner_policy_versions WHERE runner_id = ? ORDER BY revision DESC LIMIT 50) AND revision <> COALESCE((SELECT desired_policy_revision FROM runners WHERE runner_id = ?), -1) AND revision <> COALESCE((SELECT applied_policy_revision FROM runners WHERE runner_id = ?), -1)", runnerId, runnerId, runnerId, runnerId);
  }
  private deleteMissingWorkspaces(runnerId: string, ids: ReadonlySet<string>): void {
    const rows = this.ctx.storage.sql.exec<{ id: string }>("SELECT workspace_id AS id FROM workspaces WHERE runner_id = ?", runnerId).toArray();
    for (const row of rows) if (!ids.has(row.id)) this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE runner_id = ? AND workspace_id = ?", runnerId, row.id);
  }
  private upsertJob(runnerId: string, job: Record<string, unknown>, nowMs: number): void {
    const updated = typeof job.updated_at_ms === "number" ? job.updated_at_ms : nowMs;
    this.ctx.storage.sql.exec(`INSERT INTO jobs (runner_id, job_id, job_json, updated_at_ms) VALUES (?, ?, ?, ?)
      ON CONFLICT(runner_id, job_id) DO UPDATE SET job_json = CASE WHEN excluded.updated_at_ms >= jobs.updated_at_ms THEN excluded.job_json ELSE jobs.job_json END, updated_at_ms = MAX(jobs.updated_at_ms, excluded.updated_at_ms)`, runnerId, job.job_id, JSON.stringify(job), updated);
  }
  private pruneTerminalJobs(runnerId: string): void {
    const rows = this.ctx.storage.sql.exec<{ job_id: string; job_json: string }>("SELECT job_id, job_json FROM jobs WHERE runner_id = ? ORDER BY updated_at_ms DESC, job_id DESC", runnerId).toArray();
    let retained = 0;
    for (const row of rows) { const job = JSON.parse(row.job_json) as { status?: unknown }; if (!TERMINAL_JOB_STATUSES.has(String(job.status))) continue; retained += 1; if (retained > MAX_TERMINAL_JOBS_PER_RUNNER) this.ctx.storage.sql.exec("DELETE FROM jobs WHERE runner_id = ? AND job_id = ?", runnerId, row.job_id); }
  }

}

function authThrottleKind(value: unknown): AuthThrottleKind | undefined { return value === "login" || value === "setup" ? value : undefined; }
function validRunnerVersion(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }
function validUpdateChannel(value: unknown): value is RunnerUpdateChannel { return value === "stable" || value === "pinned"; }
function validUpdateStatus(value: unknown): value is RunnerUpdateStatus { return value === "unknown" || value === "up_to_date" || value === "update_available" || value === "pinned" || value === "incompatible"; }
function protocolCompatibility(minVersion: number, maxVersion: number): RunnerProtocolCompatibility { return minVersion <= PROTOCOL_CURRENT_VERSION && maxVersion >= PROTOCOL_MIN_VERSION ? "compatible" : "incompatible"; }
function updateStatus(channel: RunnerUpdateChannel, desired: string | undefined, latest: string | undefined, current: { current_runner_version?: string | null; protocol_compatibility?: RunnerProtocolCompatibility } | undefined): RunnerUpdateStatus {
  if (current?.protocol_compatibility === "incompatible") return "incompatible";
  if (channel === "pinned") return desired !== undefined && current?.current_runner_version === desired ? "pinned" : "update_available";
  if (latest === undefined || current?.current_runner_version === undefined || current.current_runner_version === null) return "unknown";
  return current.current_runner_version === latest ? "up_to_date" : "update_available";
}

function decodeRunner(row: RunnerRow): RunnerRecord {
  return {
    runner_id: row.runner_id, display_name: row.display_name || row.runner_id, state: row.state, management_mode: row.management_mode === "central" ? "central" : "legacy_local", connection_epoch: row.connection_epoch,
    credential_version: row.credential_version, session_id: row.session_id, metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json) as RunnerMetadata,
    public_info: row.public_info_json === null ? null : JSON.parse(row.public_info_json) as RunnerPublicInfo, last_heartbeat_ms: row.last_heartbeat_ms,
    last_sync_sequence: row.last_sync_sequence, desired_policy_revision: row.desired_policy_revision ?? 0, desired_policy_checksum: row.desired_policy_checksum, applied_policy_revision: row.applied_policy_revision, active_policy_checksum: row.active_policy_checksum,
    runner_reported_policy_revision: row.runner_reported_policy_revision, runner_reported_policy_checksum: row.runner_reported_policy_checksum,
    policy_status: row.policy_status === "applied" || row.policy_status === "invalid" || row.policy_status === "offline_pending" ? row.policy_status : "pending",
    runner_permissions: parsePermissionSet(row.runner_permissions_json) ?? LOCKED_PERMISSIONS,
    current_runner_version: row.current_runner_version, protocol_min_version: row.protocol_min_version, protocol_max_version: row.protocol_max_version,
    protocol_compatibility: row.protocol_compatibility === "compatible" || row.protocol_compatibility === "incompatible" ? row.protocol_compatibility : "unknown",
    update_channel: row.update_channel === "pinned" ? "pinned" : "stable", desired_runner_version: row.desired_runner_version,
    latest_runner_version: row.latest_runner_version, update_status: validUpdateStatus(row.update_status) ? row.update_status : "unknown", updated_at_ms: row.updated_at_ms,
  };
}
function decodeWorkspace(row: ManagedWorkspaceRow): WorkspaceRecord[] {
  const permissions = parsePermissionSet(row.permissions_json);
  return permissions === undefined ? [] : [{ runner_id: row.runner_id, workspace_id: row.workspace_id, display_name: row.display_name, root_path: row.root_path, enabled: row.enabled === 1, permissions, created_at_ms: row.created_at_ms, updated_at_ms: row.updated_at_ms, revision: row.revision, validation_status: row.validation_status }];
}
function decodeMcpClient(row: McpClientRow): McpClientRecord { const scopes = parseScopes(row.scopes_json) ?? []; return { client_id: row.client_id, label: row.label, secret_prefix: row.secret_prefix, scopes, secret_version: row.secret_version, created_at_ms: row.created_at_ms, updated_at_ms: row.updated_at_ms, last_used_at_ms: row.last_used_at_ms, revoked_at_ms: row.revoked_at_ms, active_runner_id: row.active_runner_id, active_runner_updated_at_ms: row.active_runner_updated_at_ms }; }
function safeRunnerContext(runner: RunnerRecord, updatedAtMs: number | null): ActiveRunnerContext {
  return { runner_id: runner.runner_id, state: runner.state, available: runner.state === "online", updated_at_ms: updatedAtMs };
}
function parseJobEvent(value: unknown): { job: { job_id: string; runner_id?: string | undefined } } | undefined { if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined; const input = value as { type?: unknown }; const parsed = input.type === "job.started" ? JobStartedSchema.safeParse(value) : input.type === "job.status" ? JobStatusMessageSchema.safeParse(value) : input.type === "job.completed" ? JobCompletedSchema.safeParse(value) : undefined; return parsed?.success ? { job: parsed.data.job } : undefined; }
function uniqueIds(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function parseRunnerId(value: string | undefined): string | undefined { if (value === undefined) return undefined; try { const decoded = decodeURIComponent(value); return isSafeIdentifier(decoded) && IdentifierSchema.safeParse(decoded).success ? decoded : undefined; } catch { return undefined; } }
async function readCappedBody(request: Request): Promise<string | undefined> { const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_INTERNAL_BODY_BYTES)) return undefined; const body = await request.text(); return new TextEncoder().encode(body).byteLength <= MAX_INTERNAL_BODY_BYTES ? body : undefined; }
function parseJsonObject(body: string): InternalInput | undefined { try { const value = JSON.parse(body) as unknown; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as InternalInput : undefined; } catch { return undefined; } }
function stringField(input: InternalInput, field: string, maxLength: number): string | undefined { const value = input[field]; return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined; }
function integerField(input: InternalInput, field: string): number | undefined { const value = input[field]; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function nullableIntegerField(input: InternalInput, field: string): number | null | undefined { const value = input[field]; return value === null ? null : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function nullableChecksumField(input: InternalInput, field: string): string | null | undefined { const value = input[field]; return value === null ? null : typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }
function runnerPublicInfoField(value: unknown): RunnerPublicInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return safePublicText(item.platform, 128) && safePublicText(item.architecture, 128) && safePublicText(item.hostname, 256) && safePublicText(item.runner_version, 256) && typeof item.protocol_version === "number"
    ? { platform: item.platform, architecture: item.architecture, hostname: item.hostname, runner_version: item.runner_version, protocol_version: item.protocol_version }
    : undefined;
}
function safePublicText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value); }
function permissionSetField(value: unknown): PermissionSet | undefined {
  const permissions = validatePermissionSet(value);
  return permissions === undefined ? undefined : { ...permissions };
}
function parsePermissionSet(value: string): PermissionSet | undefined { try { return permissionSetField(JSON.parse(value) as unknown); } catch { return undefined; } }
function validPermissionSet(value: unknown): value is PermissionSet { return permissionSetField(value) !== undefined; }
function validWorkspaceInput(value: { workspace_id: string; display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }): boolean { return isSafeIdentifier(value.workspace_id) && validLabel(value.display_name) && value.root_path.length > 0 && value.root_path.length <= 4_096 && !value.root_path.includes("\0") && validPermissionSet(value.permissions); }
function validPolicyJson(value: { runner_permissions?: unknown; workspaces?: unknown }): boolean {
  return permissionSetField(value.runner_permissions) !== undefined && Array.isArray(value.workspaces) && value.workspaces.length <= 64 && new Set(value.workspaces.map((workspace) => typeof workspace === "object" && workspace !== null && !Array.isArray(workspace) ? (workspace as Record<string, unknown>).workspace_id : undefined)).size === value.workspaces.length && value.workspaces.every((workspace) => {
    if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return false;
    const item = workspace as Record<string, unknown>;
    return typeof item.workspace_id === "string" && isSafeIdentifier(item.workspace_id) && typeof item.root_path === "string" && item.root_path.length > 0 && item.root_path.length <= 4_096 && !item.root_path.includes("\0") && typeof item.enabled === "boolean" && permissionSetField(item.permissions) !== undefined;
  });
}
function workspaceStatusesField(value: unknown): Array<{ workspace_id: string; status: WorkspaceValidationStatus }> | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const valid = new Set<WorkspaceValidationStatus>(["valid", "missing", "not_directory", "permission_denied", "invalid_path"]);
  const output: Array<{ workspace_id: string; status: WorkspaceValidationStatus }> = [];
  for (const item of value) { if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined; const itemValue = item as Record<string, unknown>; if (typeof itemValue.workspace_id !== "string" || !isSafeIdentifier(itemValue.workspace_id) || typeof itemValue.status !== "string" || !valid.has(itemValue.status as WorkspaceValidationStatus)) return undefined; output.push({ workspace_id: itemValue.workspace_id, status: itemValue.status as WorkspaceValidationStatus }); }
  return output;
}
function validVerifier(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function validLabel(value: string): boolean { return value.trim().length >= 1 && value.length <= 256; }
function validRunnerPublicInfo(value: RunnerPublicInfo): boolean { return value.platform.length > 0 && value.platform.length <= 128 && value.architecture.length > 0 && value.architecture.length <= 128 && value.hostname.length > 0 && value.hostname.length <= 256 && value.runner_version.length > 0 && value.runner_version.length <= 256 && Number.isSafeInteger(value.protocol_version) && value.protocol_version > 0 && value.protocol_version <= 1_000; }
function validScopes(value: readonly CodingScope[]): boolean { return value.length > 0 && value.length <= 3 && new Set(value).size === value.length && value.every((scope) => VALID_SCOPES.has(scope)); }
function scopesField(value: unknown): CodingScope[] | undefined { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !VALID_SCOPES.has(item as CodingScope))) return undefined; const scopes = value as CodingScope[]; return validScopes(scopes) ? scopes : undefined; }
function parseScopes(value: string): CodingScope[] | undefined { try { return scopesField(JSON.parse(value) as unknown); } catch { return undefined; } }
