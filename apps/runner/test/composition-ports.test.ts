import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { nativeJobFiles } from "../src/jobs/storage.js";
import { ContextStore } from "../src/context-store.js";
import { ContextRepository } from "../src/context/repository.js";
import { nativeContextFiles } from "../src/context/files.js";
it("JobManager construction has no I/O; storage failure stops initialization at its public port", async () => {
  const failure = Error("synthetic storage failure");
  const ensure = vi.fn(async () => { throw failure; });
  const atomicJson = vi.fn(nativeJobFiles.atomicJson);
  const jobs = new JobManager({ policy: new PathPolicy([]), stateDir: join(tmpdir(), "runmesh-unused-composition") }, { files: { ...nativeJobFiles, ensureJobStorageDirectories: ensure, atomicJson } });
  expect(ensure).not.toHaveBeenCalled(); expect(atomicJson).not.toHaveBeenCalled();
  await expect(jobs.initialize()).rejects.toBe(failure);
  expect(ensure).toHaveBeenCalledTimes(1); expect(atomicJson).not.toHaveBeenCalled();
});
it("ContextStore reads through an injected repository, without private-member casts", async () => {
  const path = join(tmpdir(), "runmesh-unused-context-composition");
  const read = vi.fn(async () => { throw Error("synthetic unavailable index"); });
  const exists = vi.fn(async () => false);
  const repo = new ContextRepository(path, join(path, "contexts"), { ...nativeContextFiles, pathExists: exists, readJsonBounded: read });
  const context = new ContextStore({ stateDir: path }, { repository: repo });
  expect(exists).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  await expect(context.bootstrap({ workspace_id: "w" })).rejects.toMatchObject({ code: "context_index_corrupt" });
  expect(read).toHaveBeenCalledTimes(1);
});
