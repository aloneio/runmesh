/** Optional history must not spend O(retained history) reads per event.
 * Counters and history changes share the caller's SQLite transaction. The
 * migration is additive and never touches credentials, policy or live jobs.
 */
const MIGRATION = "bounded-history-retention-v1";
const TERMINAL = "'cancelled','succeeded','failed','interrupted'";

export function ensureHistoryRetentionSchema(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM runmesh_data_migrations WHERE id = ?", MIGRATION).toArray().length > 0) return;
  sql.exec(`
    ALTER TABLE mcp_clients ADD COLUMN record_jobs INTEGER NOT NULL DEFAULT 1 CHECK(record_jobs IN (0,1));
    ALTER TABLE mcp_clients ADD COLUMN record_jobs_since_ms INTEGER NOT NULL DEFAULT 0 CHECK(record_jobs_since_ms >= 0);
    CREATE TABLE history_retention_counts (
      kind TEXT NOT NULL, runner_id TEXT NOT NULL, total INTEGER NOT NULL CHECK(total >= 0),
      PRIMARY KEY(kind, runner_id)
    );
    INSERT INTO history_retention_counts SELECT 'audit', runner_id, COUNT(*) FROM mcp_calls GROUP BY runner_id;
    INSERT INTO history_retention_counts SELECT 'terminal_job', runner_id, COUNT(*) FROM jobs
      WHERE json_extract(job_json, '$.status') IN (${TERMINAL}) GROUP BY runner_id;
    CREATE INDEX idx_jobs_terminal_retention ON jobs(runner_id, updated_at_ms, job_id)
      WHERE json_extract(job_json, '$.status') IN (${TERMINAL});
    CREATE INDEX idx_jobs_recent ON jobs(runner_id, updated_at_ms DESC, job_id ASC);
    CREATE INDEX idx_jobs_recent_global ON jobs(updated_at_ms DESC, job_id ASC);
    CREATE TRIGGER history_audit_insert AFTER INSERT ON mcp_calls BEGIN
      INSERT INTO history_retention_counts VALUES ('audit', NEW.runner_id, 1)
      ON CONFLICT(kind, runner_id) DO UPDATE SET total = total + 1;
    END;
    CREATE TRIGGER history_audit_delete AFTER DELETE ON mcp_calls BEGIN
      UPDATE history_retention_counts SET total = total - 1 WHERE kind = 'audit' AND runner_id = OLD.runner_id;
    END;
    CREATE TRIGGER history_job_insert AFTER INSERT ON jobs
      WHEN json_extract(NEW.job_json, '$.status') IN (${TERMINAL}) BEGIN
      INSERT INTO history_retention_counts VALUES ('terminal_job', NEW.runner_id, 1)
      ON CONFLICT(kind, runner_id) DO UPDATE SET total = total + 1;
    END;
    CREATE TRIGGER history_job_delete AFTER DELETE ON jobs
      WHEN json_extract(OLD.job_json, '$.status') IN (${TERMINAL}) BEGIN
      UPDATE history_retention_counts SET total = total - 1 WHERE kind = 'terminal_job' AND runner_id = OLD.runner_id;
    END;
    CREATE TRIGGER history_job_terminal AFTER UPDATE OF job_json ON jobs
      WHEN json_extract(NEW.job_json, '$.status') IN (${TERMINAL})
      AND COALESCE(json_extract(OLD.job_json, '$.status'), '') NOT IN (${TERMINAL}) BEGIN
      INSERT INTO history_retention_counts VALUES ('terminal_job', NEW.runner_id, 1)
      ON CONFLICT(kind, runner_id) DO UPDATE SET total = total + 1;
    END;
    CREATE TRIGGER history_job_active AFTER UPDATE OF job_json ON jobs
      WHEN json_extract(OLD.job_json, '$.status') IN (${TERMINAL})
      AND COALESCE(json_extract(NEW.job_json, '$.status'), '') NOT IN (${TERMINAL}) BEGIN
      UPDATE history_retention_counts SET total = total - 1 WHERE kind = 'terminal_job' AND runner_id = OLD.runner_id;
    END;
  `);
  sql.exec("INSERT INTO runmesh_data_migrations (id) VALUES (?)", MIGRATION);
}

/** The ordinary path reads one counter, not the first 1,000 history rows. */
export function pruneHistory(sql: SqlStorage, kind: "audit" | "terminal_job", runnerId: string, limit: number): void {
  const row = sql.exec<{ total: number }>("SELECT total FROM history_retention_counts WHERE kind = ? AND runner_id = ?", kind, runnerId).toArray()[0];
  const excess = (row?.total ?? 0) - limit;
  if (excess <= 0) return;
  if (kind === "audit") {
    sql.exec(`DELETE FROM mcp_calls WHERE runner_id = ? AND call_id IN (
      SELECT call_id FROM mcp_calls WHERE runner_id = ? ORDER BY completed_at_ms ASC, call_id ASC LIMIT ?
    )`, runnerId, runnerId, excess);
  } else {
    sql.exec(`DELETE FROM jobs WHERE runner_id = ? AND job_id IN (
      SELECT job_id FROM jobs WHERE runner_id = ? AND json_extract(job_json, '$.status') IN (${TERMINAL})
      ORDER BY updated_at_ms ASC, job_id ASC LIMIT ?
    )`, runnerId, runnerId, excess);
  }
}
