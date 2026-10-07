import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { RunnerRuntime } from "../src/runtime.js";
import { GitService } from "../src/git-service.js";
import { observeGitBaseline } from "../src/git/baseline.js";
import { resolveGitPath } from "../src/git/values.js";
import type { GitServiceOptions } from "../src/git/public-contracts.js";
const full = { read: true, edit: true, shell: true, job_control: true };
const ro = { read: true, edit: false, shell: false, job_control: false };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "auth-runner-"))); await mkdir(join(root, "workspace"));
  const workspace = { workspaceId: "w", rootPath: join(root, "workspace"), readonly: false, shell: true, permissions: full };
  const runtime = new RunnerRuntime({ config: { runnerId: "r", server: "wss://unused.invalid", token: "synthetic", workspaces: [workspace] }, stateDir: join(root, "state") });
  let gitOptions: GitServiceOptions = {};
  // Developer hosts can have only portable Git. Native fixtures explicitly
  // select that binary through the existing test seam; production inspection
  // still refuses to execute an untrusted PATH entry.
  if (process.platform === "win32") {
    const executable = (process.env.Path ?? process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "git.exe")).find(path => existsSync(path));
    if (executable !== undefined) {
      gitOptions = { executable };
      const inspector = new GitService(runtime.policy, gitOptions);
      vi.spyOn(runtime.git, "observeBaseline").mockImplementation(input => inspector.observeBaseline(input));
    }
  }
  await runtime.jobs.initialize();
  return { root, workspace, runtime, gitOptions, cleanup: async () => { for (const j of runtime.jobs.list()) { if (["queued", "running", "cancelling"].includes(j.status)) await runtime.jobs.cancel(j.job_id); } await runtime.jobs.flushPersistence(); await new Promise((resolve) => setTimeout(resolve, 60)); await runtime.jobs.flushPersistence(); await rm(root, { recursive: true, force: true }); } };
}
function semanticBaseline(f: Awaited<ReturnType<typeof fixture>>) {
  // Exercise real Git and policy resolution with an integration-test budget.
  // Freezing performance.now does not freeze the native process timeout; the
  // public 1.5-second budget is verified independently in baseline-budget.
  const budgetMs = 10_000;
  const observations: { observed: Awaited<ReturnType<typeof observeGitBaseline>>; elapsedMs: number; budgetMs: number }[] = [];
  const spy = vi.spyOn(f.runtime.git, "observeBaseline").mockImplementation(async input => {
    expect(input).toEqual({ workspace_id: f.workspace.workspaceId });
    const started = performance.now();
    const scope = await resolveGitPath(f.runtime.policy, f.workspace.workspaceId, ".");
    const observed = await observeGitBaseline(scope.rootPath, f.gitOptions, started + budgetMs);
    observations.push({ observed, elapsedMs: performance.now() - started, budgetMs });
    return observed;
  });
  return { diagnostics: () => JSON.stringify(observations), restore: () => spy.mockRestore() };
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
  const baseline = semanticBaseline(f);
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
    expect(checkpoint.context, baseline.diagnostics()).toMatchObject({ base_commit: firstCommit, base_commit_status: "observed", baseline_state: "current", current_commit: firstCommit });

    await writeFile(join(f.workspace.rootPath, "note.txt"), "two\n");
    git(f.workspace.rootPath, ["add", "note.txt"]);
    git(f.workspace.rootPath, ["commit", "-m", "two"]);
    const secondCommit = git(f.workspace.rootPath, ["rev-parse", "HEAD"]);
    expect(secondCommit).not.toBe(firstCommit);

    const read = await f.runtime.dispatch("context.read", { workspace_id: "w", context_id: checkpoint.context.context_id }) as { context: { base_commit: string; base_commit_status: string; baseline_state: string; current_commit: string } };
    expect(read.context, baseline.diagnostics()).toMatchObject({ base_commit: firstCommit, base_commit_status: "observed", baseline_state: "stale", current_commit: secondCommit });
  } finally { baseline.restore(); await f.cleanup(); }
});


it.each(["tracked", "untracked"])("R05 does not claim evidence is current after an uncommitted %s change", async (kind) => {
  const f=await fixture();
  const baseline = semanticBaseline(f);
  try {
    git(f.workspace.rootPath,["init"]);git(f.workspace.rootPath,["config","user.name","Fixture"]);git(f.workspace.rootPath,["config","user.email","fixture@example.invalid"]);
    await writeFile(join(f.workspace.rootPath,"tracked.txt"),"one\n");git(f.workspace.rootPath,["add","tracked.txt"]);git(f.workspace.rootPath,["commit","-m","baseline"]);
    const first=await f.runtime.dispatch("context.checkpoint",{workspace_id:"w",turn_id:"dirty",goal:"verify baseline"}) as any;
    expect(first.context.baseline_state, baseline.diagnostics()).toBe("current");
    await writeFile(join(f.workspace.rootPath,kind==="tracked"?"tracked.txt":"new.txt"),"changed\n");
    const next=await f.runtime.dispatch("context.read",{workspace_id:"w",context_id:first.context.context_id}) as any;
    expect(next.context.current_commit, baseline.diagnostics()).toBe(first.context.base_commit);
    expect(next.context.baseline_state, baseline.diagnostics()).toBe("stale");
  } finally {baseline.restore(); await f.cleanup();}
});


