// Audit-only regressions. All paths and contents are disposable fixtures.
// Expectations express the intended boundary; a failure is audit evidence.
import { it, expect, vi } from "vitest";
import { constants } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, readdir, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { PathPolicy } from "../src/path-policy.js";
import { FilesystemService } from "../src/filesystem.js";
import { GitService } from "../src/git-service.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});
const originalFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

it.skipIf(process.platform !== "linux")("AUDIT-PATH: replacing a workspace-root ancestor cannot redirect a read outside the admitted root", async () => {
  const base = await mkdtemp(join(tmpdir(), "runmesh-audit-parent-"));
  try {
    const parent = join(base, "admitted-parent"), root = join(parent, "workspace");
    const outside = join(base, "outside-parent"), outsideRoot = join(outside, "workspace");
    await mkdir(root, { recursive: true }); await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(root, "note.txt"), "inside-fixture\n");
    await writeFile(join(outsideRoot, "note.txt"), "outside-fixture-canary\n");
    const service = new FilesystemService(new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: true, shell: false }]));
    expect((await service.read({ workspace_id: "w", path: "note.txt" })).data).toBe("inside-fixture\n");
    await rename(parent, join(base, "preserved-parent"));
    await symlink(outside, parent, "dir");
    let data: unknown; let errorCode: unknown;
    try { data = (await service.read({ workspace_id: "w", path: "note.txt" })).data; }
    catch (error) { errorCode = (error as { code?: unknown }).code; }
    console.log(JSON.stringify({ audit: "workspace_ancestor", outside_returned: data === "outside-fixture-canary\n", error_code: errorCode ?? null }));
    expect(data).not.toBe("outside-fixture-canary\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("AUDIT-GIT: object subdirectory links cannot expose a repository outside the readable workspace", async () => {
  const base = await mkdtemp(join(tmpdir(), "runmesh-audit-git-"));
  const git = (root: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=AuditFixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const root = join(base, "workspace"), outside = join(base, "outside-repository");
    await mkdir(root); await mkdir(outside);
    git(root, "init", "--initial-branch=main"); git(outside, "init", "--initial-branch=main");
    await writeFile(join(outside, "private-note.txt"), "outside-git-fixture-canary\n");
    git(outside, "add", "."); git(outside, "commit", "-m", "Synthetic audit object");
    const commit = git(outside, "rev-parse", "HEAD");
    await writeFile(join(root, ".git", "HEAD"), `${commit}\n`);
    for (const name of await readdir(join(outside, ".git", "objects"))) {
      if (/^[a-f0-9]{2}$/u.test(name)) await symlink(join(outside, ".git", "objects", name), join(root, ".git", "objects", name), "dir");
    }
    const service = new GitService(new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: true, shell: false }]));
    let output: unknown; let errorCode: unknown;
    try { output = (await service.show({ workspace_id: "w", path: "private-note.txt", revision: commit, max_bytes: 4096 })).output; }
    catch (error) { errorCode = (error as { code?: unknown }).code; }
    console.log(JSON.stringify({ audit: "git_object_subdirectory", outside_returned: output === "outside-git-fixture-canary\n", error_code: errorCode ?? null }));
    expect(output).not.toBe("outside-git-fixture-canary\n");
    expect(await readFile(join(outside, "private-note.txt"), "utf8")).toBe("outside-git-fixture-canary\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

it.each(["symlink", "replacement"])("SEC02 pins the root before its first read (%s)", async kind => {
  const base = await mkdtemp(join(tmpdir(), "runmesh-release-root-"));
  try {
    const root = join(base, "workspace"); await mkdir(root); await writeFile(join(root, "note"), "admitted");
    const service = new FilesystemService(new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: true, shell: false }]));
    await rename(root, join(base, "original"));
    if (kind === "symlink") { const outside = join(base, "outside"); await mkdir(outside); await writeFile(join(outside, "note"), "outside"); await symlink(outside, root, "junction"); }
    else { await mkdir(root); await writeFile(join(root, "note"), "replacement"); }
    await expect(service.read({ workspace_id: "w", path: "note" })).rejects.toMatchObject({ code: "path_changed" });
  } finally { await rm(base, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32").each(["fanout", "object", "pack", "pack-file", "info"])("SEC03 rejects an object-store %s link before Git can follow it", async kind => {
  const { snapshotGitObjects } = await import("../src/git/object-snapshot.js");
  const base = await mkdtemp(join(tmpdir(), "runmesh-release-object-"));
  try {
    const source = join(base, "objects"), target = join(base, "snapshot"), outside = join(base, "outside");
    await mkdir(source); await mkdir(target); await mkdir(outside); await writeFile(join(outside, "private"), "external-canary");
    if (kind === "fanout") await symlink(outside, join(source, "ab"), "dir");
    if (kind === "object") { await mkdir(join(source, "ab")); await symlink(join(outside, "private"), join(source, "ab", "c".repeat(38))); }
    if (kind === "pack") await symlink(outside, join(source, "pack"), "dir");
    if (kind === "pack-file") { await mkdir(join(source, "pack")); await symlink(join(outside, "private"), join(source, "pack", "pack-abc.pack")); }
    if (kind === "info") await symlink(outside, join(source, "info"), "dir");
    await expect(snapshotGitObjects(source, target)).rejects.toThrow(/links/);
    expect(await readFile(join(outside, "private"), "utf8")).toBe("external-canary");
  } finally { await rm(base, { recursive: true, force: true }); }
});

it("SEC03 rejects an oversized sparse object and an exhausted deadline", async () => {
  const { snapshotGitObjects } = await import("../src/git/object-snapshot.js");
  const { truncate } = await import("node:fs/promises");
  const base = await mkdtemp(join(tmpdir(), "runmesh-release-budget-"));
  try {
    const source = join(base, "objects"), target = join(base, "snapshot"); await mkdir(source); await mkdir(target);
    const large = join(source, "oversized"); await writeFile(large, ""); await truncate(large, 256 * 1024 * 1024 + 1);
    await expect(snapshotGitObjects(source, target)).rejects.toThrow(/bounded/);
    await expect(snapshotGitObjects(source, target, 0)).rejects.toThrow(/budget/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("SEC03 rejects a regular-to-FIFO race without waiting for a writer", async () => {
  const { snapshotGitObjects } = await import("../src/git/object-snapshot.js");
  const base = await mkdtemp(join(tmpdir(), "runmesh-release-fifo-"));
  const source = join(base, "objects"), target = join(base, "snapshot"), name = "b".repeat(38);
  let swapped = false, nonblocking = false;
  try {
    await mkdir(source); await mkdir(target); await mkdir(join(source, "aa"));
    const object = join(source, "aa", name); await writeFile(object, "synthetic-object");
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith(`/${name}`) && !swapped) {
        swapped = true; await originalFs.unlink(object); execFileSync("mkfifo", [object]);
        nonblocking = typeof flags === "number" && (flags & constants.O_NONBLOCK) !== 0;
        // A regression must fail, not leave a filesystem worker blocked.
        if (!nonblocking) throw new Error("fixture refused a blocking FIFO open");
      }
      return originalFs.open(path, flags, mode);
    });
    await expect(snapshotGitObjects(source, target)).rejects.toThrow("Git object changed before its snapshot");
    expect(swapped).toBe(true); expect(nonblocking).toBe(true);
    await expect(readFile(join(target, "aa", name))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.mocked(open).mockImplementation(originalFs.open);
    await rm(base, { recursive: true, force: true });
  }
});
