const indexRepairAfter = new WeakMap<D1Database, number>();

/** Additive D1 migrations. Current stores perform metadata reads, never no-op
 * DDL. Recheck after a failed ALTER because another isolate may have won. */
export async function ensureJobHistorySchema(db: D1Database): Promise<void> {
  const exists = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runmesh_job_snapshots_v1'").first();
  if (exists === null) await db.prepare("CREATE TABLE IF NOT EXISTS runmesh_job_snapshots_v1 (snapshot_id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, runner_id TEXT NOT NULL, lifecycle_id TEXT NOT NULL, jobs_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL, retention_days INTEGER NOT NULL, retired_at_ms INTEGER, corrupt_revision INTEGER, corrupt_detected_at_ms INTEGER, corrupt_reason TEXT, UNIQUE(namespace,runner_id,lifecycle_id))").run();
  const columns = async () => new Set((await db.prepare("PRAGMA table_info(runmesh_job_snapshots_v1)").all<{ name: string }>()).results.map(column => column.name));
  const present = await columns();
  for (const [column, type] of [["retired_at_ms", "INTEGER"], ["corrupt_revision", "INTEGER"], ["corrupt_detected_at_ms", "INTEGER"], ["corrupt_reason", "TEXT"]] as const) {
    if (present.has(column)) continue;
    try { await db.prepare(`ALTER TABLE runmesh_job_snapshots_v1 ADD COLUMN ${column} ${type}`).run(); }
    catch (error) { if (!(await columns()).has(column)) throw error; }
  }
  // Older Workers use INSERT ... VALUES (?,?) against v1. Never add a
  // column there: keep rollback compatible and start a bounded v2 sweep at 0.
  const cursor = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runmesh_job_cleanup_v2'").first();
  if (cursor === null) await db.prepare("CREATE TABLE IF NOT EXISTS runmesh_job_cleanup_v2 (namespace TEXT PRIMARY KEY, cursor INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0)").run();
  // This index is optional for correctness. A failed repair must not disable
  // otherwise healthy history reads; retry only on store reconstruction.
  const index = await db.prepare("SELECT (tbl_name='runmesh_job_snapshots_v1') AS correct_table FROM sqlite_master WHERE type='index' AND name='runmesh_job_scan_v1'").first<{ correct_table: number }>();
  if (index === null && Date.now() >= (indexRepairAfter.get(db) ?? 0)) {
    try { await db.prepare("CREATE INDEX IF NOT EXISTS runmesh_job_scan_v1 ON runmesh_job_snapshots_v1(namespace,snapshot_id)").run(); }
    catch { indexRepairAfter.set(db, Date.now() + 900_000); console.warn("job_history_scan_index_repair_deferred"); }
  } else if (index !== null) {
    const fields = (await db.prepare("PRAGMA index_info(runmesh_job_scan_v1)").all<{ name: string }>()).results.map(column => column.name);
    if (index.correct_table !== 1 || fields.join(",") !== "namespace,snapshot_id") console.warn("job_history_scan_index_mismatch");
  }
}
