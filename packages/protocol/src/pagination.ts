import { z } from "zod";

/** Additive byte-page evidence. Legacy numeric cursors are not snapshots.
 * returned_bytes counts UTF-8 data bytes, not the surrounding JSON envelope.
 * total_bytes is the size observed for this read, not a running Job's future
 * output. A null next_cursor can also mean an incomplete final code point.
 */
const integer = z.number().int().nonnegative().safe();
export const BytePageMetadataSchema = z.object({
  page_protocol: z.literal(1),
  page_state: z.enum(["more", "end", "incomplete"]),
  returned_bytes: integer,
  total_bytes: integer,
  resume_offset: integer,
  pending_bytes: z.number().int().min(0).max(3),
  truncated_reason: z.enum(["page_limit", "response_bytes", "incomplete_utf8"]).nullable(),
  snapshot_id: z.null(),
}).strict();

export function bytePageMetadata(data: string, offset: number, next: number, size: number, responseLimited = false) {
  if (![offset, next, size].every(Number.isSafeInteger) || offset < 0 || next < offset || next > size) throw new Error("Invalid byte page bounds");
  const incomplete = next === offset && next < size;
  const more = next > offset && next < size;
  return {
    page_protocol: 1 as const,
    page_state: incomplete ? "incomplete" as const : more ? "more" as const : "end" as const,
    returned_bytes: new TextEncoder().encode(data).byteLength,
    total_bytes: size,
    resume_offset: next,
    pending_bytes: incomplete ? Math.min(3, size - next) : 0,
    truncated_reason: incomplete ? "incomplete_utf8" as const : more ? responseLimited ? "response_bytes" as const : "page_limit" as const : null,
    snapshot_id: null,
    next_cursor: more ? String(next) : null,
    truncated: more || incomplete,
  };
}
