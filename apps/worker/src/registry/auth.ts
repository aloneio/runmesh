import type { ActiveRunnerContext } from "../contracts/runner-selection.js";
import { parseClientIdentity, parseNativeScopes, parseStoredNativeScopes, type ClientIdentity } from "../contracts/identity.js";
import type { McpClientActiveRunner } from "../contracts/runner-selection.js";
import type { McpRunnerSelectionResult } from "../contracts/runner-selection.js";
import { isSafeIdentifier } from "../security.js";
import { AUTH_SOURCE_RETENTION_MS } from "../auth-throttle.js";
import { MAX_AUTH_THROTTLE_KEYS } from "../auth-throttle.js";
import { reserveSourceAuthAttempt } from "../auth-throttle.js";
import type { AuthThrottleState } from "../auth-throttle.js";
import type { CodingScope, McpClientRecord, VerifiedMcpClient, AdminSettingsRow, AuthThrottleRow, AuthThrottleKind, SessionRow, McpClientRow } from './records.js';
import { CLIENT_LAST_USED_WRITE_INTERVAL_MS, AUTH_THROTTLE_FAILURE_THRESHOLD, AUTH_THROTTLE_INITIAL_BLOCK_MS, AUTH_THROTTLE_MAX_BLOCK_MS } from './records.js';
import { decodeRunner, decodeMcpClient, safeRunnerContext, safeNonnegativeInteger, validVerifier, validLabel, validScopes, expectedRegistryConflict } from './values.js';
import type { RegistryStorage } from './storage.js';
import type { AuthPorts } from './ports.js';

/** Auth operations over a single Registry database. Construction has no I/O.
 * SQL text, arguments, transaction callbacks and await positions are retained. */
export class RegistryAuth {
  public constructor(private readonly storage: RegistryStorage, private readonly ports: AuthPorts) {}
  private readonly fallbackThrottle = new Map<AuthThrottleKind, { failed_attempts: number; blocked_until_ms: number }>();

  private readonly sourceThrottleFallback = new Map<string, AuthThrottleState>();

  private readonly sourceThrottleResets = new Map<string, number>();

  private readonly legacyThrottleResets = new Map<AuthThrottleKind, number>();

