import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextStore } from "../src/context-store.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), mkdir: vi.fn(actual.mkdir) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];

afterEach(async () => {
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  vi.mocked(fs.mkdir).mockImplementation(actual.mkdir);
  for (const root of roots.splice(0)) await actual.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function fixture() {
  const root = await actual.mkdtemp(join(tmpdir(), "runmesh-context-directory-"));
  roots.push(root);
  const stateDir = join(root, "state");
  await actual.mkdir(stateDir, { mode: 0o700 });
  return { root, stateDir, store: new ContextStore({ stateDir }) };
}

describe("Context directory creation", () => {
  it("admits first checkpoints in different workspaces when their shared parent is created concurrently", async () => {
    const f = await fixture();
    const shared = join(f.stateDir, "contexts");
    let missingReads = 0;
    let release!: () => void;
    const bothMissing = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fs.lstat).mockImplementation(async (...args) => {
      if (String(args[0]) === shared && missingReads < 2) {
        missingReads += 1;
        if (missingReads === 2) release();
        await bothMissing;
        throw Object.assign(new Error("shared parent was absent"), { code: "ENOENT" });
      }
      return actual.lstat(...args);
    });
    const workspaces = ["one", "two"];
    // Drain both operations before cleanup, including when either one fails.
    const results = await Promise.allSettled(workspaces.map(workspace_id =>
      f.store.checkpoint({ workspace_id, turn_id: "first", goal: `Save ${workspace_id}` })));
    expect(missingReads).toBe(2);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const workspace_id of workspaces) {
      expect(await f.store.bootstrap({ workspace_id })).toMatchObject({ state: "ready", context: { workspace_id, revision: 1 } });
      expect((await f.store.storage({ workspace_id })).record_files).toBe(1);
    }
  });

  it.each(["file", "link"])("rejects a %s created in place of the shared directory", async replacement => {
    const f = await fixture();
    const shared = join(f.stateDir, "contexts");
    const outside = join(f.root, "outside");
    await actual.mkdir(outside, { mode: 0o700 });
    let substituted = false;
    vi.mocked(fs.mkdir).mockImplementation(async (...args) => {
      if (String(args[0]) === shared && !substituted) {
        substituted = true;
        if (replacement === "file") await actual.writeFile(shared, "preserve this file");
        else await actual.symlink(outside, shared, process.platform === "win32" ? "junction" : "dir");
        throw Object.assign(new Error("parent was created concurrently"), { code: "EEXIST" });
      }
      return actual.mkdir(...args);
    });
    await expect(f.store.checkpoint({ workspace_id: "one", turn_id: "first", goal: "Save context" }))
      .rejects.toMatchObject({ code: "context_storage_unsafe" });
    expect(substituted).toBe(true);
    expect(await actual.readdir(outside)).toEqual([]);
    if (replacement === "file") expect(await actual.readFile(shared, "utf8")).toBe("preserve this file");
  });
});
