import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_CURRENT_VERSION, encodeWireFrame } from "@aloneio/runmesh-protocol";
import { describe, expect, it } from "vitest";
import { GitService } from "../src/git-service.js";
import { PatchService } from "../src/patch-service.js";
import { PathPolicy } from "../src/path-policy.js";
import { RunnerRuntime } from "../src/runtime.js";
import type { WorkspaceConfig } from "../src/config.js";

async function fixture(readonly = false): Promise<{ readonly root: string; readonly outside: string; readonly workspace: WorkspaceConfig; readonly cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "runner-patch-"));
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(root); await mkdir(outside);
  return {
    root,
    outside,
    workspace: { workspaceId: "workspace-1", rootPath: await realpath(root), readonly, shell: false },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
function patch(workspace: WorkspaceConfig, options: ConstructorParameters<typeof PatchService>[1] = {}): PatchService {
  return new PatchService(new PathPolicy([workspace]), options);
}
function envelope(body: string): string { return `*** Begin Patch\n${body}\n*** End Patch\n`; }
async function run(root: string, args: readonly string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", [...args], { cwd: root, shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`)));
  });
}
async function patchArtifacts(root: string): Promise<readonly string[]> {
  return (await readdir(root)).filter((entry) => entry.includes(".remote-coding-runtime-") && (entry.endsWith(".tmp") || entry.endsWith(".bak")));
}

