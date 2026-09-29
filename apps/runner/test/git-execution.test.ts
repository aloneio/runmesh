import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { git, withIsolatedGit } from "../src/git/execution.js";
import { createIsolatedGitContext } from "../src/git/isolated-context.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/git/isolated-context.js", () => ({ createIsolatedGitContext: vi.fn() }));
const cleanup = vi.fn(async () => undefined);
function child(outcome: "close" | "error" = "close"): ChildProcess {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  queueMicrotask(() => {
    if (outcome === "error") process.emit("error", new Error("fixture executable missing"));
    else { process.stdout.emit("data", Buffer.from("result")); process.emit("close", 0, null); }
    process.stdout.destroy(); process.stderr.destroy();
  });
  return process as unknown as ChildProcess;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(performance, "now").mockReturnValue(100);
  cleanup.mockResolvedValue(undefined);
  vi.mocked(createIsolatedGitContext).mockResolvedValue({ directory: "isolated", commandCwd: "trusted", environment: {}, cleanup });
  vi.mocked(spawn).mockImplementation(() => child());
});
afterEach(() => vi.restoreAllMocks());

it.each([{ timeoutMs: 0 }, { timeoutMs: Number.NaN }, { killGraceMs: 0 }, { hardKillMs: 0 }])(
  "rejects invalid process timing before starting an unmanaged child (%j)", async options => {
    await expect(git("workspace", ["status"], 64, options)).rejects.toThrow("invalid GitService timeout option");
    expect(spawn).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  },
);
it("shares one snapshot until all sequential commands finish, then releases it once", async () => {
  const results = await withIsolatedGit("workspace", {}, 1500, async run => {
    const first = await run(["status"], 64);
    expect(cleanup).not.toHaveBeenCalled();
    const second = await run(["ls-files"], 3);
    expect(cleanup).not.toHaveBeenCalled();
    return [first, second];
  });
  expect(results[0]?.stdout.toString()).toBe("result");
  expect(results[1]).toMatchObject({ stdout: Buffer.from("res"), truncated: true });
  expect(createIsolatedGitContext).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
});
it("releases the snapshot when the observation callback fails", async () => {
  await expect(withIsolatedGit("workspace", {}, 1500, async run => {
    await run(["status"], 64);
    throw new Error("observation failed");
  })).rejects.toThrow("observation failed");
  expect(cleanup).toHaveBeenCalledTimes(1);
});
it.each(["synchronous", "asynchronous"])("releases the snapshot after a %s startup failure", async kind => {
  if (kind === "synchronous") vi.mocked(spawn).mockImplementation(() => { throw new Error("invalid executable"); });
  else vi.mocked(spawn).mockImplementation(() => child("error"));
  await expect(git("workspace", ["status"], 64, {})).rejects.toThrow();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
it("does not start a process after snapshot creation consumes the deadline", async () => {
  vi.mocked(performance.now).mockReturnValue(1500);
  expect(await git("workspace", ["status"], 64, {}, 1500)).toMatchObject({ timedOut: true, truncated: true });
  expect(spawn).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
