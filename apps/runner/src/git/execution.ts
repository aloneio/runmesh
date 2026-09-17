import type { ChildProcess } from "node:child_process";
import { createIsolatedGitContext } from "./isolated-context.js";
import { GIT_TIMEOUT_MS } from "./limits.js";
import type { GitRun } from "./contracts.js";
import type { GitServiceOptions } from "./contracts.js";
import { HARD_KILL_MS } from "./limits.js";
import { KILL_GRACE_MS } from "./limits.js";
import { positiveTimeout } from "./values.js";
import { RpcRuntimeError } from "../errors.js";
import { spawn } from "node:child_process";
import { trustedWindowsEnvironment } from "../windows-tools.js";
import { trustedWindowsRoot } from "../windows-tools.js";

export async function git(cwd: string, args: readonly string[], cap: number, options: GitServiceOptions, deadline?: number): Promise<GitRun> {
  const context = await createIsolatedGitContext(cwd, deadline);
  if (deadline !== undefined && performance.now() >= deadline) {
    await context.cleanup();
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, signal: null, truncated: true, timedOut: true, timeoutMs: 0 };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? "git", ["-C", cwd, ...args], {
      cwd: context.commandCwd,
      env: context.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX this gives git and all children their own process group, so a
      // hung hook/pager cannot outlive the RPC timeout.
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timeoutMs = Math.min(positiveTimeout(options.timeoutMs, GIT_TIMEOUT_MS), deadline === undefined ? GIT_TIMEOUT_MS : Math.max(1, Math.ceil(deadline - performance.now())));
    const killGraceMs = positiveTimeout(options.killGraceMs, KILL_GRACE_MS);
    const hardKillMs = positiveTimeout(options.hardKillMs, HARD_KILL_MS);
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
    };
    const finish = (run: GitRun): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      void context.cleanup().catch(() => undefined);
      resolve(run);
    };
    const take = (chunks: Buffer[], size: number, chunk: Buffer): number => {
      const allowed = Math.max(0, cap - size);
      if (chunk.byteLength > allowed) {
        if (allowed > 0) chunks.push(chunk.subarray(0, allowed));
        truncated = true;
        return cap;
      }
      chunks.push(chunk);
      return size + chunk.byteLength;
    };
    child.stdout?.on("data", (chunk: Buffer) => { if (!settled) stdoutSize = take(stdout, stdoutSize, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { if (!settled) stderrSize = take(stderr, stderrSize, chunk); });

    const terminate = (signal: NodeJS.Signals): void => signalProcessTree(child, signal);
    termTimer = setTimeout(() => {
      timedOut = true;
      truncated = true;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), killGraceMs);
      hardTimer = setTimeout(() => {
        // `close` waits for all inherited stdio handles. Resolve at a bounded
        // deadline even if a descendant deliberately keeps one open.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status: null, signal: "SIGKILL", truncated, timedOut, timeoutMs });
      }, killGraceMs + hardKillMs);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      clearTimers();
      settled = true;
      void context.cleanup().catch(() => undefined);
      reject(new RpcRuntimeError("git_unavailable", `could not start git: ${error.message.slice(0, 512)}`));
    });
    child.once("close", (status, signal) => {
      finish({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status, signal, truncated, timedOut, timeoutMs });
    });
  });
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill's /T follows the complete child tree. Resolve it through the
    // trusted Windows inbox rather than PATH/current-directory lookup: this
    // path is reached from a timeout handler and may run with elevated rights.
    // Keep the cwd and environment aligned with JobManager's native
    // terminator so a writable caller directory cannot shadow the helper.
    const systemRoot = trustedWindowsRoot();
    const taskkill = spawn(`${systemRoot}\\System32\\taskkill.exe`, ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
      cwd: `${systemRoot}\\System32`,
      env: trustedWindowsEnvironment(systemRoot),
      stdio: "ignore",
      windowsHide: true,
    });
    // The target may exit before taskkill starts. Consume an ENOENT (or any
    // other helper startup failure) because this best-effort path must never
    // surface an unhandled ChildProcess error from a timer callback.
    taskkill.once("error", () => undefined);
    taskkill.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