  public consumeInternalNonce(nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean {
    if (!/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
    // Uniqueness conflicts mean replay; storage failures must propagate. Avoid
    // scanning/deleting all expired nonces on every signed operation.
    const result = this.storage.sql.exec(`INSERT INTO internal_request_nonces (nonce, expires_at_ms) VALUES (?, ?)
      ON CONFLICT(nonce) DO UPDATE SET expires_at_ms = excluded.expires_at_ms
      WHERE internal_request_nonces.expires_at_ms <= ?`, nonce, expiresAtMs, nowMs);
    // SQLite rowsWritten also includes index entries; a replay writes zero.
    return result.rowsWritten > 0;
  }

  public adminStatus(): { initialized: boolean } { return { initialized: this.settings() !== undefined }; }

  public adminPasswordVerifier(): string | undefined { return this.settings()?.password_verifier; }

  private sourceThrottleMaintenanceAtMs = 0;

  public checkSourceAuthThrottle(kind: AuthThrottleKind, sourceHash: string, nowMs: number): { allowed: boolean; retry_after_ms: number } {
    if (!validVerifier(sourceHash)) return { allowed: false, retry_after_ms: 60_000 };
    const key = `${kind}:${sourceHash}`;
    if (!this.ports.featureHealthDisabled("auth_throttle", nowMs)) {
      try {
        const reserved = this.storage.transactionSync(() => {
          const read = (id: string) => this.storage.sql.exec<AuthThrottleState>("SELECT failed_attempts, blocked_until_ms, updated_at_ms FROM auth_source_throttle WHERE id = ?", id).toArray()[0];
          const resetAt = this.sourceThrottleResets.get(key);
          if (resetAt !== undefined) {
            this.storage.sql.exec("DELETE FROM auth_source_throttle WHERE id = ? AND updated_at_ms <= ?", key, resetAt);
          }
          const prior = read(key);
          if (prior !== undefined && prior.blocked_until_ms > nowMs) return { allowed: false, retry_after_ms: prior.blocked_until_ms - nowMs };
          if (nowMs >= this.sourceThrottleMaintenanceAtMs) {
            const cutoff = nowMs - AUTH_SOURCE_RETENTION_MS;
            if (this.storage.sql.exec("SELECT 1 FROM auth_source_throttle WHERE updated_at_ms < ? LIMIT 1", cutoff).toArray().length > 0) {
              this.storage.sql.exec("DELETE FROM auth_source_throttle WHERE updated_at_ms < ?", cutoff);
            }
            this.sourceThrottleMaintenanceAtMs = nowMs + 60_000;
          }
          const count = this.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM auth_source_throttle").toArray()[0]?.total ?? 0;
          if (read(key) === undefined && count >= MAX_AUTH_THROTTLE_KEYS - 2) {
            const needed = count - (MAX_AUTH_THROTTLE_KEYS - 2) + 1;
            const candidates = this.storage.sql.exec<{ id: string }>("SELECT id FROM auth_source_throttle WHERE length(id) > 64 AND blocked_until_ms <= ? ORDER BY updated_at_ms, id LIMIT ?", nowMs, needed).toArray();
            if (candidates.length < needed) return { allowed: false, retry_after_ms: 60_000 };
            for (const candidate of candidates) this.storage.sql.exec("DELETE FROM auth_source_throttle WHERE id = ?", candidate.id);
          }
          return reserveSourceAuthAttempt({ read, write: (id, state) => {
            this.storage.sql.exec(
              `INSERT INTO auth_source_throttle (id, failed_attempts, blocked_until_ms, updated_at_ms) VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET failed_attempts = excluded.failed_attempts, blocked_until_ms = excluded.blocked_until_ms, updated_at_ms = excluded.updated_at_ms`,
              id, state.failed_attempts, state.blocked_until_ms, state.updated_at_ms,
            );
          } }, kind, sourceHash, nowMs);
        });
        this.sourceThrottleResets.delete(key);
        return reserved;
      } catch (error) { this.ports.disableFeatureHealth("auth_throttle", error, nowMs); }
    }
    // Expired counters cannot resurrect a lockout after their retention window.
    for (const [id, resetAt] of this.sourceThrottleResets) if (resetAt < nowMs - AUTH_SOURCE_RETENTION_MS) this.sourceThrottleResets.delete(id);
    if (!this.sourceThrottleResets.has(key) && this.sourceThrottleResets.size >= MAX_AUTH_THROTTLE_KEYS) return { allowed: false, retry_after_ms: 60_000 };
    for (const [id, state] of this.sourceThrottleFallback) if (state.updated_at_ms < nowMs - AUTH_SOURCE_RETENTION_MS) this.sourceThrottleFallback.delete(id);
    while (!this.sourceThrottleFallback.has(key) && this.sourceThrottleFallback.size >= MAX_AUTH_THROTTLE_KEYS - 2) {
      const evict = [...this.sourceThrottleFallback].filter(([id, state]) => id.length > 64 && state.blocked_until_ms <= nowMs)
        .sort((a, b) => a[1].updated_at_ms - b[1].updated_at_ms)[0];
      if (evict === undefined) return { allowed: false, retry_after_ms: 60_000 };
      this.sourceThrottleFallback.delete(evict[0]);
    }
    return reserveSourceAuthAttempt({ read: (id) => this.sourceThrottleFallback.get(id), write: (id, state) => { this.sourceThrottleFallback.set(id, state); } }, kind, sourceHash, nowMs);
  }

  public recordSourceAuthAttempt(kind: AuthThrottleKind, sourceHash: string, success: boolean, nowMs: number): void {
    if (!validVerifier(sourceHash) || !success) return;
    const key = `${kind}:${sourceHash}`;
    this.sourceThrottleFallback.delete(key);
    this.sourceThrottleResets.set(key, nowMs);
    // A DELETE may succeed after an earlier quota/write circuit breaker trip.
    // Do not skip it merely because optional writes are still cooling down.
    try {
      this.storage.sql.exec("DELETE FROM auth_source_throttle WHERE id = ? AND updated_at_ms <= ?", key, nowMs);
      this.sourceThrottleResets.delete(key);
    } catch (error) { this.ports.disableFeatureHealth("auth_throttle", error, nowMs); }
    // A successful login clears only its own source, never the global CPU budget.
  }

  public checkAuthThrottle(kind: AuthThrottleKind, nowMs: number): { allowed: boolean; retry_after_ms: number } {
    if (this.ports.featureHealthDisabled("auth_throttle", nowMs)) return this.checkFallbackThrottle(kind, nowMs);
    try {
      const reserved = this.storage.transactionSync(() => {
      const resetAt = this.legacyThrottleResets.get(kind);
      if (resetAt !== undefined) this.storage.sql.exec("DELETE FROM auth_throttle WHERE id = ? AND updated_at_ms <= ?", kind, resetAt);
      const row = this.authThrottleRow(kind);
      const retryAfter = row === undefined ? 0 : Math.max(0, row.blocked_until_ms - nowMs);
      if (retryAfter > 0) return { allowed: false, retry_after_ms: retryAfter };
      const failedAttempts = (row?.failed_attempts ?? 0) + 1;
      const exponent = Math.min(Math.max(0, failedAttempts - AUTH_THROTTLE_FAILURE_THRESHOLD), 30);
      const blockMs = failedAttempts < AUTH_THROTTLE_FAILURE_THRESHOLD
        ? 0
        : Math.min(AUTH_THROTTLE_MAX_BLOCK_MS, AUTH_THROTTLE_INITIAL_BLOCK_MS * (2 ** exponent));
      this.storage.sql.exec(
        `INSERT INTO auth_throttle (id, failed_attempts, blocked_until_ms, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET failed_attempts = excluded.failed_attempts, blocked_until_ms = excluded.blocked_until_ms, updated_at_ms = excluded.updated_at_ms`,
        kind, failedAttempts, blockMs === 0 ? 0 : nowMs + blockMs, nowMs,
      );
      // The attempt that reaches the threshold is admitted; only subsequent
      // attempts are blocked, so this means five failed KDFs then a delay.
      return { allowed: true, retry_after_ms: 0 };
      });
      this.legacyThrottleResets.delete(kind);
      return reserved;
    } catch (error) {
      this.ports.disableFeatureHealth("auth_throttle", error, nowMs);
      return this.checkFallbackThrottle(kind, nowMs);
    }
  }

  public checkFallbackThrottle(kind: AuthThrottleKind, nowMs: number): { allowed: boolean; retry_after_ms: number } {
    const prior = this.fallbackThrottle.get(kind);
    const retryAfter = prior === undefined ? 0 : Math.max(0, prior.blocked_until_ms - nowMs);
    if (retryAfter > 0) return { allowed: false, retry_after_ms: retryAfter };
    const failedAttempts = (prior?.failed_attempts ?? 0) + 1;
    const exponent = Math.min(Math.max(0, failedAttempts - AUTH_THROTTLE_FAILURE_THRESHOLD), 30);
    const blockMs = failedAttempts < AUTH_THROTTLE_FAILURE_THRESHOLD ? 0 : Math.min(AUTH_THROTTLE_MAX_BLOCK_MS, AUTH_THROTTLE_INITIAL_BLOCK_MS * (2 ** exponent));
    this.fallbackThrottle.set(kind, { failed_attempts: failedAttempts, blocked_until_ms: blockMs === 0 ? 0 : nowMs + blockMs });
    return { allowed: true, retry_after_ms: 0 };
  }

  public recordAuthAttempt(kind: AuthThrottleKind, success: boolean, nowMs: number): void {
    if (success) this.legacyThrottleResets.set(kind, nowMs);
    if (this.ports.featureHealthDisabled("auth_throttle", nowMs)) {
      if (success) this.fallbackThrottle.delete(kind);
      return;
    }
    try {
      if (!success) {
      // checkAuthThrottle already reserved and persisted the failure before the
      // expensive KDF. Keep an outcome timestamp without exposing any secret.
      this.storage.sql.exec("UPDATE auth_throttle SET updated_at_ms = ? WHERE id = ?", nowMs, kind);
        return;
      }
      this.storage.sql.exec(
      `INSERT INTO auth_throttle (id, failed_attempts, blocked_until_ms, updated_at_ms) VALUES (?, 0, 0, ?)
       ON CONFLICT(id) DO UPDATE SET failed_attempts = 0, blocked_until_ms = 0, updated_at_ms = excluded.updated_at_ms`,
      kind, nowMs,
      );
    } catch (error) {
      this.ports.disableFeatureHealth("auth_throttle", error, nowMs);
      if (success) this.fallbackThrottle.delete(kind);
    }
  }

  public setupAdmin(passwordVerifier: string, nowMs: number): boolean {
    return this.storage.transactionSync(() => {
      if (this.settings() !== undefined) return false;
      this.storage.sql.exec(
        "INSERT INTO admin_settings (id, password_verifier, session_version, created_at_ms, updated_at_ms) VALUES (1, ?, 1, ?, ?)",
        passwordVerifier, nowMs, nowMs,
      );
      return true;
    });
  }

  public createAdminSession(sessionHash: string, csrfHash: string, expiresAtMs: number, nowMs: number, expectedSessionVersion: number): boolean {
    if (!Number.isSafeInteger(expectedSessionVersion) || expectedSessionVersion < 1) return false;
    return this.storage.transactionSync(() => {
      const settings = this.settings();
      if (settings === undefined || settings.session_version !== expectedSessionVersion) return false;
      this.storage.sql.exec(
        "INSERT INTO admin_sessions (session_hash, csrf_hash, created_at_ms, expires_at_ms, session_version) VALUES (?, ?, ?, ?, ?)",
        sessionHash, csrfHash, nowMs, expiresAtMs, expectedSessionVersion,
      );
      return true;
    });
  }

  public verifyAdminSession(sessionHash: string, nowMs: number): { csrf_hash: string } | undefined {
    const row = this.storage.sql.exec<SessionRow>(
      `SELECT s.csrf_hash, s.expires_at_ms, s.session_version FROM admin_sessions s
       JOIN admin_settings a ON a.id = 1 WHERE s.session_hash = ?`, sessionHash,
    ).toArray()[0];
    const settings = this.settings();
    if (row === undefined || settings === undefined || row.expires_at_ms <= nowMs || row.session_version !== settings.session_version) {
      if (row !== undefined) {
        try { this.storage.sql.exec("DELETE FROM admin_sessions WHERE session_hash = ?", sessionHash); } catch { /* session cleanup is optional */ }
      }
      return undefined;
    }
    return { csrf_hash: row.csrf_hash };
  }

  public logoutAdminSession(sessionHash: string): void { this.storage.sql.exec("DELETE FROM admin_sessions WHERE session_hash = ?", sessionHash); }

  public changeAdminPassword(passwordVerifier: string, nowMs: number): boolean {
    return this.storage.transactionSync(() => {
      if (this.settings() === undefined) return false;
      this.storage.sql.exec(
        "UPDATE admin_settings SET password_verifier = ?, session_version = session_version + 1, updated_at_ms = ? WHERE id = 1",
        passwordVerifier, nowMs,
      );
      this.storage.sql.exec("DELETE FROM admin_sessions");
      return true;
    });
  }

  public listMcpClients(): McpClientRecord[] {
    return this.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients ORDER BY created_at_ms DESC, client_id").toArray().map(decodeMcpClient);
  }

  public createMcpClient(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string; scopes: readonly CodingScope[] }, nowMs: number): McpClientRecord | undefined {
    if (!validScopes(input.scopes)) return undefined;
    return this.insertMcpClient(input, JSON.stringify(input.scopes), nowMs);
  }

  public createMcpIdentity(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string; native_scopes: readonly CodingScope[] }, nowMs: number): ClientIdentity | undefined {
    const scopes = parseNativeScopes(input.native_scopes, true);
    if (scopes === undefined) return undefined;
    const client = this.insertMcpClient(input, JSON.stringify({ schema_version: 2, native_scopes: scopes }), nowMs);
    return client === undefined ? undefined : this.revalidateMcpIdentity(client.client_id, client.secret_version);
  }

