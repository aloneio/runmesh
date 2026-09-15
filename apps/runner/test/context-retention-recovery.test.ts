import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ContextStore } from "../src/context-store.js";
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

const roots: string[] = [];
const settings = { workspace_id: "w", keep_days: 30, keep_revisions: 2 };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "context-prune-recovery-")); roots.push(root);
  const stateDir = join(root, "state"), store = new ContextStore({ stateDir, storageLimits: { maxRecords: 4 } });
  const clock = vi.spyOn(Date, "now"); let id = "";
  for (let i = 1; i <= 4; i++) {
    clock.mockReturnValue(1700000000000 + i * 86400000);
    const value = await store.checkpoint({ workspace_id: "w", turn_id: "t", goal: `revision-${i}`, ...(id ? { context_id: id, expected_revision: i - 1 } : {}) });
    id = (value.context as { context_id: string }).context_id;
  }
  clock.mockReturnValue(1700000000000 + 100 * 86400000);
  return { root, stateDir, store, id, dir: join(stateDir, "contexts", "w") };
}

it("R08 a real process exit after one unlink leaves latest and index intact without recovery replay", async () => {
  const f = await fixture(), latest = await fs.readFile(join(f.dir, f.id, "4.json")), index = await fs.readFile(join(f.dir, "index.json"));
  const plan = await f.store.prune(settings);
  const script = `import { ContextStore } from ${JSON.stringify(new URL("../src/context-store.ts", import.meta.url).href)};
    import { existsSync } from 'node:fs';
    const store = new ContextStore({stateDir:${JSON.stringify(f.stateDir)}});
    await store.prune(${JSON.stringify({ ...settings, apply: true, expected_plan_hash: plan.plan_hash })}, () => {
      if (!existsSync(${JSON.stringify(join(f.dir, f.id, "1.json"))})) process.exit(73);
    });`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  expect(child.status, child.stderr).toBe(73);
  expect(await fs.readdir(join(f.dir, f.id))).toEqual(["2.json", "3.json", "4.json"]);
  expect(await fs.readFile(join(f.dir, f.id, "4.json"))).toEqual(latest);
  expect(await fs.readFile(join(f.dir, "index.json"))).toEqual(index);
  const restart = new ContextStore({ stateDir: f.stateDir });
  expect(await restart.bootstrap({ workspace_id: "w" })).toMatchObject({ context: { revision: 4 } });
  const fresh = await restart.prune(settings);
  expect(fresh).toMatchObject({ candidate_records: 1 });
  expect(await restart.prune({ ...settings, apply: true, expected_plan_hash: fresh.plan_hash })).toMatchObject({ deleted_records: 1 });
});

it("R08 mid-batch revocation reports partial outcome and never removes the latest", async () => {
  const f = await fixture(), plan = await f.store.prune(settings);
  const authorize = () => { if (!existsSync(join(f.dir, f.id, "1.json"))) throw Object.assign(new Error("revoked"), { code: "stale_policy" }); };
  await expect(f.store.prune({ ...settings, apply: true, expected_plan_hash: plan.plan_hash }, authorize)).rejects.toMatchObject({ code: "context_prune_partial", details: { deleted_records: 1 } });
  expect(await fs.readdir(join(f.dir, f.id))).toEqual(["2.json", "3.json", "4.json"]);
});

it("R08 batches are bounded and free quota without resetting latest revision numbering", async () => {
  const f = await fixture(), input = { ...settings, max_delete: 1 }, plan = await f.store.prune(input);
  expect(plan).toMatchObject({ candidate_records: 1, eligible_records: 2, has_more: true });
  expect(await f.store.prune({ ...input, apply: true, expected_plan_hash: plan.plan_hash })).toMatchObject({ deleted_records: 1 });
  expect(await f.store.checkpoint({ workspace_id: "w", context_id: f.id, turn_id: "t", goal: "fifth" })).toMatchObject({ context: { revision: 5 } });
});

it("R08 storage inventory does not read immutable record bodies", async () => {
  const f = await fixture(), open = vi.mocked(fs.open); open.mockClear();
  const result = await f.store.storage({ workspace_id: "w" });
  expect(result).toMatchObject({ record_files: 4, context_count: 1, accounting: "logical_revision_bytes" });
  expect(open).not.toHaveBeenCalled();
  console.log(JSON.stringify({ scenario: "context_storage_inventory", record_files: result.record_files, record_body_opens: open.mock.calls.length }));
  open.mockClear();
  const paths = (await fs.readdir(join(f.dir, f.id))).map(name => join(f.dir, f.id, name));
  expect(result.record_bytes).toBe((await Promise.all(paths.map(path => fs.lstat(path)))).reduce((sum, value) => sum + value.size, 0));
});

it("R08 replaced context directories are refused instead of following outside junctions", async () => {
  const f = await fixture(), target = join(f.root, "saved-records");
  await fs.rename(join(f.dir, f.id), target);
  await fs.symlink(target, join(f.dir, f.id), process.platform === "win32" ? "junction" : "dir");
  await expect(f.store.prune(settings)).rejects.toMatchObject({ code: "context_storage_unsafe" });
  expect(await fs.readdir(target)).toHaveLength(4);
});

it("R08 policy generation binds a preview even when files and retention settings do not change", async () => {
  const f = await fixture(), plan = await f.store.prune({ ...settings, policy_generation: 4 });
  await expect(f.store.prune({ ...settings, policy_generation: 5, apply: true, expected_plan_hash: plan.plan_hash })).rejects.toMatchObject({ code: "context_plan_changed" });
  expect(await fs.readdir(join(f.dir, f.id))).toHaveLength(4);
});

it("R08 invalid or unlimited settings are refused at construction", async () => {
  const f = await fixture();
  for (const storageLimits of [{ maxBytes: Infinity }, { maxRecords: 0 }, { maxContexts: 257 }, { unknown: 1 }]) expect(() => new ContextStore({ stateDir: f.stateDir, storageLimits } as any)).toThrow();
});
