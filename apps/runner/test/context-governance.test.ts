import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ContextStore } from "../src/context-store.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
async function fixture(limits: Record<string, number> = {}) {
  const root = await mkdtemp(join(tmpdir(), "context-governance-")); roots.push(root);
  const stateDir = join(root, "state");
  const store = new ContextStore({ stateDir, storageLimits: limits } as any) as any;
  return { root, stateDir, store, dir: join(stateDir, "contexts", "w") };
}
async function revisions(f: Awaited<ReturnType<typeof fixture>>, count = 4) {
  const clock = vi.spyOn(Date, "now");
  let id: string | undefined;
  for (let i = 1; i <= count; i++) {
    clock.mockReturnValue(1700000000000 + i * 86400000);
    const result = await f.store.checkpoint({ workspace_id: "w", turn_id: "t", goal: `revision-${i}`, ...(id ? { context_id: id, expected_revision: i - 1 } : {}) });
    id = result.context.context_id;
  }
  clock.mockReturnValue(1700000000000 + 100 * 86400000);
  return id!;
}
const prune = { workspace_id: "w", keep_days: 30, keep_revisions: 2 };

it("R08 storage and prune preview of a missing workspace perform no persistent writes", async () => {
  const f = await fixture();
  expect(await f.store.storage({ workspace_id: "w" })).toMatchObject({ state: "missing", record_files: 0, record_bytes: 0 });
  expect(await f.store.prune(prune)).toMatchObject({ applied: false, candidate_records: 0 });
  await expect(lstat(f.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("R08 physical revision count stops admission instead of allowing invisible unlimited history", async () => {
  const f = await fixture({ maxRecords: 2 });
  const id = await revisions(f, 2);
  await expect(f.store.checkpoint({ workspace_id: "w", context_id: id, turn_id: "t", goal: "third" })).rejects.toMatchObject({ code: "context_storage_full" });
  expect(await readdir(join(f.dir, id))).toEqual(["1.json", "2.json"]);
  await expect(lstat(join(f.dir, ".pending-checkpoint.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.store.bootstrap({ workspace_id: "w" })).toMatchObject({ context: { revision: 2 } });
});

it("R08 a full store still serves the existing deduplicated checkpoint without new files", async () => {
  const f = await fixture({ maxRecords: 1 });
  const input = { workspace_id: "w", turn_id: "once", goal: "same" };
  const first = await f.store.checkpoint(input);
  for (let i = 0; i < 20; i++) expect(await f.store.checkpoint(input)).toMatchObject({ deduplicated: true, context: first.context });
  expect((await f.store.storage({ workspace_id: "w" })).record_files).toBe(1);
});

it("R08 creating another context never silently drops an existing index entry at capacity", async () => {
  const f = await fixture({ maxContexts: 2 });
  for (const turn_id of ["one", "two"]) await f.store.checkpoint({ workspace_id: "w", turn_id, goal: turn_id });
  const before = await readFile(join(f.dir, "index.json"));
  await expect(f.store.checkpoint({ workspace_id: "w", turn_id: "three", goal: "third" })).rejects.toMatchObject({ code: "context_storage_full" });
  expect(await readFile(join(f.dir, "index.json"))).toEqual(before);
});

it("R08 byte quota accounts for serialized UTF-8 records, not index item count", async () => {
  const f = await fixture({ maxBytes: 1000 });
  await expect(f.store.checkpoint({ workspace_id: "w", turn_id: "t", goal: "中".repeat(500) })).rejects.toMatchObject({ code: "context_storage_full" });
  expect((await f.store.storage({ workspace_id: "w" })).record_files).toBe(0);
});

it("R08 retention previews old superseded versions, preserves latest and makes no writes", async () => {
  const f = await fixture(), id = await revisions(f);
  const before = await readFile(join(f.dir, "index.json"));
  const result = await f.store.prune(prune);
  expect(result).toMatchObject({ applied: false, candidate_records: 2, preserved_contexts: 1, has_more: false });
  expect(result.plan_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(await readdir(join(f.dir, id))).toHaveLength(4);
  expect(await readFile(join(f.dir, "index.json"))).toEqual(before);
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(JSON.stringify(result)).not.toContain("revision-");
});

it("R08 explicit retention only removes the reviewed old revisions and rebuild cannot resurrect them", async () => {
  const f = await fixture(), id = await revisions(f);
  const latest = await readFile(join(f.dir, id, "4.json"));
  const plan = await f.store.prune(prune);
  const result = await f.store.prune({ ...prune, apply: true, expected_plan_hash: plan.plan_hash });
  expect(result).toMatchObject({ applied: true, deleted_records: 2, complete: true });
  expect(await readdir(join(f.dir, id))).toEqual(["3.json", "4.json"]);
  expect(await readFile(join(f.dir, id, "4.json"))).toEqual(latest);
  await f.store.rebuild({ workspace_id: "w" });
  expect(await f.store.bootstrap({ workspace_id: "w" })).toMatchObject({ context: { revision: 4 } });
  await expect(f.store.read({ workspace_id: "w", context_id: id, revision: 1 })).rejects.toMatchObject({ code: "context_record_missing" });
});

it("R08 stale plans and missing explicit approval cannot remove any record", async () => {
  const f = await fixture(), id = await revisions(f);
  const plan = await f.store.prune(prune);
  await f.store.checkpoint({ workspace_id: "w", context_id: id, turn_id: "t", goal: "newer" });
  await expect(f.store.prune({ ...prune, apply: true, expected_plan_hash: plan.plan_hash })).rejects.toMatchObject({ code: "context_plan_changed" });
  await expect(f.store.prune({ ...prune, apply: true })).rejects.toMatchObject({ code: "invalid_params" });
  expect(await readdir(join(f.dir, id))).toHaveLength(5);
});

it("R08 retention requires both age and revision conditions and never removes the latest", async () => {
  const f = await fixture(); await revisions(f);
  expect(await f.store.prune({ ...prune, keep_days: 3650 })).toMatchObject({ candidate_records: 0 });
  expect(await f.store.prune({ ...prune, keep_revisions: 1 })).toMatchObject({ candidate_records: 3 });
  expect(await f.store.prune({ ...prune, keep_revisions: 100 })).toMatchObject({ candidate_records: 0 });
});

it("R08 corruption or a pending checkpoint blocks pruning before deletion", async () => {
  const f = await fixture(), id = await revisions(f);
  await writeFile(join(f.dir, id, "1.json"), "broken-json");
  await expect(f.store.prune(prune)).rejects.toMatchObject({ code: "context_record_corrupt" });
  expect(await readdir(join(f.dir, id))).toHaveLength(4);
  await writeFile(join(f.dir, ".pending-checkpoint.json"), "{}");
  await expect(f.store.prune(prune)).rejects.toMatchObject({ code: "context_index_stale" });
});

it("R08 final authorization denial prevents deletion even with a valid plan", async () => {
  const f = await fixture(), id = await revisions(f);
  const plan = await f.store.prune(prune);
  const denied = () => { throw Object.assign(new Error("revoked"), { code: "stale_policy" }); };
  await expect(f.store.prune({ ...prune, apply: true, expected_plan_hash: plan.plan_hash }, denied)).rejects.toMatchObject({ code: "stale_policy" });
  expect(await readdir(join(f.dir, id))).toHaveLength(4);
});

it("R08 inventory rejects unrecognized files instead of deleting them or ignoring their footprint", async () => {
  const f = await fixture(), id = await revisions(f);
  await writeFile(join(f.dir, id, "operator-backup.dat"), "keep me");
  await expect(f.store.prune(prune)).rejects.toMatchObject({ code: "context_storage_unsafe" });
  expect(await readFile(join(f.dir, id, "operator-backup.dat"), "utf8")).toBe("keep me");
});
