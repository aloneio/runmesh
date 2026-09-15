import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";

it.each(["--assume-unchanged", "--skip-worktree"])("R05 does not certify a clean baseline when the index hides changes with %s", async flag => {
  const root = await mkdtemp(join(tmpdir(), "baseline-index-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git(["init"]); git(["config", "user.name", "Fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, "hidden.txt"), "before\n"); git(["add", "hidden.txt"]); git(["commit", "-m", "baseline"]);
    const executable = process.platform === "win32" ? (process.env.Path ?? process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "git.exe")).find(path => existsSync(path)) : undefined;
    const service = new GitService(new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: true, shell: false }]), executable === undefined ? {} : { executable });
    expect(await service.observeBaseline({ workspace_id: "w" })).toMatchObject({ working_tree_state: "clean" });
    git(["update-index", flag, "hidden.txt"]); await writeFile(join(root, "hidden.txt"), "after\n");
    expect(await service.observeBaseline({ workspace_id: "w" })).toMatchObject({ working_tree_state: "unknown" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("R05 uses a shared observation deadline rather than restarting a full timeout for each query", async () => {
  const service = new GitService(new PathPolicy([]));
  const head = vi.spyOn(service, "head").mockResolvedValue({ workspace_id: "w", commit: "a".repeat(40) });
  const status = vi.spyOn(service, "status").mockResolvedValue({ entries: [], truncated: false });
  const now = vi.spyOn(performance, "now");
  now.mockReturnValueOnce(100).mockReturnValue(10000);
  try {
    expect(await service.observeBaseline({ workspace_id: "w" })).toMatchObject({ working_tree_state: "unknown" });
    expect(head).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
