import { z } from "zod";

const integer = z.number().int().nonnegative().safe();
const workspace = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const ContextPruneOptionsSchema = z.object({
  keep_days: z.number().int().min(1).max(3650),
  keep_revisions: z.number().int().min(1).max(1000),
  max_delete: z.number().int().min(1).max(128).optional(),
  apply: z.boolean().optional(),
  expected_plan_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export const ContextStorageReportSchema = z.object({
  workspace_id: workspace, storage_schema: z.literal(1), state: z.enum(["ready", "missing"]),
  record_files: integer.max(8192), record_bytes: integer.max(512 * 1024 * 1024), context_count: integer.max(1024),
  metadata_bytes: integer.max(2 * 1024 * 1024 + 4096), limit_bytes: integer.min(1).max(32 * 1024 * 1024),
  limit_records: integer.min(1).max(4096), limit_contexts: integer.min(1).max(256), over_limit: z.boolean(),
  pending_checkpoint: z.boolean(), accounting: z.literal("logical_revision_bytes"),
});
export const ContextPruneReportSchema = z.object({
  workspace_id: workspace, retention_schema: z.literal(1), applied: z.boolean(), complete: z.literal(true),
  plan_hash: z.string().regex(/^[a-f0-9]{64}$/), keep_days: integer.min(1).max(3650), keep_revisions: integer.min(1).max(1000),
  max_delete: integer.min(1).max(128), candidate_records: integer.max(128), candidate_bytes: integer.max(8 * 1024 * 1024),
  eligible_records: integer.max(4096), preserved_contexts: integer.max(256), has_more: z.boolean(),
  scanned_files: integer.max(4096), scanned_bytes: integer.max(32 * 1024 * 1024),
  deleted_records: integer.max(128), deleted_bytes: integer.max(8 * 1024 * 1024),
});

/** Untrusted peer reports are projected, never used as authorization. */
export function safeContextStorageReport(value: unknown): Record<string, unknown> | undefined {
  const parsed = ContextStorageReportSchema.safeParse(value);
  if (parsed.success) {
    const data = parsed.data;
    if (data.over_limit !== (data.record_files > data.limit_records || data.record_bytes > data.limit_bytes || data.context_count > data.limit_contexts)) return undefined;
    if (data.state === "missing" && (data.record_files !== 0 || data.context_count !== 0 || data.record_bytes !== 0 || data.metadata_bytes !== 0 || data.pending_checkpoint)) return undefined;
    return data;
  }
  const retention = ContextPruneReportSchema.safeParse(value);
  if (!retention.success) return undefined;
  const data = retention.data;
  if (data.candidate_records > data.max_delete || data.candidate_records > data.eligible_records || data.has_more !== (data.candidate_records < data.eligible_records)) return undefined;
  if (data.applied ? data.deleted_records !== data.candidate_records || data.deleted_bytes !== data.candidate_bytes : data.deleted_records !== 0 || data.deleted_bytes !== 0) return undefined;
  return data;
}
