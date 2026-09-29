import { git, withIsolatedGit } from "./execution.js";
import type { GitServiceOptions } from "./public-contracts.js";
import { completeNulRecords, parseStatus } from "./projection.js";
import { literalPathspec } from "./values.js";

/** A sampled baseline, not a transaction over the live working tree. */
export async function observeGitBaseline(root: string, options: GitServiceOptions, deadline: number): Promise<{ commit: string | null; working_tree_state: "clean" | "dirty" | "unknown" }> {
  let commit: string | null = null;
  const unknown = () => ({ commit, working_tree_state: "unknown" as const });
  try {
    if (performance.now() >= deadline) return unknown();
    return await withIsolatedGit(root, options, deadline, async run => {
      // Porcelain supplies the commit and status from the same snapshot.
      const status = await run(["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", literalPathspec(".")], 32 * 1024);
      const complete = completeNulRecords(status.stdout);
      const parsed = parseStatus(complete.output);
      const oid = parsed.branch.oid;
      if (typeof oid !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(oid)) return unknown();
      commit = oid;
      if (status.status !== 0 || status.truncated || status.timedOut || complete.truncated || parsed.truncated || performance.now() >= deadline) return unknown();

      // Status may hide changes behind index flags. Inspect the SAME index:
      // a concurrent writer can clear those flags after status has finished.
      const flags = await run(["ls-files", "-v", "-z", "--cached", "--", literalPathspec(".")], 64 * 1024);
      const records = flags.stdout.toString("utf8").split("\0");
      const terminated = records.pop() === "";
      if (flags.status !== 0 || flags.truncated || flags.timedOut || !terminated || records.some(record => !record.startsWith("H ")) || performance.now() >= deadline) return unknown();

      // Recreate the isolated context to observe the live HEAD again. Reusing
      // the first snapshot here would conceal a concurrent commit change.
      const after = await git(root, ["rev-parse", "--verify", "HEAD"], 128, options, deadline);
      const latest = after.stdout.toString("utf8").trim();
      if (after.status !== 0 || after.truncated || after.timedOut || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(latest)) return unknown();
      const changed = latest !== commit;
      commit = latest;
      if (changed || performance.now() >= deadline) return unknown();
      return { commit, working_tree_state: parsed.entries.length === 0 ? "clean" : "dirty" };
    });
  } catch { return unknown(); }
}
