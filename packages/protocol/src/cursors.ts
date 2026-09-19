import { z } from "zod";
import { BytePageMetadataSchema } from "./pagination.js";

/** Opaque process-local references, not credentials or authorization grants. */
export const BOUND_FILE_CURSOR_PATTERN = /^f1:[a-f0-9]{64}:(?:0|[1-9][0-9]{0,15})$/;
export const BOUND_LOG_CURSOR_PATTERN = /^l1:[a-f0-9]{64}:(?:0|[1-9][0-9]{0,15})$/;
export function isBoundCursor(value: unknown, kind?: "file" | "log"): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const pattern = kind === "file" ? BOUND_FILE_CURSOR_PATTERN : kind === "log" ? BOUND_LOG_CURSOR_PATTERN : /^(?:f1|l1):[a-f0-9]{64}:(?:0|[1-9][0-9]{0,15})$/;
  return pattern.test(value) && Number.isSafeInteger(Number(value.slice(value.lastIndexOf(":") + 1)));
}
export const BoundFileCursorSchema = z.string().max(128).regex(BOUND_FILE_CURSOR_PATTERN).refine(value => isBoundCursor(value, "file"));
export const BoundLogCursorSchema = z.string().max(128).regex(BOUND_LOG_CURSOR_PATTERN).refine(value => isBoundCursor(value, "log"));
export const BoundBytePageMetadataSchema = BytePageMetadataSchema.extend({
  page_protocol: z.literal(2),
  consistency: z.enum(["snapshot", "append"]),
  snapshot_id: z.string().regex(/^[a-f0-9]{64}$/),
  resume_cursor: z.union([BoundFileCursorSchema, BoundLogCursorSchema]),
  cursor_expires_at_ms: z.number().int().nonnegative().safe(),
}).strict();
