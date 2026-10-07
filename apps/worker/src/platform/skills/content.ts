import { SKILL_LIMITS, SKILL_STORED_BUNDLE_BYTES, type SkillBundle } from "../../contracts/skills.js";
import { changeSkillCapacity } from "./capacity.js";

/** Keep each row below SQLite's 2 MB row limit, including JSON escaping.
 * File text is stored directly; only the small metadata row uses JSON. */
export function insertSkillContent(sql: SqlStorage, bundle: SkillBundle, bytes: number, approved: boolean): void {
  const { files, schema_version: _schema, ...summary } = bundle;
  sql.exec("INSERT INTO skill_bundles_v2 VALUES (?,?,?,?,?,?,?)", bundle.skill_id, bundle.digest,
    JSON.stringify(summary), JSON.stringify({ ...bundle, files: [] }), bytes, files.length, approved ? 1 : 0);
  files.forEach((file, position) => {
    sql.exec("INSERT INTO skill_files_v2 VALUES (?,?,?,?,?)", bundle.skill_id, bundle.digest, position, file.path, file.text);
  });
  changeSkillCapacity(sql, bundle.skill_id, bytes, 1);
}

/** Removal and its capacity projection share the lifecycle transaction. */
export function deleteSkillContent(sql: SqlStorage, id: string, digest: string): void {
  const row = sql.exec<{ bytes: number }>("DELETE FROM skill_bundles_v2 WHERE skill_id=? AND digest=? RETURNING bytes", id, digest).toArray()[0];
  if (!row) throw new Error("skill_record_invalid");
  sql.exec("DELETE FROM skill_files_v2 WHERE skill_id=? AND digest=?", id, digest);
  changeSkillCapacity(sql, id, row.bytes, -1);
}

export function readSkillContent(sql: SqlStorage, id: string, digest: string): SkillBundle | undefined {
  const row = sql.exec<{ metadata_json: string; bytes: number; file_count: number }>("SELECT metadata_json,bytes,file_count FROM skill_bundles_v2 WHERE skill_id=? AND digest=?", id, digest).toArray()[0];
  if (!row) return undefined;
  if (new TextEncoder().encode(row.metadata_json).byteLength > SKILL_STORED_BUNDLE_BYTES || !Number.isSafeInteger(row.file_count) || row.file_count < 1 || row.file_count > SKILL_LIMITS.files
    || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > SKILL_STORED_BUNDLE_BYTES) throw new Error("skill_record_invalid");
  const metadata = JSON.parse(row.metadata_json) as SkillBundle;
  const rows = sql.exec<{ position: number; path: string; content_text: string }>("SELECT position,path,content_text FROM skill_files_v2 WHERE skill_id=? AND digest=? ORDER BY position LIMIT ?", id, digest, row.file_count + 1).toArray();
  if (rows.length !== row.file_count || rows.some((file, position) => file.position !== position
    || new TextEncoder().encode(file.content_text).byteLength > SKILL_LIMITS.file_bytes)) throw new Error("skill_record_invalid");
  const bundle = { ...metadata, files: rows.map(file => ({ path: file.path, text: file.content_text })) };
  if (bundle.skill_id !== id || bundle.digest !== digest || new TextEncoder().encode(JSON.stringify(bundle)).byteLength !== row.bytes) throw new Error("skill_record_invalid");
  return bundle;
}
