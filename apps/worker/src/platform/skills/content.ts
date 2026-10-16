import { SKILL_LIMITS, SKILL_STORED_BUNDLE_BYTES, type SkillBundle } from "../../contracts/skills.js";
import { changeSkillCapacity } from "./capacity.js";
import { SKILL_SQL_CHUNK_BYTES, SKILL_SQL_INLINE_BYTES, splitSkillText } from "./text-chunks.js";

/** SQLite imposes a 2 MB maximum row size. Oversized logical files
 * retain the existing manifest position and use an additive chunk table;
 * ordinary legacy rows remain unchanged. */
const textBytes = (value: string) => new TextEncoder().encode(value).byteLength;
const maximumParts = () => Math.ceil(SKILL_LIMITS.file_bytes / (SKILL_SQL_CHUNK_BYTES - 3));

export function insertSkillContent(sql: SqlStorage, bundle: SkillBundle, bytes: number, approved: boolean): void {
  const { files, schema_version: _schema, ...summary } = bundle;
  sql.exec("INSERT INTO skill_bundles_v2 VALUES (?,?,?,?,?,?,?)", bundle.skill_id, bundle.digest,
    JSON.stringify(summary), JSON.stringify({ ...bundle, files: [] }), bytes, files.length, approved ? 1 : 0);
  files.forEach((file, position) => {
    const chunks = splitSkillText(file.text);
    sql.exec("INSERT INTO skill_files_v2 VALUES (?,?,?,?,?)", bundle.skill_id, bundle.digest, position, file.path,
      chunks.length === 1 ? file.text : "");
    if (chunks.length > 1) {
      for (const [ordinal, content] of chunks.entries())
        sql.exec("INSERT INTO skill_file_chunks_v1 VALUES (?,?,?,?,?)", bundle.skill_id, bundle.digest, position, ordinal, content);
    }
  });
  changeSkillCapacity(sql, bundle.skill_id, bytes, 1);
}

/** Removal and its capacity projection share the lifecycle transaction. */
export function deleteSkillContent(sql: SqlStorage, id: string, digest: string): void {
  const row = sql.exec<{ bytes: number }>("DELETE FROM skill_bundles_v2 WHERE skill_id=? AND digest=? RETURNING bytes", id, digest).toArray()[0];
  if (!row) throw new Error("skill_record_invalid");
  sql.exec("DELETE FROM skill_file_chunks_v1 WHERE skill_id=? AND digest=?", id, digest);
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
  // An empty legacy file is valid. Chunk rows distinguish larger files
  // from normal empty rows without changing the original table structure.
  const chunked = new Map<number, { text: string[]; bytes: number }>();
  if (rows.some(file => file.content_text === "")) {
    const maxRows = row.file_count * maximumParts();
    const parts = sql.exec<{ position: number; ordinal: number; content_text: string }>(
      "SELECT position,ordinal,content_text FROM skill_file_chunks_v1 WHERE skill_id=? AND digest=? ORDER BY position,ordinal LIMIT ?",
      id, digest, maxRows + 1).toArray();
    if (parts.length > maxRows) throw new Error("skill_record_invalid");
    for (const part of parts) {
      const parent = rows[part.position];
      const current = chunked.get(part.position) ?? { text: [], bytes: 0 };
      const size = typeof part.content_text === "string" ? textBytes(part.content_text) : 0;
      if (!Number.isSafeInteger(part.position) || !parent || parent.content_text !== ""
        || !Number.isSafeInteger(part.ordinal) || part.ordinal !== current.text.length
        || !size || size > SKILL_SQL_CHUNK_BYTES || current.bytes + size > SKILL_LIMITS.file_bytes
        || current.text.length >= maximumParts()) throw new Error("skill_record_invalid");
      current.text.push(part.content_text); current.bytes += size;
      chunked.set(part.position, current);
    }
  }
  const files = rows.map((file, index) => {
    const current = chunked.get(index);
    if (!current) return { path: file.path, text: file.content_text };
    if (current.bytes <= SKILL_SQL_INLINE_BYTES) throw new Error("skill_record_invalid");
    const text = current.text.join("");
    if (textBytes(text) !== current.bytes) throw new Error("skill_record_invalid");
    return { path: file.path, text };
  });
  const bundle = { ...metadata, files };
  if (bundle.skill_id !== id || bundle.digest !== digest || new TextEncoder().encode(JSON.stringify(bundle)).byteLength !== row.bytes) throw new Error("skill_record_invalid");
  return bundle;
}
