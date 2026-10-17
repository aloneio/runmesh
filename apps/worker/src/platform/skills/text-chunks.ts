/** Durable Object SQLite enforces a 2 MB maximum text/row size.
 * Keep ordinary <=1 MiB rows unchanged; split larger UTF-8 text into
 * 512 KiB units without ever cutting a multi-byte code point. */
export const SKILL_SQL_INLINE_BYTES = 1_048_576;
export const SKILL_SQL_CHUNK_BYTES = 524_288;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function splitSkillText(value: string): string[] {
  const bytes = encoder.encode(value), result: string[] = [];
  if (bytes.byteLength <= SKILL_SQL_INLINE_BYTES) return [value];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + SKILL_SQL_CHUNK_BYTES);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end <= start) throw new Error("skill_chunk_invalid");
    result.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  if (result.join("") !== value) throw new Error("skill_chunk_invalid");
  return result;
}
