import { MCP_AUDIT_RETENTION_MS, projectMcpAuditMetadata } from "./audit-metadata.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runmesh_audit_v1 (namespace TEXT NOT NULL, runner_id TEXT NOT NULL, lifecycle_id TEXT NOT NULL, call_id TEXT NOT NULL, completed_at_ms INTEGER NOT NULL, call_json TEXT NOT NULL, PRIMARY KEY(namespace, runner_id, lifecycle_id, call_id))`,
  `CREATE INDEX IF NOT EXISTS runmesh_audit_recent_v1 ON runmesh_audit_v1(namespace, runner_id, lifecycle_id, completed_at_ms DESC, call_id DESC)`,
  `CREATE INDEX IF NOT EXISTS runmesh_audit_expiry_v1 ON runmesh_audit_v1(namespace, completed_at_ms)`,
  `CREATE TABLE IF NOT EXISTS runmesh_audit_counts_v1 (namespace TEXT NOT NULL, runner_id TEXT NOT NULL, lifecycle_id TEXT NOT NULL, total INTEGER NOT NULL CHECK(total >= 0), PRIMARY KEY(namespace, runner_id, lifecycle_id))`,
  `CREATE TRIGGER IF NOT EXISTS runmesh_audit_insert_v1 AFTER INSERT ON runmesh_audit_v1 BEGIN
    INSERT INTO runmesh_audit_counts_v1 VALUES (NEW.namespace, NEW.runner_id, NEW.lifecycle_id, 1)
    ON CONFLICT(namespace, runner_id, lifecycle_id) DO UPDATE SET total = total + 1; END`,
  `CREATE TRIGGER IF NOT EXISTS runmesh_audit_delete_v1 AFTER DELETE ON runmesh_audit_v1 BEGIN
    UPDATE runmesh_audit_counts_v1 SET total = total - 1 WHERE namespace = OLD.namespace AND runner_id = OLD.runner_id AND lifecycle_id = OLD.lifecycle_id;
    DELETE FROM runmesh_audit_counts_v1 WHERE namespace = OLD.namespace AND runner_id = OLD.runner_id AND lifecycle_id = OLD.lifecycle_id AND total = 0; END`,
];

export class AuditHistoryUnavailableError extends Error {
  public constructor() { super("Cloud audit history is temporarily unavailable; execution is independent."); this.name = "AuditHistoryUnavailableError"; }
}

/** Optional metadata-only sink. It never stores credentials, controls dispatch,
 * or falls back to writing the core Registry when its own quota is exhausted.
 * Namespace and Runner lifecycle prevent delayed writes from crossing a
 * deleted/recreated Runner identity. Read authorization stays in Registry.
 */
export class ExternalAuditHistory {
  private ready: Promise<void> | undefined;
  private disabledUntilMs = 0;
  private failures = 0;
  public constructor(private readonly database: D1Database, private readonly namespace: string) {}

  public health(now = Date.now()): { disabled_until_ms: number; failure_count: number } | undefined {
    return this.disabledUntilMs > now ? { disabled_until_ms: this.disabledUntilMs, failure_count: this.failures } : undefined;
  }

  private fail(error: unknown, now = Date.now()): void {
    const message = error instanceof Error ? error.message : "";
    const dailyQuota = /(?:rows[_ ]?(?:read|written)|daily)/i.test(message) && /(?:exceed|quota|limit)/i.test(message);
    const until = dailyQuota ? (Math.floor(now / 86_400_000) + 1) * 86_400_000 + 30_000 : now + 15 * 60_000;
    this.disabledUntilMs = Math.max(this.disabledUntilMs, until);
    this.failures += 1;
    this.ready = undefined;
    // No SQL or log write here: a failed history store cannot consume core
    // storage just to remember its own failure. Cold starts may probe once.
  }

  private async initialize(): Promise<void> {
    if (this.health() !== undefined) throw new AuditHistoryUnavailableError();
    this.ready ??= (async () => {
      const exists = await this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runmesh_audit_v1'").first();
      if (exists === null) await this.database.batch(SCHEMA.map((sql) => this.database.prepare(sql)));
    })();
    await this.ready;
  }

  public async append(input: Record<string, unknown>): Promise<boolean> {
    if (this.health() !== undefined) return false;
    const metadata = projectMcpAuditMetadata(input);
    const runnerId = metadata.runner_id, lifecycleId = metadata.lifecycle_id, callId = metadata.call_id, completed = metadata.completed_at_ms;
    if (typeof runnerId !== "string" || typeof lifecycleId !== "string" || typeof callId !== "string" || typeof completed !== "number") return false;
    const body = JSON.stringify(metadata);
    if (new TextEncoder().encode(body).byteLength > 8192) return false;
    try {
      await this.initialize();
      await this.database.batch([
        this.database.prepare(`INSERT INTO runmesh_audit_v1 VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(namespace, runner_id, lifecycle_id, call_id) DO UPDATE SET completed_at_ms = excluded.completed_at_ms, call_json = excluded.call_json`).bind(this.namespace, runnerId, lifecycleId, callId, completed, body),
        this.database.prepare(`DELETE FROM runmesh_audit_v1 WHERE namespace = ? AND runner_id = ? AND lifecycle_id = ? AND call_id IN (
          SELECT call_id FROM runmesh_audit_v1 WHERE namespace = ? AND runner_id = ? AND lifecycle_id = ?
          ORDER BY completed_at_ms, call_id LIMIT MAX(COALESCE((SELECT total FROM runmesh_audit_counts_v1 WHERE namespace = ? AND runner_id = ? AND lifecycle_id = ?), 0) - 1000, 0))`).bind(this.namespace, runnerId, lifecycleId, this.namespace, runnerId, lifecycleId, this.namespace, runnerId, lifecycleId),
        this.expiryStatement(Date.now()),
      ]);
      return true;
    } catch (error) { this.fail(error); return false; }
  }

  private expiryStatement(now: number): D1PreparedStatement {
    return this.database.prepare(`DELETE FROM runmesh_audit_v1 WHERE rowid IN (
      SELECT rowid FROM runmesh_audit_v1 WHERE namespace = ? AND completed_at_ms <= ? ORDER BY completed_at_ms LIMIT 100
    )`).bind(this.namespace, now - MCP_AUDIT_RETENTION_MS);
  }

  public async list(runnerId: string, lifecycleId: string, limit = 100): Promise<Record<string, unknown>[]> {
    if (this.health() !== undefined) throw new AuditHistoryUnavailableError();
    try {
      await this.initialize();
      const result = await this.database.prepare(`SELECT call_json FROM runmesh_audit_v1
        WHERE namespace = ? AND runner_id = ? AND lifecycle_id = ? AND completed_at_ms > ?
        ORDER BY completed_at_ms DESC, call_id DESC LIMIT ?`).bind(this.namespace, runnerId, lifecycleId, Date.now() - MCP_AUDIT_RETENTION_MS, Math.min(100, Math.max(1, limit))).all<{ call_json: string }>();
      return result.results.map((row) => projectMcpAuditMetadata(JSON.parse(row.call_json)));
    } catch (error) { this.fail(error); throw new AuditHistoryUnavailableError(); }
  }

  /** Bounded physical cleanup; callers schedule this independently of auth. */
  public async cleanup(): Promise<void> {
    if (this.health() !== undefined) return;
    try { await this.initialize(); await this.expiryStatement(Date.now()).run(); }
    catch (error) { this.fail(error); }
  }
}
