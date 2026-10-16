import type { SkillBundle } from "../../contracts/skills.js";
import { insertSkillContent } from "./content.js";
import { initializeSkillCapacity } from "./capacity.js";

const tables = ["skill_meta", "skill_heads_v1", "skill_bundles_v1", "skill_bundles_v2", "skill_files_v2"];
function createContentTables(sql: SqlStorage): void {
  sql.exec("CREATE TABLE skill_bundles_v2 (skill_id TEXT NOT NULL, digest TEXT NOT NULL, summary_json TEXT NOT NULL, metadata_json TEXT NOT NULL, bytes INTEGER NOT NULL, file_count INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(skill_id,digest))");
  sql.exec("CREATE TABLE skill_files_v2 (skill_id TEXT NOT NULL, digest TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, content_text TEXT NOT NULL, PRIMARY KEY(skill_id,digest,position))");
}

/** Additive table, not a rewrite of existing schema-v2 file rows.
 * Legacy file content stays in skill_files_v2, while only new oversized
 * text receives chunk rows. This makes rolling upgrades non-destructive. */
function ensureSkillChunks(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS skill_file_chunks_v1 (skill_id TEXT NOT NULL, digest TEXT NOT NULL, position INTEGER NOT NULL, ordinal INTEGER NOT NULL, content_text TEXT NOT NULL, PRIMARY KEY(skill_id,digest,position,ordinal))");
}

/** Upgrade installed content once, atomically, without retaining a legacy read path. */
export function initializeSkillSchema(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    const existing = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?,?,?)", ...tables).toArray().map(row => row.name);
    if (existing.length === 0) {
      sql.exec("CREATE TABLE skill_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
      sql.exec("INSERT INTO skill_meta VALUES (1,2)");
      sql.exec("CREATE TABLE skill_heads_v1 (skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, staged_digest TEXT NOT NULL, active_digest TEXT, enabled INTEGER NOT NULL)");
      createContentTables(sql);
      ensureSkillChunks(sql);
      initializeSkillCapacity(sql);
      return;
    }
    if (!existing.includes("skill_meta") || !existing.includes("skill_heads_v1")) throw new Error("skill_schema_unsupported");
    const version = sql.exec<{ schema_version: number }>("SELECT schema_version FROM skill_meta WHERE id=1").toArray()[0]?.schema_version;
    if (version === 2 && existing.length === 4 && existing.includes("skill_bundles_v2") && existing.includes("skill_files_v2")) {
      ensureSkillChunks(sql); initializeSkillCapacity(sql); return;
    }
    if (version !== 1 || existing.length !== 3 || !existing.includes("skill_bundles_v1")) throw new Error("skill_schema_unsupported");
    createContentTables(sql);
    ensureSkillChunks(sql);
    initializeSkillCapacity(sql);
    // Read one body at a time within the atomic upgrade. Exhaust each cursor
    // before writing so a failed upgrade leaves no read lock for its retry.
    type LegacyRow = { migration_rowid: number; skill_id: string; digest: string; content_json: string; bytes: number; approved: number };
    let after: number | undefined;
    for (;;) {
      const row: LegacyRow | undefined = (after === undefined
        ? sql.exec<LegacyRow>("SELECT rowid AS migration_rowid,skill_id,digest,content_json,bytes,approved FROM skill_bundles_v1 ORDER BY rowid LIMIT 1")
        : sql.exec<LegacyRow>("SELECT rowid AS migration_rowid,skill_id,digest,content_json,bytes,approved FROM skill_bundles_v1 WHERE rowid>? ORDER BY rowid LIMIT 1", after)).toArray()[0];
      if (row === undefined) break;
      const bundle = JSON.parse(row.content_json) as SkillBundle;
      if (bundle.skill_id !== row.skill_id || bundle.digest !== row.digest || ![0, 1].includes(row.approved)
        || new TextEncoder().encode(row.content_json).byteLength !== row.bytes) throw new Error("skill_record_invalid");
      insertSkillContent(sql, bundle, row.bytes, row.approved === 1);
      after = row.migration_rowid;
    }
    sql.exec("DROP TABLE skill_bundles_v1");
    sql.exec("UPDATE skill_meta SET schema_version=2 WHERE id=1");
  });
}
