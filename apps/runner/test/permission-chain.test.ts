import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { RunnerRuntime } from "../src/runtime.js";
const full = { read: true, edit: true, shell: true, job_control: true };
const ro = { read: true, edit: false, shell: false, job_control: false };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "auth-runner-"))); await mkdir(join(root, "workspace"));
  const workspace = { workspaceId: "w", rootPath: join(root, "workspace"), readonly: false, shell: true, permissions: full };
  const runtime = new RunnerRuntime({ config: { runnerId: "r", server: "wss://unused.invalid", token: "synthetic", workspaces: [workspace] }, stateDir: join(root, "state") });
  await runtime.jobs.initialize();
  return { root, workspace, runtime, cleanup: async () => { for (const j of runtime.jobs.list()) { if (["queued", "running", "cancelling"].includes(j.status)) await runtime.jobs.cancel(j.job_id); } await runtime.jobs.flushPersistence(); await new Promise((resolve) => setTimeout(resolve, 60)); await runtime.jobs.flushPersistence(); await rm(root, { recursive: true, force: true }); } };
}
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
it("RUN-AUTH-01 policy revoked after cwd resolution prevents queued process spawn", async () => {
  const f = await fixture(); const resolve = f.runtime.policy.resolve.bind(f.runtime.policy); let switched = false;
  vi.spyOn(f.runtime.policy, "resolve").mockImplementation(async (...args) => {
    const value = await resolve(...args);
    if (args[2] === "cwd" && !switched) { switched = true; f.runtime.applyPolicy([{ ...f.workspace, readonly: true, shell: false, permissions: ro }]); }
    return value;
  });
  try {
    await expect(f.runtime.dispatch("exec.start", { workspace_id: "w", command: [process.execPath, "-e", "require('fs').writeFileSync('unexpected.txt','synthetic')"] })).rejects.toMatchObject({ code: "stale_policy" });
  } finally { await f.cleanup(); }
});
it("RUN-AUTH-02 a stale resolved file cannot be read after workspace read access is revoked", async () => {
  const f = await fixture(); await writeFile(join(f.workspace.rootPath, "private.txt"), "synthetic-secret");
  const resolve = f.runtime.policy.resolve.bind(f.runtime.policy);
  vi.spyOn(f.runtime.policy, "resolve").mockImplementation(async (...args) => {
    const value = await resolve(...args); f.runtime.applyPolicy([{ ...f.workspace, readonly: true, shell: false, permissions: { ...ro, read: false } }]); return value;
  });
  try { await expect(f.runtime.dispatch("fs.read", { workspace_id: "w", path: "private.txt" })).rejects.toMatchObject({ code: "stale_policy" }); }
  finally { await f.cleanup(); }
});
it("RUN-CONTEXT-01 observes the Git baseline and marks old handoff evidence stale after HEAD changes", async () => {
  const f = await fixture();
  try {
    git(f.workspace.rootPath, ["init"]);
    git(f.workspace.rootPath, ["config", "user.email", "test@example.test"]);
    git(f.workspace.rootPath, ["config", "user.name", "Test"]);
    await writeFile(join(f.workspace.rootPath, "note.txt"), "one\n");
    git(f.workspace.rootPath, ["add", "note.txt"]);
    git(f.workspace.rootPath, ["commit", "-m", "one"]);
    const firstCommit = git(f.workspace.rootPath, ["rev-parse", "HEAD"]);

    const checkpoint = await f.runtime.dispatch("context.checkpoint", {
      workspace_id: "w",
      turn_id: "turn-1",
      base_commit: "deadbee",
      goal: "verify the current source baseline",
      missing_checks: [],
    }) as { context: { context_id: string; base_commit: string; base_commit_status: string; baseline_state: string; current_commit: string } };
    expect(checkpoint.context).toMatchObject({ base_commit: firstCommit, base_commit_status: "observed", baseline_state: "current", current_commit: firstCommit });

    await writeFile(join(f.workspace.rootPath, "note.txt"), "two\n");
    git(f.workspace.rootPath, ["add", "note.txt"]);
    git(f.workspace.rootPath, ["commit", "-m", "two"]);
    const secondCommit = git(f.workspace.rootPath, ["rev-parse", "HEAD"]);
    expect(secondCommit).not.toBe(firstCommit);

    const read = await f.runtime.dispatch("context.read", { workspace_id: "w", context_id: checkpoint.context.context_id }) as { context: { base_commit: string; base_commit_status: string; baseline_state: string; current_commit: string } };
    expect(read.context).toMatchObject({ base_commit: firstCommit, base_commit_status: "observed", baseline_state: "stale", current_commit: secondCommit });
  } finally { await f.cleanup(); }
});
