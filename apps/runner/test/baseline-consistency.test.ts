import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it, vi } from "vitest";
import { GitService } from "../src/git-service.js";
import { PathPolicy } from "../src/path-policy.js";

const interleave = vi.hoisted(() => ({ afterStatus: undefined as (() => void) | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn((...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(...args);
    if (Array.isArray(args[1]) && args[1].includes("status")) child.once("close", () => interleave.afterStatus?.());
    return child;
  }) };
});

it.each(["assume-unchanged", "skip-worktree"])("does not combine status and %s flags from different index snapshots", async flag => {
  const root = await mkdtemp(join(tmpdir(), "baseline-consistency-"));
  const raw = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore", windowsHide: true });
  try {
    raw(["init"]); raw(["config", "user.name", "Fixture"]); raw(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, "hidden.txt"), "before\n"); raw(["add", "hidden.txt"]); raw(["commit", "-m", "baseline"]);
    raw(["update-index", `--${flag}`, "hidden.txt"]);
    await writeFile(join(root, "hidden.txt"), "changed\n");
    const executable = process.platform === "win32" ? (process.env.Path ?? process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "git.exe")).find(path => existsSync(path)) : undefined;
    const service = new GitService(new PathPolicy([{ workspaceId: "w", rootPath: root, readonly: true, shell: false }]), executable === undefined ? {} : { executable });
    let changed = false;
    interleave.afterStatus = () => { raw(["update-index", `--no-${flag}`, "hidden.txt"]); changed = true; };
    // Freeze only the scheduling clock for this interleaving regression. The
    // native baseline tests separately enforce the real 1.5-second budget.
    vi.spyOn(performance, "now").mockReturnValue(100);
    expect(await service.observeBaseline({ workspace_id: "w" })).toMatchObject({ working_tree_state: "unknown" });
    expect(changed).toBe(true);
  } finally {
    interleave.afterStatus = undefined; vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