it("R04 never commits context after permission changed during evidence collection", async () => {
  const f=await fixture();
  vi.spyOn(f.runtime.git,"observeBaseline").mockImplementation(async()=>{
    f.runtime.applyPolicy([{...f.workspace,permissions:ro,readonly:true,shell:false}]);
    return {commit:"a".repeat(40),working_tree_state:"clean"};
  });
  try {
    await expect(f.runtime.dispatch("context.checkpoint",{workspace_id:"w",turn_id:"revoke",goal:"denied"})).rejects.toMatchObject({code:"stale_policy"});
    expect(await f.runtime.context.bootstrap({workspace_id:"w"})).toMatchObject({state:"missing"});
  } finally {await f.cleanup();}
});
it("R05 unavailable or truncated worktree evidence stays unknown and cannot be forged", async () => {
  const f=await fixture();
  vi.spyOn(f.runtime.git,"observeBaseline").mockResolvedValue({commit:"a".repeat(40),working_tree_state:"unknown"});
  try {
    const result=await f.runtime.dispatch("context.checkpoint",{workspace_id:"w",turn_id:"unknown",goal:"unknown",base_worktree_state:"clean",base_commit_status:"observed"}) as any;
    expect(result.context).toMatchObject({baseline_state:"unknown",base_worktree_state:"unknown",working_tree_state:"unknown"});
  } finally {await f.cleanup();}
});

it("R04 a non-Git workspace deduplicates completed Job evidence when only collection time changes", async () => {
  const f = await fixture();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    // Git isolation starts at this workspace's own .git entry. Its absence
    // returns null/unknown before a Git process or its timeout is involved.
    expect(existsSync(join(f.workspace.rootPath, ".git"))).toBe(false);
    expect(await f.runtime.git.observeBaseline({ workspace_id: "w" })).toEqual({ commit: null, working_tree_state: "unknown" });
    const completed = await f.runtime.dispatch("exec.run", { workspace_id: "w", command: [process.execPath, "-e", "process.stdout.write('observed')"], wait_ms: 5_000 }) as any;
    expect(completed).toMatchObject({ completed: true, job: { status: "succeeded", exit_code: 0 } });
    const input = { workspace_id: "w", turn_id: "observed-job", goal: "retain the completed Job", expected_revision: 0, evidence: [{ kind: "job", job_id: completed.job.job_id }] };
    clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const first = await f.runtime.dispatch("context.checkpoint", input) as any;
    expect(first.context).toMatchObject({ revision: 1, base_commit: null, base_commit_status: null, base_worktree_state: "unknown", evidence: [{ observed_at_ms: 1_000 }] });
    clock.mockReturnValue(2_000);
    const next = await f.runtime.dispatch("context.checkpoint", input) as any;
    expect(next).toMatchObject({ deduplicated: true, context: { revision: 1 } });
    expect(next.context).toEqual(first.context);
  } finally { clock?.mockRestore(); await f.cleanup(); }
});

it.each([
  { name: "commit changes", initial: { commit: "a".repeat(40), working_tree_state: "clean" }, next: { commit: "b".repeat(40), working_tree_state: "clean" } },
  { name: "worktree changes", initial: { commit: "a".repeat(40), working_tree_state: "clean" }, next: { commit: "a".repeat(40), working_tree_state: "dirty" } },
  { name: "worktree observation becomes unknown", initial: { commit: "a".repeat(40), working_tree_state: "clean" }, next: { commit: "a".repeat(40), working_tree_state: "unknown" } },
  { name: "baseline becomes unavailable", initial: { commit: "a".repeat(40), working_tree_state: "clean" }, next: { commit: null, working_tree_state: "unknown" } },
  { name: "baseline becomes available", initial: { commit: null, working_tree_state: "unknown" }, next: { commit: "a".repeat(40), working_tree_state: "clean" } },
] as const)("R04 a repeated expected-revision write conflicts when $name", async ({ initial, next }) => {
  const f = await fixture();
  const baseline = vi.spyOn(f.runtime.git, "observeBaseline").mockResolvedValue(initial);
  try {
    const completed = await f.runtime.dispatch("exec.run", { workspace_id: "w", command: [process.execPath, "-e", "process.stdout.write('observed')"], wait_ms: 5_000 }) as any;
    expect(completed).toMatchObject({ completed: true, job: { status: "succeeded", exit_code: 0 } });
    const input = { workspace_id: "w", turn_id: "baseline-retry", goal: "preserve observed source facts", expected_revision: 0, evidence: [{ kind: "job", job_id: completed.job.job_id }] };
    const first = await f.runtime.dispatch("context.checkpoint", input) as any;
    baseline.mockResolvedValue(next);
    await expect(f.runtime.dispatch("context.checkpoint", input)).rejects.toMatchObject({ code: "context_revision_conflict", details: { expected_revision: 0, actual_revision: 1 } });
    const saved = await f.runtime.context.read({ workspace_id: "w", context_id: first.context.context_id }) as any;
    expect(saved.context).toMatchObject({ revision: 1, fingerprint: first.context.fingerprint, evidence: first.context.evidence, base_commit: initial.commit, base_worktree_state: initial.working_tree_state });
  } finally { baseline.mockRestore(); await f.cleanup(); }
});
