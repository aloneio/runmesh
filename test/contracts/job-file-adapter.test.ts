import { afterEach, expect, it } from "vitest";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeJobFiles } from "../../apps/runner/src/jobs/storage.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ar08-adapter-")));
  directories.push(root);
  const jobs = join(root, "jobs");
  await nativeJobFiles.ensureJobStorageDirectories(root, jobs);
  return jobs;
}

it("AR08 native record adapter preserves JSON through its public port", async () => {
  const jobs = await fixture(), path = join(jobs, "example.json");
  const record = { job_id: "synthetic", status: "unknown", exit_code: null, note: "中文😀" };
  await nativeJobFiles.atomicJson(path, record);
  expect(await nativeJobFiles.readJson(path)).toEqual(record);
  expect(await readdir(jobs)).toEqual(["example.json"]);
});

it("AR08 failed serialization preserves the previous record and removes temporary files", async () => {
  const jobs = await fixture(), path = join(jobs, "example.json");
  await nativeJobFiles.atomicJson(path, { revision: 1 });
  const circular: { self?: unknown } = {}; circular.self = circular;
  await expect(nativeJobFiles.atomicJson(path, circular)).rejects.toThrow();
  expect(await nativeJobFiles.readJson(path)).toEqual({ revision: 1 });
  expect(await readdir(jobs)).toEqual(["example.json"]);
});

it("AR08 missing metadata is unavailable while log append preserves exact bytes", async () => {
  const jobs = await fixture();
  await expect(nativeJobFiles.readJson(join(jobs, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const path = join(jobs, "stdout.log"), first = Buffer.from("中文"), second = Buffer.from("😀\n");
  await nativeJobFiles.appendJobLog(path, first); await nativeJobFiles.appendJobLog(path, second);
  const handle = await nativeJobFiles.openJobLog(path, "read");
  try { expect(await handle.readFile()).toEqual(Buffer.concat([first, second])); }
  finally { await handle.close(); }
});
