import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";

function gitExecutable(): string {
  if (process.platform === "win32") {
    for (const entry of (process.env.Path ?? process.env.PATH ?? "").split(";")) {
      const path = join(entry.trim(), "git.exe");
      if (entry.trim() !== "" && existsSync(path)) return path;
    }
  }
  return "git";
}

const executable = gitExecutable();
async function git(root: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
      cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output: Buffer.concat(output).toString("utf8") }));
  });
}

describe("Git ref names through public inspection", () => {
  let base: string;
  let root: string;
  let commit: string;
  let service: GitService;
  const input = { workspace_id: "workspace-refs" };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "runmesh-git-refs-"));
    root = join(base, "workspace");
    await mkdir(root);
    expect(await git(root, ["init", "--initial-branch=main"])).toMatchObject({ code: 0 });
    expect(await git(root, ["-c", "user.name=Ref Fixture", "-c", "user.email=refs@example.test", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "Git ref fixture"])).toMatchObject({ code: 0 });
    const head = await git(root, ["rev-parse", "HEAD"]);
    expect(head.code).toBe(0);
    commit = head.output.trim();
    service = new GitService(new PathPolicy([{ workspaceId: input.workspace_id, rootPath: await realpath(root), readonly: true, shell: false }]), { executable });
  });

  afterAll(async () => {
    if (base !== undefined) await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it.each(["main", "修复/连接", "feature/foo+bar", "release/@ready", "emoji/🚀", "unicode/\u2003wide\u2003", "unicode/\u00a0space\u00a0", "unicode/line\u2028separator\u2029", "unicode/\ufeffbom\ufeff", "unicode/\ufffd", "feature/name.locked", "feature/name.LOCK"])("reads valid loose branch %j", async (branch) => {
    const ref = `refs/heads/${branch}`;
    expect(await git(root, ["check-ref-format", ref])).toMatchObject({ code: 0 });
    expect(await git(root, ["update-ref", ref, commit])).toMatchObject({ code: 0 });
    expect(await git(root, ["symbolic-ref", "HEAD", ref])).toMatchObject({ code: 0 });
    await expect(service.status(input)).resolves.toMatchObject({ branch: { head: branch, oid: commit }, entries: [] });
    await expect(service.head(input)).resolves.toEqual({ ...input, commit });
  });

  it.each(["packed/修复+连接", "packed/\u00a0edge\u00a0", "packed/line\u2028separator\u2029", "packed/\ufeffbom\ufeff", "packed/\ufffd"])("reads valid packed branch %j", async (branch) => {
    const ref = `refs/heads/${branch}`;
    expect(await git(root, ["check-ref-format", ref])).toMatchObject({ code: 0 });
    expect(await git(root, ["update-ref", ref, commit])).toMatchObject({ code: 0 });
    expect(await git(root, ["symbolic-ref", "HEAD", ref])).toMatchObject({ code: 0 });
    expect(await git(root, ["pack-refs", "--all", "--prune"])).toMatchObject({ code: 0 });
    expect(existsSync(join(root, ".git", ref))).toBe(false);
    await expect(service.status(input)).resolves.toMatchObject({ branch: { head: branch, oid: commit }, entries: [] });
    await expect(service.head(input)).resolves.toEqual({ ...input, commit });
  });

  it("resolves symbolic refs with Unicode whitespace without changing their names", async () => {
    const ref = "refs/heads/target/\u2003修复+连接\u2028\u2029";
    expect(await git(root, ["check-ref-format", ref])).toMatchObject({ code: 0 });
    expect(await git(root, ["update-ref", ref, commit])).toMatchObject({ code: 0 });
    expect(await git(root, ["symbolic-ref", "refs/heads/alias", ref])).toMatchObject({ code: 0 });
    expect(await git(root, ["symbolic-ref", "HEAD", "refs/heads/alias"])).toMatchObject({ code: 0 });
    await expect(service.head(input)).resolves.toEqual({ ...input, commit });
    await expect(service.observeBaseline(input)).resolves.toEqual({ commit, working_tree_state: "clean" });
  });

  it("keeps a valid unborn Unicode branch", async () => {
    const branch = "unborn/修复+\u00a0";
    expect(await git(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`])).toMatchObject({ code: 0 });
    await expect(service.status(input)).resolves.toMatchObject({ branch: { head: branch, oid: "(initial)" }, entries: [] });
  });

  it("keeps a detached HEAD and accepts CRLF metadata line endings", async () => {
    await writeFile(join(root, ".git", "HEAD"), `${commit}\r\n`);
    await expect(service.head(input)).resolves.toEqual({ ...input, commit });
    await expect(service.status(input)).resolves.toMatchObject({ branch: { head: "(detached)", oid: commit }, entries: [] });
  });

  it("keeps SHA-256 refs and detached HEADs", async () => {
    const shaRoot = join(base, "sha256");
    await mkdir(shaRoot);
    expect(await git(shaRoot, ["init", "--object-format=sha256", "--initial-branch=修复+连接"])).toMatchObject({ code: 0 });
    expect(await git(shaRoot, ["-c", "user.name=Ref Fixture", "-c", "user.email=refs@example.test", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "SHA-256 ref fixture"])).toMatchObject({ code: 0 });
    const head = await git(shaRoot, ["rev-parse", "HEAD"]);
    expect(head.code).toBe(0);
    const shaCommit = head.output.trim();
    expect(shaCommit).toMatch(/^[0-9a-f]{64}$/u);
    const shaService = new GitService(new PathPolicy([{ workspaceId: input.workspace_id, rootPath: await realpath(shaRoot), readonly: true, shell: false }]), { executable });
    await expect(shaService.head(input)).resolves.toEqual({ ...input, commit: shaCommit });
    await writeFile(join(shaRoot, ".git", "HEAD"), `${shaCommit}\n`);
    await expect(shaService.head(input)).resolves.toEqual({ ...input, commit: shaCommit });
  });

  it("keeps a BOM at the start of HEAD as malformed metadata", async () => {
    await writeFile(join(root, ".git", "HEAD"), `\ufeff${commit}\n`);
    await expect(service.head(input)).rejects.toMatchObject({ code: "git_unavailable" });
  });

  it.each([
    "refs/heads/a b", "refs/heads/a\tb", "refs/heads/a\nb", "refs/heads/a\u001fb", "refs/heads/a\u007fb",
    "refs/heads/a~b", "refs/heads/a^b", "refs/heads/a:b", "refs/heads/a?b", "refs/heads/a*b", "refs/heads/a[b",
    "refs/heads/a\\b", "refs/heads/a..b", "refs/heads/a@{b", "refs/heads/.hidden", "refs/heads/a.lock",
    "refs/heads/a.lock/child", "refs/heads/.hidden/child", "refs/heads/a.", "refs/heads/a//b", "refs/heads/a/",
    "refs/heads/../outside", "refs/heads/./main", "/refs/heads/main",
  ])("rejects malformed HEAD ref %j", async (ref) => {
    expect((await git(root, ["check-ref-format", ref])).code).not.toBe(0);
    await writeFile(join(root, ".git", "HEAD"), `ref: ${ref}\n`);
    await expect(service.status(input)).rejects.toMatchObject({ code: "git_unavailable" });
  });

  it("rejects symbolic targets outside the refs namespace", async () => {
    await writeFile(join(root, ".git", "HEAD"), "ref: objects/aa/target\n");
    await expect(service.status(input)).rejects.toMatchObject({ code: "git_unavailable" });
  });

  it.each(["ref: refs/heads/bad..target\n", "ref: refs/heads/alias\n", "invalid commit\n"])("rejects malformed or cyclic loose refs %j", async (value) => {
    await writeFile(join(root, ".git", "refs", "heads", "alias"), value);
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/alias\n");
    await expect(service.status(input)).rejects.toMatchObject({ code: "git_unavailable" });
  });

  it.each(["HEAD", "loose", "packed"])("keeps undecodable %s ref bytes distinct from a real replacement-character name", async (source) => {
    const ref = "refs/heads/replacement/\ufffd";
    const loosePath = join(root, ".git", ref);
    const packedPath = join(root, ".git", "packed-refs");
    const packed = await readFile(packedPath).catch(() => Buffer.alloc(0));
    await mkdir(join(root, ".git", "refs", "heads", "replacement"), { recursive: true });
    await writeFile(loosePath, `${commit}\n`);
    const brokenRef = Buffer.concat([Buffer.from("refs/heads/replacement/"), Buffer.from([0xc0])]);
    try {
      if (source === "HEAD") {
        await writeFile(join(root, ".git", "HEAD"), Buffer.concat([Buffer.from("ref: "), brokenRef, Buffer.from("\n")]));
      } else if (source === "loose") {
        await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/alias\n");
        await writeFile(join(root, ".git", "refs", "heads", "alias"), Buffer.concat([Buffer.from("ref: "), brokenRef, Buffer.from("\n")]));
      } else {
        await rm(loosePath);
        await writeFile(join(root, ".git", "HEAD"), `ref: ${ref}\n`);
        await writeFile(packedPath, Buffer.concat([Buffer.from(`${commit} `), brokenRef, Buffer.from("\n")]));
      }
      await expect(service.head(input)).rejects.toMatchObject({ code: "git_unavailable" });
    } finally { await writeFile(packedPath, packed); }
  });

  it("rejects a ref under a symlinked intermediate directory", async () => {
    const outside = join(base, "outside");
    const link = join(root, ".git", "refs", "heads", "escaped");
    await mkdir(outside);
    await writeFile(join(outside, "target"), `${commit}\n`);
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/escaped/target\n");
      await expect(service.head(input)).rejects.toMatchObject({ code: "git_unavailable" });
    } finally { await rm(link, { recursive: true, force: true }); }
  });
});
