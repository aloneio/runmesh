import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContextStore } from "../src/context-store.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "context-recovery-")); roots.push(root);
  const stateDir = join(root, "state");
  return { stateDir, store: new ContextStore({ stateDir }), directory: join(stateDir, "contexts", "w") };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("R04 new-turn index failure cannot create repeated orphan records when another context already exists", async () => {
  const f = await fixture();
  const existing = await f.store.checkpoint({ workspace_id: "w", turn_id: "existing", goal: "preserve existing" });
  const input = { workspace_id: "w", turn_id: "new-turn", goal: "recover one record", expected_revision: 0 };
  const internals = f.store as unknown as { writeIndex: (...args: unknown[]) => Promise<void> };
  vi.spyOn(internals, "writeIndex").mockRejectedValueOnce(new Error("synthetic failed index"));
  await expect(f.store.checkpoint(input)).rejects.toMatchObject({ code: "context_index_stale" });
  const directories = (await readdir(f.directory, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
  expect(directories).toHaveLength(2);
  const restart = new ContextStore({ stateDir: f.stateDir });
  for (let i = 0; i < 10; i++) await expect(restart.checkpoint(input)).rejects.toMatchObject({ code: "context_index_stale" });
  expect((await readdir(f.directory, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort()).toEqual(directories.sort());
  expect(await restart.rebuild({ workspace_id: "w" })).toMatchObject({ records: 2 });
  expect(await restart.checkpoint(input)).toMatchObject({ deduplicated: true, context: { revision: 1 } });
  const old = existing.context as { context_id: string };
  expect(await restart.read({ workspace_id: "w", context_id: old.context_id })).toMatchObject({ context: { goal: "preserve existing", revision: 1 } });
});

it("R04 an unresolved committed checkpoint is unavailable to readers rather than a false empty history", async () => {
  const f = await fixture();
  const internals = f.store as unknown as { writeIndex: (...args: unknown[]) => Promise<void> };
  vi.spyOn(internals, "writeIndex").mockRejectedValueOnce(new Error("synthetic failed index"));
  await expect(f.store.checkpoint({ workspace_id: "w", turn_id: "orphan", goal: "recover" })).rejects.toMatchObject({ code: "context_index_stale" });
  const restart = new ContextStore({ stateDir: f.stateDir });
  await expect(restart.bootstrap({ workspace_id: "w" })).rejects.toMatchObject({ code: "context_index_stale" });
  await expect(restart.search({ workspace_id: "w", query: "recover" })).rejects.toMatchObject({ code: "context_index_stale" });
});

it("R04 successful no-change retries perform no record or index writes", async () => {
  const f = await fixture();
  const input = { workspace_id: "w", turn_id: "same", goal: "no unnecessary writes", expected_revision: 0 };
  const first = await f.store.checkpoint(input);
  const before = await readFile(join(f.directory, "index.json"));
  const internal = f.store as unknown as { writeRecord: (...args: unknown[]) => Promise<void>; writeIndex: (...args: unknown[]) => Promise<void> };
  const record = vi.spyOn(internal, "writeRecord"); const index = vi.spyOn(internal, "writeIndex");
  for (let i = 0; i < 100; i++) expect(await f.store.checkpoint(input)).toEqual({ ...first, deduplicated: true });
  expect(record).not.toHaveBeenCalled(); expect(index).not.toHaveBeenCalled();
  expect(await readFile(join(f.directory, "index.json"))).toEqual(before);
});
