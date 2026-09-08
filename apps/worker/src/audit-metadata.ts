/** Tool payloads are deliberately absent from this durable audit contract. */
export const MCP_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const AUDIT_METADATA_KEYS = new Set([
  "runner_id", "call_id", "client_id", "method", "workspace_id", "job_id",
  "status", "error_code", "result_runner_id", "started_at_ms", "completed_at_ms",
  "duration_ms", "epoch", "credential_version", "lifecycle_id", "session_id", "recorded_at_ms",
]);

/** Defense in depth for legacy rows: never return arbitrary persisted objects. */
export function projectMcpAuditMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, field]) =>
    AUDIT_METADATA_KEYS.has(key) && (field === null
      || (typeof field === "number" && Number.isSafeInteger(field) && field >= 0)
      || (typeof field === "string" && field.length <= 128 && /^[A-Za-z0-9._:-]*$/u.test(field)))));
}

/** Run in transactionSync. Purge legacy payload-bearing rows once; retain no body copies.
 * This affects only MCP audit history, never administrator, Runner, policy or Job data.
 */
export function ensureMetadataOnlyAudit(sql: SqlStorage): void {
  const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runmesh_data_migrations'").toArray().length > 0;
  if (exists && sql.exec("SELECT 1 FROM runmesh_data_migrations WHERE id = ?", "mcp-metadata-only-v1").toArray().length > 0) return;
  sql.exec("CREATE TABLE IF NOT EXISTS runmesh_data_migrations (id TEXT PRIMARY KEY)");
  sql.exec("DELETE FROM mcp_calls");
  sql.exec("CREATE INDEX IF NOT EXISTS idx_mcp_calls_expiry ON mcp_calls(completed_at_ms)");
  sql.exec("INSERT INTO runmesh_data_migrations (id) VALUES (?)", "mcp-metadata-only-v1");
}
