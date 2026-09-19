import { expect, it } from "vitest";
import { ContextPruneOptionsSchema, safeContextStorageReport } from "../src/context-storage.js";
import { rpcOperation } from "../src/operations.js";
import { failureMetadata } from "../src/failure.js";

const usage = { workspace_id: "w", storage_schema: 1, state: "ready", record_files: 5, record_bytes: 10000, context_count: 1, metadata_bytes: 800,
  limit_bytes: 33554432, limit_records: 4096, limit_contexts: 256, over_limit: false, pending_checkpoint: false, accounting: "logical_revision_bytes" };
it("R08 storage reports whitelist fields and verify the quota relation", () => {
  expect(safeContextStorageReport({ ...usage, token: "secret", directory: "/private" })).toEqual(usage);
  for (const extra of [{ record_files: Infinity }, { record_bytes: -1 }, { storage_schema: 2 }, { over_limit: true }, { state: "missing" }]) expect(safeContextStorageReport({ ...usage, ...extra })).toBeUndefined();
});
it("R08 previews and apply receipts cannot contradict deletion counts", () => {
  const preview = { workspace_id: "w", retention_schema: 1, applied: false, complete: true, plan_hash: "a".repeat(64), keep_days: 30, keep_revisions: 2, max_delete: 128,
    candidate_records: 2, candidate_bytes: 100, eligible_records: 2, preserved_contexts: 1, has_more: false, scanned_files: 4, scanned_bytes: 200, deleted_records: 0, deleted_bytes: 0 };
  expect(safeContextStorageReport(preview)).toEqual(preview);
  expect(safeContextStorageReport({ ...preview, applied: true })).toBeUndefined();
  expect(safeContextStorageReport({ ...preview, applied: true, deleted_records: 2, deleted_bytes: 100 })).toBeDefined();
  expect(safeContextStorageReport({ ...preview, has_more: true })).toBeUndefined();
});
it("R08 retention parameters have independent finite bounds", () => {
  expect(ContextPruneOptionsSchema.safeParse({ keep_days: 30, keep_revisions: 2 }).success).toBe(true);
  for (const extra of [{ keep_days: 0 }, { keep_revisions: 0 }, { keep_days: Infinity }, { max_delete: 129 }, { expected_plan_hash: "not-a-hash" }, { apply: "yes" }]) expect(ContextPruneOptionsSchema.safeParse({ keep_days: 30, keep_revisions: 2, ...extra }).success).toBe(false);
});
it("R08 retention permissions and partial outcomes differ from read-only inventory", () => {
  expect(rpcOperation("context.storage")).toMatchObject({ scope: "coding:read", permission: "read", revalidate_after_read: true });
  expect(rpcOperation("context.prune")).toMatchObject({ scope: "coding:write", permission: "edit", revalidate_after_read: false });
  expect(failureMetadata("context_storage_full")).toMatchObject({ failure_class: "resource", operation_state: "not_started" });
  expect(failureMetadata("context_plan_changed")).toMatchObject({ failure_class: "conflict", operation_state: "not_started" });
  expect(failureMetadata("context_prune_partial")).toMatchObject({ failure_class: "conflict", operation_state: "unknown", next_action: "contact_operator" });
});
