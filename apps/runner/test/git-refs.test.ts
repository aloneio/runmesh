import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";
import { createIsolatedGitContext } from "../src/git/isolated-context.js";
import { isolatedGitConfig } from "../src/git/config.js";
import { MAX_GIT_METADATA_BYTES } from "../src/git/limits.js";
import { parseStatus } from "../src/git/projection.js";
import { observeGitBaseline } from "../src/git/baseline.js";

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
async function expectSemanticBaseline(root: string, state: "clean" | "dirty" | "unknown", commit: string | null = nativeGit(root, ["rev-parse", "HEAD"]).trim()): Promise<void> {
  // Native repository semantics get an explicit integration-test budget. The
  // public entry point's fixed 1.5-second budget is covered in baseline-budget.
  const budgetMs = 10_000, started = performance.now();
  const observed = await observeGitBaseline(await realpath(root), { executable }, started + budgetMs);
  const elapsedMs = performance.now() - started;
  expect(observed, JSON.stringify({ observed, elapsedMs, budgetMs })).toEqual({ commit, working_tree_state: state });
}
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
    await expectSemanticBaseline(root, "clean", commit);
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

function nativeGit(root: string, args: readonly string[]): string {
  return execFileSync(executable, ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: root,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0" } });
}
async function semanticFixture(format: "sha1" | "sha256" = "sha1") {
  const base = await mkdtemp(join(tmpdir(), "runmesh-git-semantics-")), root = join(base, "workspace");
  await mkdir(root); nativeGit(root, ["init", "--initial-branch=main", `--object-format=${format}`]);
  nativeGit(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "note.txt"), "first\nsecond\n");
  nativeGit(root, ["add", "."]);
  nativeGit(root, ["-c", "user.name=Semantic Fixture", "-c", "user.email=semantic@example.test", "-c", "commit.gpgSign=false", "commit", "-m", "Initial"]);
  const service = new GitService(new PathPolicy([{ workspaceId: "semantics", rootPath: await realpath(root), readonly: true, shell: false }]), { executable });
  const input = { workspace_id: "semantics" };
  const status = () => parseStatus(Buffer.from(nativeGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]))).entries;
  const diff = (staged = false) => nativeGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(staged ? ["--cached"] : [])]);
  return { base, root, service, input, status, diff,
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

describe("isolated Git preserves repository data semantics", () => {
  it.each(["sha1", "sha256"] as const)("reads real shallow %s history with its local boundary", async format => {
    const f = await semanticFixture(format);
    try {
      await writeFile(join(f.root, "note.txt"), "second commit\n");
      nativeGit(f.root, ["add", "."]);
      nativeGit(f.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-m", "Second"]);
      expect((await f.service.log(f.input)).commits).toHaveLength(2);
      const root = join(f.base, "shallow");
      nativeGit(f.base, ["clone", "--no-local", "--depth=1", f.root, root]);
      const service = new GitService(new PathPolicy([{ workspaceId: "shallow", rootPath: await realpath(root), readonly: true, shell: false }]), { executable });
      const oid = nativeGit(root, ["log", "--format=%H"]).trim();
      const before = await readFile(join(root, ".git", "shallow"));
      expect(await service.log({ workspace_id: "shallow" })).toMatchObject({ commits: [{ oid, subject: "Second" }], truncated: false });
      await expectSemanticBaseline(root, "clean", oid);
      expect(await readFile(join(root, ".git", "shallow"))).toEqual(before);
    } finally { await f.cleanup(); }
  });

  it.each(["sha1", "sha256"] as const)("preserves %s split indexes in versions 2, 3 and 4", async format => {
    const f = await semanticFixture(format);
    try {
      await writeFile(join(f.root, "flagged.txt"), "extended flag fixture\n"); nativeGit(f.root, ["add", "."]);
      nativeGit(f.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-m", "Flagged fixture"]);
      for (const version of [2, 3, 4]) {
        if (version === 3) nativeGit(f.root, ["update-index", "--skip-worktree", "flagged.txt"]);
        if (version === 4) nativeGit(f.root, ["update-index", "--no-skip-worktree", "flagged.txt"]);
        nativeGit(f.root, ["update-index", "--no-split-index", `--index-version=${version}`]);
        nativeGit(f.root, ["update-index", "--split-index"]);
        const index = await readFile(join(f.root, ".git", "index"));
        // Git can put every extended entry in the shared v3 file and write a
        // v2 overlay. Verify the referenced file rather than the requested flag.
        expect(version === 3 ? [2, 3] : [version]).toContain(index.readUInt32BE(4));
        const shared = nativeGit(f.root, ["rev-parse", "--shared-index-path"]).trim();
        expect((await readFile(join(f.root, shared))).readUInt32BE(4)).toBe(version);
        expect((await f.service.status(f.input)).entries).toEqual(f.status());
        // A v3 skip-worktree fixture deliberately hides a tracked path. The
        // baseline contract reports unknown until that flag is cleared in v4.
        await expectSemanticBaseline(f.root, version === 3 ? "unknown" : "clean");
        await writeFile(join(f.root, "note.txt"), "other\nsecond\n");
        const indexInfo = await lstat(join(f.root, ".git", "index"));
        await utimes(join(f.root, "note.txt"), indexInfo.atime, indexInfo.mtime);
        expect((await f.service.status(f.input)).entries).toEqual(f.status());
        await expectSemanticBaseline(f.root, version === 3 ? "unknown" : "dirty");
        expect((await f.service.diff(f.input)).diff).toBe(f.diff());
        expect(await readFile(join(f.root, ".git", "index"))).toEqual(index);
        await writeFile(join(f.root, "note.txt"), "first\nsecond\n");
      }
    } finally { await f.cleanup(); }
  });

  it("projects only the referenced shared index and keeps extended/path-compressed entries", async () => {
    const f = await semanticFixture();
    try {
      for (const name of ["common-prefix-one.txt", "common-prefix-two.txt"]) await writeFile(join(f.root, name), "staged\n");
      nativeGit(f.root, ["add", "."]);
      nativeGit(f.root, ["config", "core.splitIndex", "true"]);
      nativeGit(f.root, ["update-index", "--index-version=4", "--split-index"]);
      await writeFile(join(f.root, "intent.txt"), "intent\n"); nativeGit(f.root, ["add", "-N", "intent.txt"]);
      const extra = "sharedindex." + "0".repeat(40); await writeFile(join(f.root, ".git", extra), "unreferenced data\n");
      const context = await createIsolatedGitContext(f.root);
      try {
        const projected = (await readdir(context.directory)).filter(name => name.startsWith("sharedindex."));
        expect(projected).toHaveLength(1); expect(projected).not.toContain(extra);
      } finally { await context.cleanup(); }
      expect((await f.service.status(f.input)).entries).toEqual(f.status());
      expect((await f.service.diff({ ...f.input, staged: true })).diff).toBe(f.diff(true));
    } finally { await f.cleanup(); }
  });

  it.each(["missing", "checksum", "oversized"])("rejects a %s referenced shared index", async fault => {
    const f = await semanticFixture();
    try {
      nativeGit(f.root, ["update-index", "--split-index"]);
      const name = (await readdir(join(f.root, ".git"))).find(name => name.startsWith("sharedindex."))!;
      const path = join(f.root, ".git", name);
      if (fault === "missing") await rm(path);
      else if (fault === "oversized") await truncate(path, MAX_GIT_METADATA_BYTES + 1);
      else { const bytes = await readFile(path); bytes[20] = bytes[20]! ^ 1; await writeFile(path, bytes); }
      await expect(f.service.status(f.input)).rejects.toMatchObject({ code: "git_unavailable" });
      await expectSemanticBaseline(f.root, "unknown", null);
    } finally { await f.cleanup(); }
  });

  it.each(["invalid hash\n", "0".repeat(40) + "\n\n", "a".repeat(64) + "\n"])("rejects a malformed shallow boundary %j", async shallow => {
    const f = await semanticFixture();
    try {
      await writeFile(join(f.root, ".git", "shallow"), shallow);
      await expect(f.service.log(f.input)).rejects.toMatchObject({ code: "git_unavailable" });
    } finally { await f.cleanup(); }
  });

  it("matches native ignores, negation, untracked files and the clean baseline without writing source metadata", async () => {
    const f = await semanticFixture();
    try {
      await writeFile(join(f.root, ".gitignore"), "*.generated\n");
      nativeGit(f.root, ["add", ".gitignore"]);
      nativeGit(f.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-m", "Ignores"]);
      const exclude = Buffer.from("# Local rules\r\nprivate-local.txt\r\nspace file.txt\r\n*.cache\r\n!important.cache\r\n");
      await writeFile(join(f.root, ".git", "info", "exclude"), exclude);
      for (const path of ["private-local.txt", "space file.txt", "local.cache", "build.generated"]) await writeFile(join(f.root, path), "ignored\n");
      const index = await readFile(join(f.root, ".git", "index"));
      expect(f.status()).toEqual([]);
      expect(await f.service.status(f.input)).toMatchObject({ entries: [] });
      await expectSemanticBaseline(f.root, "clean");
      await writeFile(join(f.root, "important.cache"), "included\n"); await writeFile(join(f.root, "new.txt"), "untracked\n");
      expect((await f.service.status(f.input)).entries).toEqual(f.status());
      await expectSemanticBaseline(f.root, "dirty");
      expect((await f.service.diff(f.input)).diff).toBe(f.diff());
      expect(await readFile(join(f.root, ".git", "info", "exclude"))).toEqual(exclude);
      expect(await readFile(join(f.root, ".git", "index"))).toEqual(index);
    } finally { await f.cleanup(); }
  });

  it.each([
    ["autocrlf", "true", false], ["autocrlf", "input", false], ["eol", "crlf", true], ["eol", "lf", true],
  ] as const)("matches native %s=%s for CRLF, real edits and staged/unstaged changes", async (key, value, attributes) => {
    const f = await semanticFixture();
    try {
      nativeGit(f.root, ["config", "core." + key, value]);
      if (attributes) await writeFile(join(f.root, ".gitattributes"), "*.txt text\n");
      await writeFile(join(f.root, "note.txt"), "first\r\nsecond\r\n");
      expect(f.diff()).toBe(""); expect((await f.service.diff(f.input)).diff).toBe("");
      expect((await f.service.status(f.input)).entries).toEqual(f.status());
      await writeFile(join(f.root, "note.txt"), "first changed\r\nsecond\r\n");
      expect(f.diff()).toContain("+first changed"); expect((await f.service.diff(f.input)).diff).toBe(f.diff());
      nativeGit(f.root, ["add", "note.txt"]);
      await writeFile(join(f.root, "note.txt"), "first changed\r\nsecond changed\r\n");
      expect((await f.service.diff({ ...f.input, staged: true })).diff).toBe(f.diff(true));
      expect((await f.service.diff(f.input)).diff).toBe(f.diff());
      expect((await f.service.status(f.input)).entries).toEqual(f.status());
    } finally { await f.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("uses the repository's filemode setting instead of the host default", async () => {
    const f = await semanticFixture();
    try {
      await chmod(join(f.root, "note.txt"), 0o755);
      for (const value of ["false", "true"]) {
        nativeGit(f.root, ["config", "core.filemode", value]);
        expect((await f.service.status(f.input)).entries).toEqual(f.status());
        expect((await f.service.diff(f.input)).diff).toBe(f.diff());
      }
    } finally { await f.cleanup(); }
  });

  it("leaves include, hooks, filter, fsmonitor and textconv configuration inert", async () => {
    const f = await semanticFixture();
    try {
      const marker = join(f.base, "executed"), helper = join(f.base, "helper.cjs"), included = join(f.base, "included.config");
      await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
      const command = `"${process.execPath.replaceAll("\\", "/")}" "${helper.replaceAll("\\", "/")}"`;
      for (const key of ["core.fsmonitor", "filter.spy.clean", "filter.spy.smudge", "filter.spy.process", "diff.spy.textconv", "diff.external"]) nativeGit(f.root, ["config", key, command]);
      nativeGit(f.root, ["config", "core.hooksPath", f.base]);
      nativeGit(f.root, ["config", "core.autocrlf", "true"]);
      await writeFile(included, "[core]\n eol = unsupported-fixture-value\n");
      nativeGit(f.root, ["config", "include.path", included]);
      await writeFile(join(f.root, ".gitattributes"), "*.txt filter=spy diff=spy\n");
      await writeFile(join(f.root, "note.txt"), "changed\r\n");
      const context = await createIsolatedGitContext(f.root);
      try {
        const projected = await readFile(join(context.directory, "config"), "utf8");
        expect(projected).toContain("autocrlf = true");
        expect(projected).not.toMatch(/include|hooks|fsmonitor|filter|textconv|external|unsupported/iu);
      } finally { await context.cleanup(); }
      await expect(f.service.status(f.input)).resolves.toMatchObject({ truncated: false });
      await expect(f.service.diff(f.input)).resolves.toMatchObject({ truncated: false });
      expect(existsSync(marker)).toBe(false);
    } finally { await f.cleanup(); }
  });

  it.each(["config", "info/exclude"])("rejects oversized %s metadata instead of silently changing inspection semantics", async path => {
    const f = await semanticFixture();
    try {
      const metadata = join(f.root, ".git", path); await writeFile(metadata, ""); await truncate(metadata, MAX_GIT_METADATA_BYTES + 1);
      await expect(f.service.status(f.input)).rejects.toMatchObject({ code: "git_unavailable" });
      await expectSemanticBaseline(f.root, "unknown", null);
    } finally { await f.cleanup(); }
  });

  it("rejects a linked info directory on every platform", async () => {
    const f = await semanticFixture();
    try {
      const outside = join(f.base, "outside-info"); await mkdir(outside); await writeFile(join(outside, "exclude"), "*\n");
      await rm(join(f.root, ".git", "info"), { recursive: true });
      await symlink(outside, join(f.root, ".git", "info"), process.platform === "win32" ? "junction" : "dir");
      await expect(f.service.status(f.input)).rejects.toMatchObject({ code: "git_unavailable" });
    } finally { await f.cleanup(); }
  });

  it("projects only exact allowlisted sections and matches native Git value syntax", async () => {
    const text = '[CoRe]\n AutoCRLF = "in"\\\nput # comment\n eol = "crlf"\n filemode\n ignorecase = off\n symlinks = 0\n precomposeunicode = yes\n'
      + '[core "subsection"]\n autocrlf = false\n[other]\n objectFormat = sha256\n[alias]\n x = "[core]\\n autocrlf=false"\n';
    const base = await mkdtemp(join(tmpdir(), "runmesh-git-config-")), source = join(base, "source.config");
    try {
      await writeFile(source, text);
      expect(nativeGit(base, ["config", "--no-includes", "--file", source, "--get", "core.autocrlf"]).trim()).toBe("input");
      expect(nativeGit(base, ["config", "--no-includes", "--file", source, "--type=bool", "--get", "core.filemode"]).trim()).toBe("true");
      expect(nativeGit(base, ["config", "--no-includes", "--file", source, "--type=bool", "--get", "core.ignorecase"]).trim()).toBe("false");
    } finally { await rm(base, { recursive: true, force: true }); }
    const config = isolatedGitConfig(text, false);
    expect(config).toContain("autocrlf = input"); expect(config).toContain("eol = crlf");
    expect(config).toContain("filemode = true"); expect(config).toContain("ignorecase = false");
    expect(config).toContain("symlinks = 0"); expect(config).toContain("precomposeunicode = true");
    expect(config).not.toContain("sha256");
    expect(isolatedGitConfig("[core]\n autocrlf=true\n autocrlf=false\n[extensions]\n objectformat=sha256\n", false)).toContain("autocrlf = false");
    expect(isolatedGitConfig("[extensions]\n objectformat=sha256\n", false)).toContain("objectFormat = sha256");
  });

  it.each(["filemode", "autocrlf"])("matches native Git's integer boolean bases, units and range boundaries for core.%s", async key => {
    const base = await mkdtemp(join(tmpdir(), "runmesh-git-config-bool-")), source = join(base, "source.config"), projected = join(base, "projected.config");
    const readBoolean = (file: string) => {
      try { return { code: 0, value: nativeGit(base, ["config", "--no-includes", "--file", file, "--type=bool", "--get", "core." + key]).trim() }; }
      catch (error) {
        if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 128) throw error;
        return { code: 128, value: "" };
      }
    };
    try {
      for (const value of ["0x0", "0x1", "00", "01", "-1", "+1", "1k", "0x1K", "01m", "0G", "-1g", "2147483647", '"\\t1"', '"\\n1"']) {
        const text = `[core]\n ${key}=${value}\n`; await writeFile(source, text); await writeFile(projected, isolatedGitConfig(text, false));
        const native = readBoolean(source);
        expect(native.code).toBe(0); expect(readBoolean(projected)).toEqual(native);
      }
      // Git/libc versions differ on INT_MIN and binary integer prefixes. Both
      // views must use the installed Git's result, including its config error.
      for (const [value, boolean] of [["-2g", "true"], ["-2147483648", "true"], ["-0x80000000", "true"], ["0b1", "true"], ["0b0", "false"], ["-0B1k", "true"]]) {
        const text = `[core]\n ${key}=${value}\n`; await writeFile(source, text); await writeFile(projected, isolatedGitConfig(text, false));
        const native = readBoolean(source);
        expect(native.value).toBe(native.code === 0 ? boolean : ""); expect(readBoolean(projected)).toEqual(native);
      }
      for (const value of ["08", "0b2", "1kb", "2g", "2147483648", "-2147483649", '"1 "']) {
        const text = `[core]\n ${key}=${value}\n`; await writeFile(source, text);
        expect(readBoolean(source)).toEqual({ code: 128, value: "" });
        expect(() => isolatedGitConfig(text, false)).toThrow();
      }
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("preserves the installed Git's integer-boundary acceptance or rejection in status and baseline", async () => {
    const f = await semanticFixture();
    try {
      nativeGit(f.root, ["config", "core.filemode", "-2g"]);
      let native: ReturnType<typeof f.status> | undefined;
      try { native = f.status(); }
      catch (error) { expect(error).toMatchObject({ status: 128 }); }
      if (native === undefined) {
        await expect(f.service.status(f.input)).rejects.toMatchObject({ code: "git_failed", message: expect.stringMatching(/^git status failed:/u) });
        await expectSemanticBaseline(f.root, "unknown", null);
      } else {
        expect((await f.service.status(f.input)).entries).toEqual(native);
        await expectSemanticBaseline(f.root, "clean");
      }
    } finally { await f.cleanup(); }
  });

  it.each(['[core]\n eol=unknown\n', '[core]\n autocrlf=" true "\n', '[core]\n filemode=maybe\n', '[core]\n eol="crlf\n', '[core]\n eol=crlf\0'])
    ("rejects invalid allowlisted config values %j", text => { expect(() => isolatedGitConfig(text, false)).toThrow(); });
});
