import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostPurgeFilesystem } from "../src/purge.js";

const faults = vi.hoisted(() => ({ write: false, fileSync: false, parentSync: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === "writeFile" && faults.write) return async (content: string) => {
        await target.writeFile(content.slice(0, 5));
        throw new Error("synthetic partial write");
      };
      if (property === "sync") return async () => {
        const directory = (await target.stat()).isDirectory();
        if (directory ? faults.parentSync : faults.fileSync) throw new Error("synthetic sync failure");
        return target.sync();
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
});

afterEach(() => { faults.write = false; faults.fileSync = false; faults.parentSync = false; });

describe.skipIf(process.platform === "win32")("stop recovery record persistence", () => {
  it.each(["write", "fileSync"] as const)("leaves a retryable destination after %s failure", async failure => {
    const directory = await mkdtemp(join(tmpdir(), "runmesh-stop-record-"));
    const path = join(directory, "stop.json"), content = '{"pid":4321}\n';
    try {
      faults[failure] = true;
      await expect(hostPurgeFilesystem.createFile!(path, content)).rejects.toThrow("synthetic");
      expect(await readdir(directory)).toEqual([]);
      faults[failure] = false;
      await hostPurgeFilesystem.createFile!(path, content);
      expect(await readFile(path, "utf8")).toBe(content);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps a complete record after parent sync failure and synchronizes it on retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runmesh-stop-record-"));
    const path = join(directory, "stop.json"), content = '{"pid":4321}\n';
    try {
      faults.parentSync = true;
      await expect(hostPurgeFilesystem.createFile!(path, content)).rejects.toThrow("synthetic sync failure");
      expect(await readFile(path, "utf8")).toBe(content);
      expect(await readdir(directory)).toEqual(["stop.json"]);
      await expect(hostPurgeFilesystem.syncFile!(path)).rejects.toThrow("synthetic sync failure");
      faults.parentSync = false;
      await hostPurgeFilesystem.syncFile!(path);
      expect(await readFile(path, "utf8")).toBe(content);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
