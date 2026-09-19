import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContextStore } from "../src/context-store.js";
import { ContextRepository } from "../src/context/repository.js";
import { nativeContextFiles } from "../src/context/files.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "context-recovery-")); roots.push(root);
  const stateDir = join(root, "state");
  const repository = new ContextRepository(stateDir, join(stateDir, "contexts"), nativeContextFiles);
  return { stateDir, repository, store: new ContextStore({ stateDir }, { repository }), directory: join(stateDir, "contexts", "w") };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("R04 new-turn index failure cannot create repeated orphan records when another context already exists", async () => {
  const f = await fixture();
  const existing = await f.store.checkpoint({ workspace_id: "w", turn_id: "existing", goal: "preserve existing" });
  const input = { workspace_id: "w", turn_id: "new-turn", goal: "recover one record", expected_revision: 0 };
  vi.spyOn(f.repository, "writeIndex").mockRejectedValueOnce(new Error("synthetic failed index"));
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
  vi.spyOn(f.repository, "writeIndex").mockRejectedValueOnce(new Error("synthetic failed index"));
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
  const record = vi.spyOn(f.repository, "writeRecord"); const index = vi.spyOn(f.repository, "writeIndex");
  for (let i = 0; i < 100; i++) expect(await f.store.checkpoint(input)).toEqual({ ...first, deduplicated: true });
  expect(record).not.toHaveBeenCalled(); expect(index).not.toHaveBeenCalled();
  expect(await readFile(join(f.directory, "index.json"))).toEqual(before);
});

it("R04 a real process exit between record and index preserves one recoverable new-turn receipt", async () => {
  const f = await fixture();
  await f.store.checkpoint({ workspace_id: "w", turn_id: "old", goal: "preserve old index" });
  const input = { workspace_id: "w", turn_id: "process-exit", goal: "recover after actual process exit", expected_revision: 0 };
  const script = `import { ContextStore } from ${JSON.stringify(new URL("../src/context-store.ts", import.meta.url).href)};
    import { ContextRepository } from ${JSON.stringify(new URL("../src/context/repository.ts", import.meta.url).href)};
    import { nativeContextFiles } from ${JSON.stringify(new URL("../src/context/files.ts", import.meta.url).href)};
    class CrashBeforeIndex extends ContextRepository { async writeIndex() { process.exit(71); } }
    const stateDir = ${JSON.stringify(f.stateDir)};
    const repository = new CrashBeforeIndex(stateDir, ${JSON.stringify(join(f.stateDir, "contexts"))}, nativeContextFiles);
    const store = new ContextStore({stateDir}, {repository});
    await store.checkpoint(${JSON.stringify(input)});`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  expect(child.status, child.stderr).toBe(71);
  const restart = new ContextStore({ stateDir: f.stateDir });
  await expect(restart.checkpoint(input)).rejects.toMatchObject({ code: "context_index_stale" });
  expect(await restart.rebuild({ workspace_id: "w" })).toMatchObject({ records: 2 });
  expect(await restart.checkpoint(input)).toMatchObject({ deduplicated: true, context: { revision: 1 } });
});
