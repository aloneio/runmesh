import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProfileStore, type RunnerProfile } from "../src/profile.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

it.each(["unchanged", "in-place"])("loads one complete profile across short reads (%s)", async change => {
  const root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "runmesh-profile-read-")));
  const store = new ProfileStore({ baseDir: join(root, "profile") });
  const prior: RunnerProfile = { version: 1, server_url: "wss://old.example.test/runner/connect", runner_id: "runner-1", token: "old-fixture-credential-012345", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
  try {
    await store.save(prior);
    const before = await actual.readFile(store.filePath, "utf8");
    const next = before.replace("old.example.test", "new.example.test").replace("old-fixture-credential", "new-fixture-credential");
    expect(Buffer.byteLength(next)).toBe(Buffer.byteLength(before));
    await actual.utimes(store.filePath, new Date(1000), new Date(1000));
    let changedFile = false;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (String(path) === store.filePath) {
        const read = handle.read.bind(handle);
        handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const result = await read(buffer, offset, Math.min(length, before.indexOf('"token"')), position);
          if (change !== "unchanged" && !changedFile && result.bytesRead > 0) {
            changedFile = true;
            await actual.writeFile(store.filePath, next);
            await actual.utimes(store.filePath, new Date(2000), new Date(2000));
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    if (change === "in-place") await expect(store.load()).rejects.toThrow("runner profile changed while being read");
    else expect(await store.load()).toEqual(prior);
    expect(changedFile).toBe(change !== "unchanged");
  } finally {
    vi.mocked(fs.open).mockImplementation(actual.open);
    await actual.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
