import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { trustedGitPathEntries } from "../src/git-service.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

it.skipIf(process.platform === "win32")("rejects untrusted owners, writable executables, and executable symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "runmesh-git-ownership-"));
  const workspace = join(base, "workspace"); const bin = join(base, "secure", "git", "bin");
  const executable = join(bin, "git"); const oldPath = process.env.PATH;
  try {
    await mkdir(workspace); await mkdir(bin, { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n"); await chmod(executable, 0o755);
    process.env.PATH = bin;
    expect(trustedGitPathEntries(workspace)).toContain(bin);
    for (const untrustedPath of [bin, executable]) {
      vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
        const info = actual.lstatSync(path, options);
        if (String(path) !== untrustedPath) return info;
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: 2147483646 });
      }) as typeof fs.lstatSync);
      expect(trustedGitPathEntries(workspace)).not.toContain(bin);
      vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
    }
    await chmod(executable, 0o777);
    expect(trustedGitPathEntries(workspace)).not.toContain(bin);
    await rm(executable); await symlink("/usr/bin/git", executable);
    expect(trustedGitPathEntries(workspace)).not.toContain(bin);
  } finally {
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(base, { recursive: true, force: true });
  }
});