  private insertMcpClient(input: { client_id: string; label: string; secret_verifier: string; secret_prefix: string }, scopesJson: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(input.client_id) || !validLabel(input.label) || !validVerifier(input.secret_verifier) || !/^[A-Za-z0-9_-]{4,16}$/.test(input.secret_prefix)) return undefined;
    try {
      this.storage.sql.exec(
        `INSERT INTO mcp_clients (client_id, label, secret_verifier, secret_prefix, scopes_json, secret_version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, input.client_id, input.label, input.secret_verifier, input.secret_prefix, scopesJson, nowMs, nowMs,
      );
    } catch (error) { if (expectedRegistryConflict(error, [])) return undefined; throw error; }
    return this.getMcpClient(input.client_id);
  }

  public setJobRecording(clientId: string, enabled: boolean, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId) || typeof enabled !== "boolean" || !safeNonnegativeInteger(nowMs)) return undefined;
    // Enabling starts a new capture window. Old unrecorded jobs must not be
    // backfilled by a later Runner sync. Existing historical records remain.
    this.storage.sql.exec("UPDATE mcp_clients SET record_jobs = ?, record_jobs_since_ms = ?, updated_at_ms = ? WHERE client_id = ? AND record_jobs <> ?", enabled ? 1 : 0, nowMs, nowMs, clientId, enabled ? 1 : 0);
    return this.getMcpClient(clientId);
  }

  public recordsJobActivity(clientId: string): boolean {
    return this.getMcpClient(clientId)?.record_jobs !== false;
  }

  public updateMcpClientScopes(clientId: string, scopes: readonly CodingScope[], nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId) || !validScopes(scopes) || this.getMcpClient(clientId) === undefined) return undefined;
    this.storage.sql.exec("UPDATE mcp_clients SET scopes_json = ?, updated_at_ms = ? WHERE client_id = ?", JSON.stringify(scopes), nowMs, clientId);
    return this.getMcpClient(clientId);
  }

  public renameMcpClient(clientId: string, label: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId) || !validLabel(label)) return undefined;
    this.storage.sql.exec("UPDATE mcp_clients SET label = ?, updated_at_ms = ? WHERE client_id = ?", label, nowMs, clientId);
    return this.getMcpClient(clientId);
  }

  public rotateMcpClient(clientId: string, secretVerifier: string, secretPrefix: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId) || !validVerifier(secretVerifier) || !/^[A-Za-z0-9_-]{4,16}$/.test(secretPrefix)) return undefined;
    try {
      this.storage.sql.exec(
        `UPDATE mcp_clients SET secret_verifier = ?, secret_prefix = ?, secret_version = secret_version + 1,
         revoked_at_ms = NULL, updated_at_ms = ? WHERE client_id = ?`, secretVerifier, secretPrefix, nowMs, clientId,
      );
    } catch (error) { if (expectedRegistryConflict(error, [])) return undefined; throw error; }
    return this.getMcpClient(clientId);
  }

  public revokeMcpClient(clientId: string, nowMs: number): McpClientRecord | undefined {
    if (!isSafeIdentifier(clientId)) return undefined;
    this.storage.sql.exec("UPDATE mcp_clients SET revoked_at_ms = ?, updated_at_ms = ? WHERE client_id = ?", nowMs, nowMs, clientId);
    return this.getMcpClient(clientId);
  }

  public verifyMcpClient(secretVerifier: string, nowMs: number): VerifiedMcpClient | undefined {
    const identity = this.verifyMcpIdentity(secretVerifier, nowMs);
    return identity === undefined || identity.native_scopes.length === 0 ? undefined : {
      client_id: identity.client_id, label: identity.label, scopes: identity.native_scopes, secret_version: identity.secret_version,
    };
  }

  public verifyMcpIdentity(secretVerifier: string, nowMs: number): ClientIdentity | undefined {
    if (!validVerifier(secretVerifier)) return undefined;
    const row = this.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients WHERE secret_verifier = ?", secretVerifier).toArray()[0];
    if (row === undefined || row.revoked_at_ms !== null) return undefined;
    const identity = this.identityFromRow(row);
    if (identity === undefined) return undefined;
    if (!this.ports.featureHealthDisabled("mcp_usage_tracking", nowMs) && (row.last_used_at_ms === null || row.last_used_at_ms <= nowMs - CLIENT_LAST_USED_WRITE_INTERVAL_MS)) {
      try { this.storage.sql.exec("UPDATE mcp_clients SET last_used_at_ms = ? WHERE client_id = ?", nowMs, row.client_id); }
      catch (error) { this.ports.disableFeatureHealth("mcp_usage_tracking", error, nowMs); }
    }
    return identity;
  }

  public revalidateMcpClient(clientId: unknown, secretVersion: unknown, includeJobRecording = false): VerifiedMcpClient | undefined {
    const observed = this.currentIdentity(clientId, secretVersion);
    if (observed === undefined || observed.identity.native_scopes.length === 0) return undefined;
    const { identity, row } = observed;
    return { client_id: identity.client_id, label: identity.label, scopes: identity.native_scopes, secret_version: identity.secret_version,
      ...(includeJobRecording ? { record_history: row.record_jobs !== 0 } : {}) };
  }

  public revalidateMcpIdentity(clientId: unknown, secretVersion: unknown): ClientIdentity | undefined {
    return this.currentIdentity(clientId, secretVersion)?.identity;
  }

  private currentIdentity(clientId: unknown, secretVersion: unknown): { identity: ClientIdentity; row: McpClientRow } | undefined {
    if (typeof clientId !== "string" || !isSafeIdentifier(clientId) || !Number.isSafeInteger(secretVersion) || (secretVersion as number) < 1) return undefined;
    const row = this.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients WHERE client_id = ?", clientId).toArray()[0];
    if (row === undefined || row.revoked_at_ms !== null || row.secret_version !== secretVersion) return undefined;
    const identity = this.identityFromRow(row);
    return identity === undefined ? undefined : { identity, row };
  }

  private identityFromRow(row: McpClientRow): ClientIdentity | undefined {
    const scopes = parseStoredNativeScopes(row.scopes_json);
    return scopes === undefined ? undefined : parseClientIdentity({ schema_version: 2, client_id: row.client_id,
      label: row.label, secret_version: row.secret_version, native_scopes: scopes });
  }

  public getMcpClientActiveRunner(clientId: string): McpClientActiveRunner | undefined {
    const client = this.getMcpClient(clientId);
    if (client === undefined) return undefined;
    return {
      active_runner_id: client.active_runner_id,
      active_runner_updated_at_ms: client.active_runner_updated_at_ms,
      runner: client.active_runner_id === null ? null : this.activeRunnerContext(client.active_runner_id, client.active_runner_updated_at_ms),
    };
  }

  public selectMcpClientRunner(clientId: string, runnerId: string, confirmSwitch: boolean, nowMs: number): McpRunnerSelectionResult {
    if (!isSafeIdentifier(clientId)) return { ok: false, code: "client_not_found" };
    const target = isSafeIdentifier(runnerId) ? this.ports.runnerRow(runnerId) : undefined;
    if (target === undefined) return { ok: false, code: "runner_not_found" };
    if (target.token_verifier.length === 0) return { ok: false, code: "runner_unavailable" };
    return this.storage.transactionSync(() => {
      const selection = this.getMcpClientActiveRunner(clientId);
      if (selection === undefined) return { ok: false, code: "client_not_found" };
      if (selection.active_runner_id !== null && selection.active_runner_id !== runnerId && !confirmSwitch) {
        return { ok: false, code: "runner_switch_confirmation_required", selection };
      }
      const changed = selection.active_runner_id !== runnerId;
      if (changed) this.storage.sql.exec(
        "UPDATE mcp_clients SET active_runner_id = ?, active_runner_updated_at_ms = ?, updated_at_ms = ? WHERE client_id = ?",
        runnerId, nowMs, nowMs, clientId,
      );
      const updated = this.getMcpClientActiveRunner(clientId);
      return updated === undefined ? { ok: false, code: "client_not_found" } : { ok: true, selection: updated, changed };
    });
  }

  public resetMcpClientRunner(clientId: string, nowMs: number): McpClientActiveRunner | undefined {
    if (!isSafeIdentifier(clientId) || this.getMcpClient(clientId) === undefined) return undefined;
    this.storage.sql.exec("UPDATE mcp_clients SET active_runner_id = NULL, active_runner_updated_at_ms = ?, updated_at_ms = ? WHERE client_id = ?", nowMs, nowMs, clientId);
    return this.getMcpClientActiveRunner(clientId);
  }

  public autoSelectOnlyRunner(clientId: string, nowMs: number): McpRunnerSelectionResult | undefined {
    const selection = this.getMcpClientActiveRunner(clientId);
    if (selection === undefined) return { ok: false, code: "client_not_found" };
    if (selection.active_runner_id !== null) return { ok: true, selection, changed: false };
    const runners = this.ports.listRunners();
    if (runners.length !== 1) return undefined;
    return this.selectMcpClientRunner(clientId, runners[0]?.runner_id ?? "", false, nowMs);
  }

  public settings(): AdminSettingsRow | undefined { return this.storage.sql.exec<AdminSettingsRow>("SELECT password_verifier, session_version, created_at_ms, updated_at_ms FROM admin_settings WHERE id = 1").toArray()[0]; }

  public authThrottleRow(kind: AuthThrottleKind): AuthThrottleRow | undefined { return this.storage.sql.exec<AuthThrottleRow>("SELECT id, failed_attempts, blocked_until_ms, updated_at_ms FROM auth_throttle WHERE id = ?", kind).toArray()[0]; }

  public getMcpClient(clientId: string): McpClientRecord | undefined { const row = this.storage.sql.exec<McpClientRow>("SELECT * FROM mcp_clients WHERE client_id = ?", clientId).toArray()[0]; return row === undefined ? undefined : decodeMcpClient(row); }

  public activeRunnerContext(runnerId: string, updatedAtMs: number | null): ActiveRunnerContext {
    const row = this.ports.runnerRow(runnerId);
    if (row === undefined || row.token_verifier.length === 0) return { runner_id: runnerId, state: "unavailable", available: false, updated_at_ms: updatedAtMs };
    return safeRunnerContext(decodeRunner(row), updatedAtMs);
  }
}
