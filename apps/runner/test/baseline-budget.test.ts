import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeGitBaseline } from "../src/git/baseline.js";
import type { GitRun } from "../src/git/contracts.js";
import { git, withIsolatedGit } from "../src/git/execution.js";

vi.mock("../src/git/execution.js", () => ({ git: vi.fn(), withIsolatedGit: vi.fn() }));
const commit = "a".repeat(40);
const run = vi.fn<(args: readonly string[], cap: number) => Promise<GitRun>>();
const result = (stdout: string, extra: Partial<GitRun> = {}): GitRun => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), status: 0, signal: null, truncated: false, timedOut: false, timeoutMs: 1500, ...extra });
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(100);
  run.mockResolvedValueOnce(result(`# branch.oid ${commit}\0`)).mockResolvedValueOnce(result("H file.txt\0"));
  vi.mocked(git).mockResolvedValue(result(commit));
  vi.mocked(withIsolatedGit).mockImplementation(async (_root, _options, _deadline, inspect) => inspect(run));
});
afterEach(() => vi.restoreAllMocks());

it("uses status and a fresh HEAD to validate an unchanged baseline", async () => {
  expect(await observeGitBaseline("/workspace", {}, 1500)).toEqual({ commit, working_tree_state: "clean" });
  expect(withIsolatedGit).toHaveBeenCalledTimes(1);
  expect(git).toHaveBeenCalledWith("/workspace", ["rev-parse", "--verify", "HEAD"], 128, {}, 1500);
});
it("does not certify a moving HEAD even when the sampled status is clean", async () => {
  vi.mocked(git).mockResolvedValue(result("b".repeat(40)));
  expect(await observeGitBaseline("/workspace", {}, 1500)).toEqual({ commit: "b".repeat(40), working_tree_state: "unknown" });
});
it("preserves dirty observations and SHA-256 commit identifiers", async () => {
  const oid = "a".repeat(64);
  run.mockReset().mockResolvedValueOnce(result(`# branch.oid ${oid}\0? new.txt\0`)).mockResolvedValueOnce(result("H file.txt\0"));
  vi.mocked(git).mockResolvedValue(result(oid));
  expect(await observeGitBaseline("/workspace", {}, 1500)).toEqual({ commit: oid, working_tree_state: "dirty" });
});
it.each([
  result(`# branch.oid ${commit}\0`, { truncated: true }),
  result(`# branch.oid ${commit}\0`, { timedOut: true }),
  result(`# branch.oid ${commit}\0`, { status: 1 }),
  result(`# branch.oid ${commit}\0? incomplete`),
  result("# branch.oid (initial)\0"),
])("keeps incomplete or unavailable status unknown (%#)", async status => {
  run.mockReset().mockResolvedValueOnce(status);
  expect(await observeGitBaseline("/workspace", {}, 1500)).toMatchObject({ working_tree_state: "unknown" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(git).not.toHaveBeenCalled();
});
it.each([
  result("H file.txt"), result("h file.txt\0"), result("S file.txt\0"),
  result("H file.txt\0", { truncated: true }), result("H file.txt\0", { status: 1 }),
])("does not certify hidden or incomplete index flags (%#)", async flags => {
  run.mockReset().mockResolvedValueOnce(result(`# branch.oid ${commit}\0`)).mockResolvedValueOnce(flags);
  expect(await observeGitBaseline("/workspace", {}, 1500)).toEqual({ commit, working_tree_state: "unknown" });
  expect(git).not.toHaveBeenCalled();
});
it("keeps the shared deadline after status rather than granting the next query a fresh budget", async () => {
  run.mockReset().mockImplementation(async () => {
    vi.mocked(performance.now).mockReturnValue(1500);
    return result(`# branch.oid ${commit}\0`);
  });
  expect(await observeGitBaseline("/workspace", {}, 1500)).toEqual({ commit, working_tree_state: "unknown" });
  expect(run).toHaveBeenCalledTimes(1);
  expect(git).not.toHaveBeenCalled();
});
it("does not create a snapshot after the observation deadline", async () => {
  expect(await observeGitBaseline("/workspace", {}, 100)).toEqual({ commit: null, working_tree_state: "unknown" });
  expect(withIsolatedGit).not.toHaveBeenCalled();
});
it("keeps a failed final observation unknown while retaining the sampled commit", async () => {
  vi.mocked(git).mockRejectedValue(new Error("unavailable"));
  expect(await observeGitBaseline("/workspace", {}, 1500)).toEqual({ commit, working_tree_state: "unknown" });
});
