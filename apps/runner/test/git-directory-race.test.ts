import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath), open: vi.fn(original.open) };
});

it.each(["config", "exclude", "shallow", "sharedindex"])("rejects replacing Git %s after lstat and before the file opens", async name => {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-git-data-race-")), root = join(base, "workspace");
  await fs.mkdir(root); execFileSync("git", ["init", "-q", root]);
  if (name === "shallow") await fs.writeFile(join(root, ".git", "shallow"), "");
  if (name === "sharedindex") {
    await fs.writeFile(join(root, "note.txt"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "note.txt"]);
    execFileSync("git", ["-C", root, "update-index", "--split-index"]);
  }
  const leaf = name === "sharedindex" ? (await fs.readdir(join(root, ".git"))).find(value => value.startsWith("sharedindex."))! : name;
  const source = name === "exclude" ? join(root, ".git", "info", leaf) : join(root, ".git", leaf);
  const initial = await fs.readFile(source);
  let swapped = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (basename(String(path)) === leaf && !swapped) {
      swapped = true; await fs.rename(source, source + ".held"); await fs.writeFile(source, initial);
    }
    return original.open(path, flags, mode);
  });
  try {
    const service = new GitService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]));
    await expect(service.status({ workspace_id: "test" })).rejects.toMatchObject({ code: "git_unavailable" });
    expect(swapped).toBe(true);
  } finally { vi.mocked(fs.open).mockImplementation(original.open); await fs.rm(base, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("rejects an info directory replacement after its descriptor is pinned", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-git-info-race-")), root = join(base, "workspace"), outside = join(base, "outside");
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(join(outside, "exclude"), "*\n");
  execFileSync("git", ["init", "-q", root]);
  const source = join(root, ".git", "info"); let swapped = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await original.open(path, flags, mode);
    if (basename(String(path)) === "info" && !swapped) {
      swapped = true; await fs.rename(source, source + "-held"); await fs.symlink(outside, source, "dir");
    }
    return handle;
  });
  try {
    const service = new GitService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]));
    await expect(service.status({ workspace_id: "test" })).rejects.toMatchObject({ code: "git_unavailable" });
    expect(swapped).toBe(true); expect(await fs.readFile(join(outside, "exclude"), "utf8")).toBe("*\n");
  } finally { vi.mocked(fs.open).mockImplementation(original.open); await fs.rm(base, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32").each(["config", "info/exclude", "shallow", "sharedindex"])("rejects a linked Git %s leaf", async path => {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-git-data-link-")), root = join(base, "workspace"), outside = join(base, "outside");
  await fs.mkdir(root); execFileSync("git", ["init", "-q", root]);
  if (path === "shallow") await fs.writeFile(join(root, ".git", "shallow"), "");
  if (path === "sharedindex") {
    await fs.writeFile(join(root, "note.txt"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "note.txt"]);
    execFileSync("git", ["-C", root, "update-index", "--split-index"]);
    path = (await fs.readdir(join(root, ".git"))).find(value => value.startsWith("sharedindex."))!;
  }
  const target = join(root, ".git", path); await fs.writeFile(outside, await fs.readFile(target));
  await fs.rm(target); await fs.symlink(outside, target);
  try {
    const service = new GitService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]));
    await expect(service.status({ workspace_id: "test" })).rejects.toMatchObject({ code: "git_unavailable" });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
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
