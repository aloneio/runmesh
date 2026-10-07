/** Optional metadata remains separate from schema-2 immutable bundles. Older
 * Workers ignore this table; versions predating it retain an unknown time. */
export function initializeSkillVersionMetadata(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_version_metadata_v1'").toArray().length === 0)
    sql.exec("CREATE TABLE skill_version_metadata_v1 (skill_id TEXT NOT NULL, digest TEXT NOT NULL, created_at_ms INTEGER, pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(skill_id,digest))");
}

export function recordSkillVersionCreated(sql: SqlStorage, id: string, digest: string, nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("skill_metadata_invalid");
  sql.exec("INSERT INTO skill_version_metadata_v1 (skill_id,digest,created_at_ms,pinned) VALUES (?,?,?,0)", id, digest, nowMs);
}
