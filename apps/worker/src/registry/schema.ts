/** Core schema initialization remains in the original synchronous startup path. */
export function createCoreRegistrySchema(sql: SqlStorage): void {
  sql.exec(`
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

export function registrySchemaIsCurrent(sql: SqlStorage): boolean {
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
    const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((row) => row.name));
    if (requiredTables.some((table) => !tables.has(table))) return false;
    return Object.entries(requiredColumns).every(([table, required]) => {
      const columns = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((row) => row.name));
      return required.every((column) => columns.has(column));
    });
  }

export function hasPersistedRegistrySchema(sql: SqlStorage): boolean {
    const tables = sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).toArray().map((row) => row.name);
    return tables.length > 0;
  }
