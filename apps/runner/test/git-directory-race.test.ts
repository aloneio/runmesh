import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath) };
});
const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
it.skipIf(process.platform === "win32")("rejects replacing .git between lstat and canonicalization", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-git-race-"));
  const root = join(base, "workspace"); const outside = join(base, "synthetic-outside");
  await fs.mkdir(root); await fs.mkdir(outside);
  execFileSync("git", ["init", "-q", root]); execFileSync("git", ["init", "-q", outside]);
  let swapped = false;
  vi.mocked(fs.realpath).mockImplementation(async (path, options) => {
    if (String(path) === join(root, ".git") && !swapped) {
      swapped = true;
      await fs.rename(join(root, ".git"), join(root, ".git-held"));
      await fs.symlink(join(outside, ".git"), join(root, ".git"), "dir");
    }
    return original.realpath(path, options as never);
  });
  try {
    const service = new GitService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]));
    await expect(service.status({ workspace_id: "test" })).rejects.toThrow();
    expect(swapped).toBe(true);
  } finally {
    vi.mocked(fs.realpath).mockImplementation(original.realpath);
    await fs.rm(base, { recursive: true, force: true });
  }
});
