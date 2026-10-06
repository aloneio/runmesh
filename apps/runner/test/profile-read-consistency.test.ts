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

it.each(["load", "loadMaintenanceIdentity"] as const)("%s binds short reads to one complete credential document", async method => {
  for (const change of ["unchanged", "in-place"]) {
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
      if (change === "in-place") await expect(store[method]()).rejects.toThrow("runner profile changed while being read");
      else expect(await store[method]()).toEqual(method === "load" ? prior : { runner_id: prior.runner_id, token: prior.token, server_url: prior.server_url });
      expect(changedFile).toBe(change !== "unchanged");
    } finally {
      vi.mocked(fs.open).mockImplementation(actual.open);
      await actual.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

it("keeps authenticated maintenance available across changes to Runner-only profile settings", async () => {
  const root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "runmesh-maintenance-identity-")));
  const store = new ProfileStore({ baseDir: join(root, "profile") });
  const prior: RunnerProfile = { version: 1, server_url: "wss://worker.example.test/runner/connect", runner_id: "runner-1", token: "fixture-credential-012345", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
  const identity = { server_url: prior.server_url, runner_id: prior.runner_id, token: prior.token };
  try {
    await store.save(prior);
    expect(await store.loadMaintenanceIdentity()).toEqual(identity);
    // A future execution profile can evolve without changing the maintenance identity.
    await actual.writeFile(store.filePath, JSON.stringify({ ...prior, version: 2, workspaces: { policy: "managed" }, max_concurrent_jobs: 256, future: { engine: "next" } }));
    expect(await store.load()).toBeUndefined();
    expect(await store.loadMaintenanceIdentity()).toEqual(identity);
    const rotated = "rotated-fixture-credential-012345";
    await actual.writeFile(store.filePath, JSON.stringify({ ...prior, token: rotated, max_concurrent_jobs: -1 }));
    expect(await store.load()).toBeUndefined();
    expect(await store.loadMaintenanceIdentity()).toEqual({ ...identity, token: rotated });
    for (const invalid of [{ token: "short" }, { server_url: "wss://user:pass@worker.example.test/runner/connect" }, { server_url: "ws://remote.example.test/runner/connect", insecure_local: true }, { runner_id: "../other" }, { version: 0 }]) {
      await actual.writeFile(store.filePath, JSON.stringify({ ...prior, ...invalid }));
      expect(await store.loadMaintenanceIdentity()).toBeUndefined();
    }
  } finally { await actual.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
