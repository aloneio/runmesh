import { SKILL_LIMITS } from "../../contracts/skills.js";
import type { SkillCapacity } from "../../contracts/skill-lifecycle.js";

/** Called inside the content schema transaction. Installed schema-2 stores are
 * projected once; all later content changes use the same transaction as these totals. */
export function initializeSkillCapacity(sql: SqlStorage): void {
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('skill_capacity_v1','skill_library_capacity_v1')").toArray();
  if (tables.length === 2) return;
  if (tables.length !== 0) throw new Error("skill_capacity_schema_unsupported");
  sql.exec("CREATE TABLE skill_capacity_v1 (skill_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, versions INTEGER NOT NULL)");
  sql.exec("CREATE TABLE skill_library_capacity_v1 (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, skills INTEGER NOT NULL)");
  sql.exec("INSERT INTO skill_capacity_v1 SELECT skill_id,SUM(bytes),COUNT(*) FROM skill_bundles_v2 GROUP BY skill_id");
  sql.exec("INSERT INTO skill_library_capacity_v1 SELECT 1,COALESCE(SUM(bytes),0),COUNT(*) FROM skill_capacity_v1");
}

/** Constant-size metadata reads shared by installation and version maintenance. */
export function readSkillCapacity(sql: SqlStorage, id: string): SkillCapacity {
  const row = sql.exec<{ skill_bytes: number; skill_versions: number; library_bytes: number; library_skills: number }>(
    "SELECT COALESCE(s.bytes,0) AS skill_bytes,COALESCE(s.versions,0) AS skill_versions,l.bytes AS library_bytes,l.skills AS library_skills FROM skill_library_capacity_v1 l LEFT JOIN skill_capacity_v1 s ON s.skill_id=? WHERE l.id=1", id).toArray()[0];
  if (!row || Object.values(row).some(value => !Number.isSafeInteger(value) || value < 0)
    || (row.skill_versions === 0) !== (row.skill_bytes === 0) || (row.library_skills === 0) !== (row.library_bytes === 0)
    || row.skill_bytes > row.library_bytes || (row.skill_versions > 0 && row.library_skills === 0)) throw new Error("skill_capacity_record_invalid");
  return { ...row, max_versions: SKILL_LIMITS.versions, max_library_bytes: SKILL_LIMITS.storage_bytes, max_skills: SKILL_LIMITS.skills };
}

/** Immutable content insertion/deletion owns this projection; callers retain
 * their surrounding transaction so a file or head failure rolls back both. */
export function changeSkillCapacity(sql: SqlStorage, id: string, bytes: number, direction: 1 | -1): void {
  const current = readSkillCapacity(sql, id), versions = current.skill_versions + direction;
  const skillBytes = current.skill_bytes + bytes * direction, libraryBytes = current.library_bytes + bytes * direction;
  const skills = current.library_skills + (current.skill_versions === 0 ? 1 : versions === 0 ? -1 : 0);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || [versions, skillBytes, libraryBytes, skills].some(value => !Number.isSafeInteger(value) || value < 0)
    || (versions === 0 && skillBytes !== 0)) throw new Error("skill_capacity_record_invalid");
  if (versions === 0) sql.exec("DELETE FROM skill_capacity_v1 WHERE skill_id=?", id);
  else sql.exec("INSERT INTO skill_capacity_v1 VALUES (?,?,?) ON CONFLICT(skill_id) DO UPDATE SET bytes=excluded.bytes,versions=excluded.versions", id, skillBytes, versions);
  sql.exec("UPDATE skill_library_capacity_v1 SET bytes=?,skills=? WHERE id=1", libraryBytes, skills);
}
