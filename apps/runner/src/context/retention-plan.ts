import { createHash } from "node:crypto";
import type { ContextStorageFile } from "./storage-types.js";

export interface RetentionCandidate { readonly file: ContextStorageFile; readonly hash: string; readonly latest: ContextStorageFile }
export interface RetentionPlanInput {
  readonly workspaceId: string; readonly generation: number | null;
  readonly keepDays: number; readonly keepRevisions: number; readonly maxDelete: number;
  readonly inventoryDigest: string; readonly candidates: readonly RetentionCandidate[];
  readonly preservedContexts: number; readonly scannedFiles: number; readonly scannedBytes: number;
}
/** Pure planning over validated observations. No clock, files or authorization.
 * The executor revalidates paths, content, latest revision and current policy.
 * A returned plan is descriptive data, not a deletion or permission token.
 */
export function planContextRetention(input: RetentionPlanInput) {
  const { workspaceId, generation, keepDays, keepRevisions, maxDelete, inventoryDigest, preservedContexts, scannedFiles, scannedBytes } = input;
  const candidates = [...input.candidates];
  candidates.sort((a, b) => a.file.contextId < b.file.contextId ? -1 : a.file.contextId > b.file.contextId ? 1 : a.file.revision - b.file.revision);
  const selected = candidates.slice(0, maxDelete);
  const hash = createHash("sha256").update(JSON.stringify({ schema: 1, workspaceId, generation, keepDays, keepRevisions, maxDelete, inventory: inventoryDigest, selected: selected.map(item => [item.file.contextId, item.file.revision, item.hash]) })).digest("hex");
  const summary = { workspace_id: workspaceId, retention_schema: 1, applied: false, complete: true, plan_hash: hash,
    keep_days: keepDays, keep_revisions: keepRevisions, max_delete: maxDelete,
    candidate_records: selected.length, candidate_bytes: selected.reduce((sum, item) => sum + item.file.stamp.size, 0),
    eligible_records: candidates.length, preserved_contexts: preservedContexts, has_more: selected.length < candidates.length,
    scanned_files: scannedFiles, scanned_bytes: scannedBytes, deleted_records: 0, deleted_bytes: 0 };

  return { selected, summary };
}