describe("fs.apply_patch", () => {
  it("atomically adds, updates, deletes, and moves multiple files", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "update.txt"), "before\nkeep\n");
      await writeFile(join(test.root, "delete.txt"), "remove\n");
      await writeFile(join(test.root, "move.txt"), "move\n");
      const result = await patch(test.workspace).apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@\n-before\n+after\n keep\n*** Delete File: delete.txt\n*** Move File: move.txt\n*** Move to: moved.txt") });
      expect((result.changed_paths as { path: string }[]).map((change) => change.path).sort()).toEqual(["add.txt", "delete.txt", "move.txt", "moved.txt", "update.txt"]);
      await expect(readFile(join(test.root, "add.txt"), "utf8")).resolves.toBe("added\n");
      await expect(readFile(join(test.root, "update.txt"), "utf8")).resolves.toBe("after\nkeep\n");
      await expect(readFile(join(test.root, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(test.root, "moved.txt"), "utf8")).resolves.toBe("move\n");
    } finally { await test.cleanup(); }
  });

  it("enforces caller hashes and detects a concurrent baseline change", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "note.txt"), "old\n");
      const service = patch(test.workspace);
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, expected_hash: "0".repeat(64), patch: envelope("*** Update File: note.txt\n@@\n-old\n+new") })).rejects.toMatchObject({ code: "expected_hash_mismatch" });
      const concurrent = patch(test.workspace, { beforeCommit: () => writeFile(join(test.root, "note.txt"), "race\n") });
      await expect(concurrent.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: note.txt\n@@\n-old\n+new") })).rejects.toMatchObject({ code: "baseline_changed" });
      await expect(readFile(join(test.root, "note.txt"), "utf8")).resolves.toBe("race\n");
    } finally { await test.cleanup(); }
  });

  it("rejects missing, ambiguous, and overlapping hunk context before writing", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "note.txt"), "same\nsame\nother\n");
      const service = patch(test.workspace);
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: note.txt\n@@\n-missing\n+new") })).rejects.toMatchObject({ code: "hunk_not_found" });
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: note.txt\n@@\n-same\n+new") })).rejects.toMatchObject({ code: "hunk_ambiguous" });
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: note.txt\n@@\n-same\n-same\n+first\n@@\n-same\n-other\n+second") })).rejects.toMatchObject({ code: "hunk_overlap" });
      await expect(readFile(join(test.root, "note.txt"), "utf8")).resolves.toBe("same\nsame\nother\n");
    } finally { await test.cleanup(); }
  });

  it("rolls back all installed paths when an install fails", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "one.txt"), "one\n");
      await writeFile(join(test.root, "two.txt"), "two\n");
      let installs = 0;
      const service = patch(test.workspace, { beforeInstall: () => { installs += 1; if (installs === 2) throw new Error("injected install failure"); } });
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: one.txt\n@@\n-one\n+ONE\n*** Update File: two.txt\n@@\n-two\n+TWO") })).rejects.toMatchObject({ code: "patch_install_failed" });
      await expect(readFile(join(test.root, "one.txt"), "utf8")).resolves.toBe("one\n");
      await expect(readFile(join(test.root, "two.txt"), "utf8")).resolves.toBe("two\n");
    } finally { await test.cleanup(); }
  });

  it("preserves UTF-8 BOM, CRLF newlines, and modes for updates and moves", async () => {
    const test = await fixture();
    try {
      const source = join(test.root, "bom.txt");
      await writeFile(source, Buffer.from("\ufeffold\r\nkeep\r\n", "utf8"));
      await chmod(source, 0o751);
      await patch(test.workspace).apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: bom.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n keep") });
      expect(await readFile(join(test.root, "moved.txt"))).toEqual(Buffer.from("\ufeffnew\r\nkeep\r\n", "utf8"));
      if (process.platform !== "win32") expect((await stat(join(test.root, "moved.txt"))).mode & 0o777).toBe(0o751);
    } finally { await test.cleanup(); }
  });

  it("rejects conflicting chained operations, enforces destination parents, caps baselines, and leaves no artifacts", async () => {
    const test = await fixture();
    try {
      await writeFile(join(test.root, "source.txt"), "source\n");
      const service = patch(test.workspace);
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Add File: created.txt\n+one\n*** Update File: created.txt\n@@\n-one\n+two") })).rejects.toMatchObject({ code: "invalid_patch" });
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Move File: source.txt\n*** Move to: middle.txt\n*** Move File: middle.txt\n*** Move to: end.txt") })).rejects.toMatchObject({ code: "invalid_patch" });
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Add File: missing/new.txt\n+no") })).rejects.toMatchObject({ code: "invalid_path" });
      await writeFile(join(test.root, "large.txt"), Buffer.alloc(4 * 1_024 * 1_024 + 1));
      await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Delete File: large.txt") })).rejects.toMatchObject({ code: "file_too_large" });
      await expect(patchArtifacts(test.root)).resolves.toEqual([]);
    } finally { await test.cleanup(); }
  });

  it("rejects concurrent creation and retains/report backup recovery warnings", async () => {
    const test = await fixture();
    try {
      let backupPath = "";
      const concurrent = patch(test.workspace, {
        beforeInstall: async (path) => {
          if (path === "new.txt") await writeFile(join(test.root, path), "external\n");
        },
      });
      await expect(concurrent.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Add File: new.txt\n+patch") })).rejects.toMatchObject({ code: "patch_install_failed" });
      await expect(readFile(join(test.root, "new.txt"), "utf8")).resolves.toBe("external\n");
      await writeFile(join(test.root, "old.txt"), "old\n");
      const warned = patch(test.workspace, {
        beforeBackupCleanup: (backup) => { backupPath = backup; throw new Error("injected cleanup failure"); },
      });
      const result = await warned.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Update File: old.txt\n@@\n-old\n+new") });
      expect(result).toMatchObject({ warnings: [{ path: "old.txt", backup_path: backupPath }] });
      expect(await readFile(backupPath, "utf8")).toBe("old\n");
      await rm(backupPath, { force: true });
      await expect(patchArtifacts(test.root)).resolves.toEqual([]);
    } finally { await test.cleanup(); }
  });

  it("bounds patch operation and hunk parsing", async () => {
    const test = await fixture();
    try {
      const operations = Array.from({ length: 129 }, (_, index) => `*** Add File: cap-${index}.txt\n+x`).join("\n");
      await expect(patch(test.workspace).apply({ workspace_id: test.workspace.workspaceId, patch: envelope(operations) })).rejects.toMatchObject({ code: "invalid_patch" });
      await writeFile(join(test.root, "note.txt"), "base\n");
      const hunks = Array.from({ length: 513 }, () => "@@\n-base\n+next").join("\n");
      await expect(patch(test.workspace).apply({ workspace_id: test.workspace.workspaceId, patch: envelope(`*** Update File: note.txt\n${hunks}`) })).rejects.toMatchObject({ code: "invalid_patch" });
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("rejects traversal, absolute, symlink, and readonly patch targets", async () => {
    const test = await fixture();
    try {
      await symlink(test.outside, join(test.root, "escape"));
      const service = patch(test.workspace);
      for (const target of ["../outside.txt", "/tmp/outside.txt", "escape/outside.txt"]) {
        await expect(service.apply({ workspace_id: test.workspace.workspaceId, patch: envelope(`*** Add File: ${target}\n+x`) })).rejects.toThrow();
      }
      const readonly = patch({ ...test.workspace, readonly: true });
      await expect(readonly.apply({ workspace_id: test.workspace.workspaceId, patch: envelope("*** Add File: no.txt\n+x") })).rejects.toMatchObject({ code: "readonly_workspace" });
    } finally { await test.cleanup(); }
  });

  it("keeps fs.patch only as a compatible apply_patch alias", async () => {
    const test = await fixture();
    try {
      const runtime = new RunnerRuntime({ config: { server: "ws://127.0.0.1", token: "0123456789abcdef", runnerId: "runner-1", workspaces: [test.workspace] } });
      await runtime.dispatch("fs.patch", { workspace_id: test.workspace.workspaceId, patch: envelope("*** Add File: alias.txt\n+safe") });
      await expect(readFile(join(test.root, "alias.txt"), "utf8")).resolves.toBe("safe\n");
    } finally { await test.cleanup(); }
  });
});

describe("git inspection", () => {
  it("returns real structured status plus staged and unstaged diffs", async () => {
    const test = await fixture();
    try {
      await run(test.root, ["init"]);
      await run(test.root, ["config", "user.email", "test@example.test"]);
      await run(test.root, ["config", "user.name", "Test"]);
      await writeFile(join(test.root, "tracked.txt"), "old\n");
      await run(test.root, ["add", "tracked.txt"]); await run(test.root, ["commit", "-m", "initial"]);
      await writeFile(join(test.root, "tracked.txt"), "new\n");
      const git = new GitService(new PathPolicy([test.workspace]));
      const status = await git.status({ workspace_id: test.workspace.workspaceId });
      expect(status).toMatchObject({ entries: [{ path: "tracked.txt", worktree_status: "M" }] });
      const unstaged = await git.diff({ workspace_id: test.workspace.workspaceId, path: "tracked.txt" });
      expect(unstaged).toMatchObject({ staged: false, diff: expect.stringContaining("-old") });
      await run(test.root, ["add", "tracked.txt"]);
      const staged = await git.diff({ workspace_id: test.workspace.workspaceId, staged: true, path: "tracked.txt" });
      expect(staged).toMatchObject({ staged: true, diff: expect.stringContaining("+new") });
    } finally { await test.cleanup(); }
  });

  it("scopes status and diff with literal workspace-relative pathspecs", async () => {
    const test = await fixture();
    try {
      await run(test.root, ["init"]);
      await mkdir(join(test.root, "sub"));
      await writeFile(join(test.root, "sub", "tracked.txt"), "old\n");
      await writeFile(join(test.root, "literal[star].txt"), "old\n");
      await run(test.root, ["add", "."]); await run(test.root, ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "initial"]);
      await writeFile(join(test.root, "sub", "tracked.txt"), "new\n");
      await writeFile(join(test.root, "literal[star].txt"), "new\n");
      await rm(join(test.root, "sub", "tracked.txt"));
      const git = new GitService(new PathPolicy([test.workspace]));
      await expect(git.status({ workspace_id: test.workspace.workspaceId, path: "sub" })).resolves.toMatchObject({ path: "sub", entries: [{ path: "sub/tracked.txt", worktree_status: "D" }] });
      await expect(git.status({ workspace_id: test.workspace.workspaceId, path: "literal[star].txt" })).resolves.toMatchObject({ entries: [{ path: "literal[star].txt" }] });
      await expect(git.status({ workspace_id: test.workspace.workspaceId, path: "." })).resolves.toMatchObject({ path: "." });
      await expect(git.diff({ workspace_id: test.workspace.workspaceId, path: "sub/tracked.txt" })).resolves.toMatchObject({ path: "sub/tracked.txt", diff: expect.stringContaining("deleted file") });
    } finally { await test.cleanup(); }
  });

  it("does not return partial porcelain records and emits frame-safe UTF-8 diffs", async () => {
    const test = await fixture();
    try {
      await run(test.root, ["init"]);
      await writeFile(join(test.root, "very-long-untracked-name.txt"), "x");
      const git = new GitService(new PathPolicy([test.workspace]));
      const status = await git.status({ workspace_id: test.workspace.workspaceId, max_bytes: 3 });
      expect(status).toMatchObject({ entries: [], truncated: true });
      await writeFile(join(test.root, "emoji.txt"), "before\n");
      await run(test.root, ["add", "emoji.txt"]); await run(test.root, ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "emoji"]);
      await writeFile(join(test.root, "emoji.txt"), `${"😀 after\n".repeat(500)}`);
      const diff = await git.diff({ workspace_id: test.workspace.workspaceId, path: "emoji.txt", max_bytes: 513 });
      expect(diff).toMatchObject({ truncated: true });
      expect((diff.diff as string).includes("\ufffd")).toBe(false);
      expect(() => encodeWireFrame({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "result", result: diff })).not.toThrow();
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("times out a spawned git process through the injectable timeout seam", async () => {
    const test = await fixture();
    try {
      await run(test.root, ["init"]);
      const executable = join(test.root, "slow-git.sh");
      await writeFile(executable, "#!/bin/sh\nsleep 5\n");
      await chmod(executable, 0o755);
      const git = new GitService(new PathPolicy([test.workspace]), { executable, timeoutMs: 30, killGraceMs: 20, hardKillMs: 50 });
      await expect(git.status({ workspace_id: test.workspace.workspaceId })).rejects.toMatchObject({ code: "git_timeout" });
    } finally { await test.cleanup(); }
  });
  it("bounds a large git diff and marks it truncated", async () => {
    const test = await fixture();
    try {
      await run(test.root, ["init"]);
      await writeFile(join(test.root, "large.txt"), `${"before\n".repeat(2_000)}`);
      await run(test.root, ["add", "large.txt"]); await run(test.root, ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "initial"]);
      await writeFile(join(test.root, "large.txt"), `${"after\n".repeat(2_000)}`);
      const result = await new GitService(new PathPolicy([test.workspace])).diff({ workspace_id: test.workspace.workspaceId, max_bytes: 512 });
      expect(result).toMatchObject({ truncated: true });
      expect((result.diff as string).length).toBeLessThanOrEqual(512);
    } finally { await test.cleanup(); }
  });
});
