import {
  JobCompletedSchema,
  JobStartedSchema,
  JobStatusMessageSchema,
  IdentifierSchema,
  RunnerMetadataSchema,
  RunnerSyncSchema,
  type RunnerMetadata,
} from "@remote-coding-runtime/protocol";
import { constantTimeEqual, isSafeIdentifier, runnerTokenVerifier, verifyInternalRequest } from "./security.js";

export type RunnerConnectionState = "online" | "offline" | "stale";
export type CodingScope = "coding:read" | "coding:write" | "coding:exec";
const VALID_SCOPES = new Set<CodingScope>(["coding:read", "coding:write", "coding:exec"]);

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
  readonly session_id: string | null;
  readonly metadata: RunnerMetadata | null;
  /** Safe enrollment-time identity/version data, intentionally excluding paths and credentials. */
  readonly public_info: RunnerPublicInfo | null;
  readonly last_heartbeat_ms: number | null;
  readonly last_sync_sequence: number | null;
  readonly updated_at_ms: number;
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
  session_id: string | null;
  metadata_json: string | null;
  public_info_json: string | null;
  last_heartbeat_ms: number | null;
  last_sync_sequence: number | null;
  updated_at_ms: number;
};
type EnrollmentRow = { enrollment_id: string; runner_id: string; verifier: string; created_at_ms: number; expires_at_ms: number; used_at_ms: number | null };
type WorkspaceRow = { workspace_json: string };
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
          connection_epoch INTEGER NOT NULL DEFAULT 0, credential_version INTEGER NOT NULL DEFAULT 1,
          session_id TEXT, metadata_json TEXT, public_info_json TEXT, last_heartbeat_ms INTEGER, last_sync_sequence INTEGER,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          runner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, workspace_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL, PRIMARY KEY (runner_id, workspace_id)
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
    // Used enrollment records have no continuing value; retain unexpired rows only.
    this.ctx.storage.sql.exec("DELETE FROM runner_enrollments WHERE expires_at_ms <= ? OR used_at_ms IS NOT NULL", nowMs);
    await this.ctx.storage.setAlarm(nowMs + 30_000);
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
    if (!isSafeIdentifier(input.client_id) || !validLabel(input.label) || !validScopes(input.scopes) || !validVerifier(input.secret_verifier) || !validPrefix(input.secret_prefix)) return undefined;
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
    if (!isSafeIdentifier(clientId) || !validVerifier(secretVerifier) || !validPrefix(secretPrefix)) return undefined;
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

  public registerRunner(runnerId: string, tokenVerifier: string, nowMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO runners (runner_id, display_name, token_verifier, state, credential_version, updated_at_ms)
       VALUES (?, ?, ?, 'offline', 1, ?)
       ON CONFLICT(runner_id) DO UPDATE SET token_verifier = excluded.token_verifier,
         display_name = CASE WHEN runners.display_name = '' THEN excluded.display_name ELSE runners.display_name END,
         credential_version = runners.credential_version + 1, connection_epoch = runners.connection_epoch + 1,
         state = 'offline', session_id = NULL, metadata_json = NULL,
         last_heartbeat_ms = NULL, last_sync_sequence = NULL, updated_at_ms = excluded.updated_at_ms`, runnerId, runnerId, tokenVerifier, nowMs,
    );
  }
  public addRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || !validLabel(displayName)) return undefined;
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO runners (runner_id, display_name, token_verifier, state, credential_version, updated_at_ms)
         VALUES (?, ?, '', 'offline', 0, ?)`, runnerId, displayName, nowMs,
      );
    } catch { return undefined; }
    return this.getRunner(runnerId);
  }
  public renameRunner(runnerId: string, displayName: string, nowMs: number): RunnerRecord | undefined {
    if (!isSafeIdentifier(runnerId) || !validLabel(displayName)) return undefined;
    this.ctx.storage.sql.exec("UPDATE runners SET display_name = ?, updated_at_ms = ? WHERE runner_id = ?", displayName, nowMs, runnerId);
    return this.getRunner(runnerId);
  }
  public deleteRunner(runnerId: string, nowMs: number): boolean {
    if (!isSafeIdentifier(runnerId) || this.runnerRow(runnerId) === undefined) return false;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM runner_enrollments WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE runner_id = ?", runnerId);
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
         state = 'offline', session_id = NULL, metadata_json = NULL, public_info_json = ?, last_heartbeat_ms = NULL,
         last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ?`, tokenVerifier, JSON.stringify(publicInfo), nowMs, row.runner_id,
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
  public beginConnection(runnerId: string, metadata: RunnerMetadata, sessionId: string, credentialVersion: number, nowMs: number): number | undefined {
    this.ctx.storage.sql.exec(
      `UPDATE runners SET state = 'online', connection_epoch = connection_epoch + 1, session_id = ?, metadata_json = ?,
       last_heartbeat_ms = ?, last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ? AND credential_version = ?`,
      sessionId, JSON.stringify(metadata), nowMs, nowMs, runnerId, credentialVersion,
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
  public revokeRunner(runnerId: string, nowMs: number): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`UPDATE runners SET credential_version = credential_version + 1, connection_epoch = connection_epoch + 1,
       token_verifier = '', state = 'offline', session_id = NULL, metadata_json = NULL, last_heartbeat_ms = NULL,
       last_sync_sequence = NULL, updated_at_ms = ? WHERE runner_id = ?`, nowMs, runnerId);
      this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE runner_id = ?", runnerId);
      this.ctx.storage.sql.exec("DELETE FROM jobs WHERE runner_id = ?", runnerId);
    });
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
    if (!await verifyInternalRequest(request, this.env.INTERNAL_CONTROL_SECRET, rawBody)) return new Response("not found", { status: 404 });
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
    if (segments[0] === "auth") return this.handleAuth(request.method, segments.slice(1), input, now);
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
      const sessionId = stringField(input, "session_id", 128); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const metadata = RunnerMetadataSchema.safeParse(input.metadata);
      if (!metadata.success || sessionId === undefined || credentialVersion === undefined || nowMs === undefined) return Response.json({ error: "invalid connection metadata" }, { status: 400 });
      const epoch = this.beginConnection(runnerId, metadata.data, sessionId, credentialVersion, nowMs); return epoch === undefined ? new Response("stale credentials", { status: 409 }) : Response.json({ epoch });
    }
    if (request.method === "POST" && action === "heartbeat") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); if (epoch === undefined || credentialVersion === undefined || nowMs === undefined) return Response.json({ error: "invalid heartbeat" }, { status: 400 }); return this.recordHeartbeat(runnerId, epoch, credentialVersion, nowMs) ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 }); }
    if (request.method === "POST" && action === "session") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); return epoch !== undefined && credentialVersion !== undefined && this.sessionIsCurrent(runnerId, epoch, credentialVersion) ? new Response(null, { status: 204 }) : new Response("stale session", { status: 409 }); }
    if (request.method === "POST" && action === "disconnect") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || (input.state !== "offline" && input.state !== "stale")) return Response.json({ error: "invalid disconnect" }, { status: 400 }); this.markDisconnected(runnerId, epoch, credentialVersion, input.state, nowMs); return new Response(null, { status: 204 }); }
    if (request.method === "POST" && action === "sync") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); const message = RunnerSyncSchema.safeParse(input.message); if (!message.success || epoch === undefined || credentialVersion === undefined || nowMs === undefined || message.data.runner_id !== runnerId || message.data.workspaces.length > MAX_SYNC_ITEMS || message.data.jobs.length > MAX_SYNC_ITEMS || !uniqueIds(message.data.workspaces.map((workspace) => workspace.workspace_id)) || !uniqueIds(message.data.jobs.map((job) => job.job_id))) return Response.json({ error: "invalid sync" }, { status: 400 }); return this.syncRunner(runnerId, epoch, credentialVersion, message.data.workspaces, message.data.jobs, message.data.sync_sequence, nowMs) ? new Response(null, { status: 204 }) : new Response("stale sync or session", { status: 409 }); }
    if (request.method === "POST" && action === "event") { const epoch = integerField(input, "epoch"); const credentialVersion = integerField(input, "credential_version"); const nowMs = integerField(input, "now_ms"); if (epoch === undefined || credentialVersion === undefined || nowMs === undefined || !this.recordJobEvent(runnerId, epoch, credentialVersion, input.message, nowMs)) return new Response("stale session or invalid event", { status: 409 }); return new Response(null, { status: 204 }); }
    if (request.method === "POST" && action === "add") {
      const displayName = stringField(input, "display_name", 256); const runner = displayName === undefined ? undefined : this.addRunner(runnerId, displayName, now);
      return runner === undefined ? new Response("conflict", { status: 409 }) : Response.json(runner);
    }
    if (request.method === "DELETE" && action === undefined) return this.deleteRunner(runnerId, now) ? new Response(null, { status: 204 }) : new Response("not found", { status: 404 });
    if (request.method === "POST" && action === "rename") { const displayName = stringField(input, "display_name", 256); const runner = displayName === undefined ? undefined : this.renameRunner(runnerId, displayName, now); return runner === undefined ? new Response("not found", { status: 404 }) : Response.json(runner); }
    if (request.method === "POST" && action === "enrollments") { const enrollmentId = stringField(input, "enrollment_id", 43); const verifier = stringField(input, "verifier", 64); const enrollment = enrollmentId === undefined || verifier === undefined ? undefined : this.createRunnerEnrollment(runnerId, enrollmentId, verifier, now); return enrollment === undefined ? new Response("not found", { status: 404 }) : Response.json(enrollment); }
    if (request.method === "POST" && action === "rotate") { this.invalidateRunnerCredential(runnerId, now); return new Response(null, { status: 204 }); }
    if (request.method === "POST" && action === "revoke") { this.revokeRunner(runnerId, now); return new Response(null, { status: 204 }); }
    if (request.method === "GET" && action === "workspaces" && itemId === undefined) return Response.json({ runner_id: runnerId, workspaces: this.listWorkspaces(runnerId) });
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

  private handleAuth(method: string, segments: string[], input: InternalInput, nowMs: number): Response {
    const action = segments[0]; const clientId = segments[1];
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

    const mcpColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(mcp_clients)").toArray().map((column) => column.name));
    if (!mcpColumns.has("active_runner_id")) this.ctx.storage.sql.exec("ALTER TABLE mcp_clients ADD COLUMN active_runner_id TEXT");
    if (!mcpColumns.has("active_runner_updated_at_ms")) this.ctx.storage.sql.exec("ALTER TABLE mcp_clients ADD COLUMN active_runner_updated_at_ms INTEGER");
    // These CREATE statements are intentionally duplicated from the bootstrap
    // schema so an upgraded object can repair an older partial schema without
    // replacing data. Existing enrollment rows remain readable.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runner_enrollments (
        enrollment_id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, verifier TEXT NOT NULL UNIQUE,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_throttle (
        id TEXT PRIMARY KEY CHECK (id IN ('login', 'setup')), failed_attempts INTEGER NOT NULL DEFAULT 0,
        blocked_until_ms INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runner_enrollments_expiry ON runner_enrollments(expires_at_ms)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_runner_enrollments_runner ON runner_enrollments(runner_id)");
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
function decodeRunner(row: RunnerRow): RunnerRecord { return { runner_id: row.runner_id, display_name: row.display_name || row.runner_id, state: row.state, connection_epoch: row.connection_epoch, credential_version: row.credential_version, session_id: row.session_id, metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json) as RunnerMetadata, public_info: row.public_info_json === null ? null : JSON.parse(row.public_info_json) as RunnerPublicInfo, last_heartbeat_ms: row.last_heartbeat_ms, last_sync_sequence: row.last_sync_sequence, updated_at_ms: row.updated_at_ms }; }
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
function runnerPublicInfoField(value: unknown): RunnerPublicInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return safePublicText(item.platform, 128) && safePublicText(item.architecture, 128) && safePublicText(item.hostname, 256) && safePublicText(item.runner_version, 256) && typeof item.protocol_version === "number"
    ? { platform: item.platform, architecture: item.architecture, hostname: item.hostname, runner_version: item.runner_version, protocol_version: item.protocol_version }
    : undefined;
}
function safePublicText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value); }
function validVerifier(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function validPrefix(value: string): boolean { return /^[A-Za-z0-9_-]{4,16}$/.test(value); }
function validLabel(value: string): boolean { return value.trim().length >= 1 && value.length <= 256; }
function validRunnerPublicInfo(value: RunnerPublicInfo): boolean { return value.platform.length > 0 && value.platform.length <= 128 && value.architecture.length > 0 && value.architecture.length <= 128 && value.hostname.length > 0 && value.hostname.length <= 256 && value.runner_version.length > 0 && value.runner_version.length <= 256 && Number.isSafeInteger(value.protocol_version) && value.protocol_version > 0 && value.protocol_version <= 1_000; }
function validScopes(value: readonly CodingScope[]): boolean { return value.length > 0 && value.length <= 3 && new Set(value).size === value.length && value.every((scope) => VALID_SCOPES.has(scope)); }
function scopesField(value: unknown): CodingScope[] | undefined { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !VALID_SCOPES.has(item as CodingScope))) return undefined; const scopes = value as CodingScope[]; return validScopes(scopes) ? scopes : undefined; }
function parseScopes(value: string): CodingScope[] | undefined { try { return scopesField(JSON.parse(value) as unknown); } catch { return undefined; } }
