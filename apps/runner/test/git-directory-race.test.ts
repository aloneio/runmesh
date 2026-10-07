import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";

const executable = process.platform === "win32"
  ? (process.env.Path ?? process.env.PATH ?? "").split(";").map(path => join(path, "git.exe")).find(existsSync) ?? "git"
  : "git";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath), open: vi.fn(original.open), lstat: vi.fn(original.lstat) };
});

it.each(["index", "commondir", "objects/info/alternates", "packed-refs"])("reports Git metadata inspection errors for %s instead of treating them as missing", async path => {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-git-metadata-error-")), root = join(base, "workspace");
  try {
    await fs.mkdir(root); execFileSync("git", ["init", "-q", "--initial-branch=main", root]);
    await fs.writeFile(join(root, "note.txt"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "note.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
    execFileSync("git", ["-C", root, "pack-refs", "--all"]);
    const target = join(root, ".git", path), failure = Object.assign(new Error(`EIO: unable to inspect Git ${path}`), { code: "EIO" });
    let inspected = false;
    vi.mocked(fs.lstat).mockImplementation(async (entry, options) => {
      if (String(entry) === target) { inspected = true; throw failure; }
      return original.lstat(entry, options as never);
    });
    const service = new GitService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]), { executable });
    await expect(service.status({ workspace_id: "test" })).rejects.toMatchObject({ code: "git_unavailable", message: expect.stringContaining(failure.message) });
    expect(inspected).toBe(true);
  } finally {
    vi.mocked(fs.lstat).mockImplementation(original.lstat);
    await fs.rm(base, { recursive: true, force: true });
  }
});

it("reports invalid packed Git refs instead of inventing an unborn branch", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-git-packed-error-")), root = join(base, "workspace");
  try {
    await fs.mkdir(root); execFileSync("git", ["init", "-q", "--initial-branch=main", root]);
    await fs.writeFile(join(root, "note.txt"), "fixture\n");
    execFileSync("git", ["-C", root, "add", "note.txt"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-qm", "fixture"]);
    execFileSync("git", ["-C", root, "pack-refs", "--all"]);
    const packed = join(root, ".git", "packed-refs");
    await fs.rm(packed); await fs.mkdir(packed);
    const service = new GitService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]), { executable });
    await expect(service.status({ workspace_id: "test" })).rejects.toMatchObject({ code: "git_unavailable" });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
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
