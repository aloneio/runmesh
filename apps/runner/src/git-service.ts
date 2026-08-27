import { spawn, type ChildProcess } from "node:child_process";
import { relative, sep } from "node:path";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS, MAX_FRAME_BYTES, PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { RpcRuntimeError } from "./errors.js";
import { PathPolicy } from "./path-policy.js";

const DEFAULT_OUTPUT_BYTES = 256 * 1_024;
const MAX_OUTPUT_BYTES = MAX_FRAME_BYTES;
const MAX_REQUEST_ID_BYTES = 128;
const RPC_RESPONSE_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({
  type: "rpc.response",
  protocol_version: PROTOCOL_CURRENT_VERSION,
  request_id: "x".repeat(MAX_REQUEST_ID_BYTES),
  result: null,
}), "utf8");
// Leave room for the wire response envelope even before result-specific JSON
// escaping and metadata are accounted for below.
const MAX_PROCESS_OUTPUT_BYTES = MAX_FRAME_BYTES - RPC_RESPONSE_ENVELOPE_BYTES;
const GIT_TIMEOUT_MS = LOCAL_RUNNER_OPERATION_TIMEOUT_MS;
const KILL_GRACE_MS = 250;
const HARD_KILL_MS = 1_000;

type GitRun = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
};

type StatusEntry = {
  readonly path: string;
  readonly index_status: string;
  readonly worktree_status: string;
  readonly untracked: boolean;
  readonly ignored: boolean;
  readonly original_path?: string;
};
type ParsedStatus = {
  readonly branch: Record<string, unknown>;
  readonly entries: readonly StatusEntry[];
  readonly ahead?: number;
  readonly behind?: number;
  readonly truncated: boolean;
};
type GitPath = {
  readonly rootPath: string;
  readonly relativePath: string;
};

export interface GitServiceOptions {
  /** Test seam for a deliberately slow wrapper around git. */
  readonly executable?: string;
  /** Bound the subprocess lifetime; production defaults to eight seconds. */
  readonly timeoutMs?: number;
  /** Grace period between TERM and KILL when a process does not exit. */
  readonly killGraceMs?: number;
  /** Final bound after KILL so inherited pipes cannot stall the RPC forever. */
  readonly hardKillMs?: number;
}

/** Minimal, bounded git inspection surface. Arguments are fixed by the RPC, never caller supplied. */
export class GitService {
  public constructor(
    private readonly policy: PathPolicy,
    private readonly options: GitServiceOptions = {},
  ) {}

  public async status(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    const scope = await resolveGitPath(this.policy, params.workspace_id, params.path ?? ".");
    const outputLimit = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    const run = await git(
      scope.rootPath,
      ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", literalPathspec(scope.relativePath)],
      outputLimit,
      this.options,
    );
    if (run.status !== 0) throw gitFailure("git status failed", run);

    // Porcelain v2 is NUL-delimited. A capped read can end in the middle of a
    // path (or a rename pair), so parse only complete records.
    const complete = completeNulRecords(run.stdout);
    const parsed = parseStatus(complete.output);
    const baseTruncated = run.truncated || complete.truncated || parsed.truncated;
    const result = fitStatusResult({
      workspaceId: workspace.workspaceId,
      path: scope.relativePath,
      parsed,
      outputBytes: complete.output.byteLength,
      truncated: baseTruncated,
    });
    return result;
  }

  public async diff(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const workspace = this.policy.getWorkspace(params.workspace_id);
    if (params.staged !== undefined && typeof params.staged !== "boolean") {
      throw new RpcRuntimeError("invalid_params", "staged must be a boolean");
    }
    const root = await resolveGitPath(this.policy, params.workspace_id, ".");
    const cap = outputCap(params.max_bytes, DEFAULT_OUTPUT_BYTES);
    const args = ["diff", "--no-ext-diff", "--no-color", "--no-textconv"];
    if (params.staged === true) args.push("--cached");
    let requestedPath: string | undefined;
    if (params.path !== undefined) {
      const target = await resolveGitPath(this.policy, params.workspace_id, params.path);
      requestedPath = target.relativePath;
      args.push("--", literalPathspec(requestedPath));
    }
    const run = await git(root.rootPath, args, cap, this.options);
    // git diff uses 0 for ordinary textual diffs; reserve nonzero for execution errors.
    if (run.status !== 0) throw gitFailure("git diff failed", run);

    // Never turn an otherwise valid UTF-8 diff into a replacement character by
    // clipping a multi-byte character at the process output limit.
    const safeOutput = run.truncated ? utf8SafePrefix(run.stdout) : run.stdout;
    return fitDiffResult({
      workspaceId: workspace.workspaceId,
      ...(requestedPath === undefined ? {} : { requestedPath }),
      staged: params.staged === true,
      output: safeOutput,
      truncated: run.truncated || safeOutput.byteLength !== run.stdout.byteLength,
    });
  }
}

async function resolveGitPath(policy: PathPolicy, workspaceId: unknown, path: unknown): Promise<GitPath> {
  // Do not require a leaf to exist: both `git diff -- path` and `git status --
  // path` are useful for deleted tracked files. PathPolicy still validates the
  // lexical path and every existing ancestor against the workspace boundary.
  const resolved = await policy.resolve(workspaceId, path, "cwd");
  const relativePath = relative(resolved.workspace.rootPath, resolved.path).split(sep).join("/") || ".";
  return { rootPath: resolved.workspace.rootPath, relativePath };
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

async function git(cwd: string, args: readonly string[], cap: number, options: GitServiceOptions): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? "git", [...args], {
      cwd,
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
    const timeoutMs = positiveTimeout(options.timeoutMs, GIT_TIMEOUT_MS);
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
    // taskkill's /T follows the complete child tree. It is best-effort because
    // the process may have already exited before the timeout handler runs.
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
    taskkill.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function completeNulRecords(output: Buffer): { readonly output: Buffer; readonly truncated: boolean } {
  if (output.byteLength === 0 || output[output.byteLength - 1] === 0) return { output, truncated: false };
  const boundary = output.lastIndexOf(0);
  return { output: boundary < 0 ? Buffer.alloc(0) : output.subarray(0, boundary + 1), truncated: true };
}

function parseStatus(output: Buffer): ParsedStatus {
  const branch: Record<string, unknown> = {};
  const entries: StatusEntry[] = [];
  let ahead: number | undefined;
  let behind: number | undefined;
  let truncated = false;
  const records = output.toString("utf8").split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record === "") continue;
    if (record.startsWith("# branch.oid ")) branch.oid = record.slice("# branch.oid ".length);
    else if (record.startsWith("# branch.head ")) branch.head = record.slice("# branch.head ".length);
    else if (record.startsWith("# branch.upstream ")) branch.upstream = record.slice("# branch.upstream ".length);
    else if (record.startsWith("# branch.ab +")) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match !== null) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith("1 ")) {
      const fields = record.split(" ");
      entries.push({ path: fields.slice(8).join(" "), index_status: fields[1]?.[0] ?? "?", worktree_status: fields[1]?.[1] ?? "?", untracked: false, ignored: false });
    } else if (record.startsWith("2 ")) {
      const fields = record.split(" ");
      const originalPath = records[index + 1];
      if (originalPath === undefined || originalPath === "") {
        // A rename consists of two NUL records. Do not expose the first half.
        truncated = true;
        break;
      }
      index += 1;
      entries.push({ path: fields.slice(9).join(" "), index_status: fields[1]?.[0] ?? "?", worktree_status: fields[1]?.[1] ?? "?", untracked: false, ignored: false, original_path: originalPath });
    } else if (record.startsWith("u ")) {
      const fields = record.split(" ");
      entries.push({ path: fields.slice(10).join(" "), index_status: fields[1]?.[0] ?? "?", worktree_status: fields[1]?.[1] ?? "?", untracked: false, ignored: false });
    } else if (record.startsWith("? ")) {
      entries.push({ path: record.slice(2), index_status: "?", worktree_status: "?", untracked: true, ignored: false });
    } else if (record.startsWith("! ")) {
      entries.push({ path: record.slice(2), index_status: "!", worktree_status: "!", untracked: false, ignored: true });
    }
  }
  return { branch, entries, ...(ahead === undefined ? {} : { ahead }), ...(behind === undefined ? {} : { behind }), truncated };
}

function fitStatusResult(input: {
  readonly workspaceId: string;
  readonly path: string;
  readonly parsed: ParsedStatus;
  readonly outputBytes: number;
  readonly truncated: boolean;
}): Record<string, unknown> {
  const entries = [...input.parsed.entries];
  let truncated = input.truncated;
  const result = (): Record<string, unknown> => ({
    workspace_id: input.workspaceId,
    path: input.path,
    branch: input.parsed.branch,
    entries,
    ...(input.parsed.ahead === undefined ? {} : { ahead: input.parsed.ahead }),
    ...(input.parsed.behind === undefined ? {} : { behind: input.parsed.behind }),
    truncated,
    output_bytes: input.outputBytes,
  });
  while (!responseFits(result()) && entries.length > 0) {
    entries.pop();
    truncated = true;
  }
  if (!responseFits(result())) throw new RpcRuntimeError("git_output_too_large", "git status metadata cannot fit in one RPC frame");
  return result();
}

function fitDiffResult(input: {
  readonly workspaceId: string;
  readonly requestedPath?: string;
  readonly staged: boolean;
  readonly output: Buffer;
  readonly truncated: boolean;
}): Record<string, unknown> {
  const resultFor = (output: Buffer, truncated: boolean): Record<string, unknown> => ({
    workspace_id: input.workspaceId,
    ...(input.requestedPath === undefined ? {} : { path: input.requestedPath }),
    staged: input.staged,
    diff: output.toString("utf8"),
    encoding: "utf-8",
    bytes: output.byteLength,
    truncated,
  });
  if (responseFits(resultFor(input.output, input.truncated))) return resultFor(input.output, input.truncated);

  let low = 0;
  let high = input.output.byteLength;
  let best: typeof input.output = input.output.subarray(0, 0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8SafePrefix(input.output.subarray(0, middle));
    if (responseFits(resultFor(candidate, true))) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!responseFits(resultFor(best, true))) throw new RpcRuntimeError("git_output_too_large", "git diff metadata cannot fit in one RPC frame");
  return resultFor(best, true);
}

function responseFits(result: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify({
    type: "rpc.response",
    protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "x".repeat(MAX_REQUEST_ID_BYTES),
    result,
  }), "utf8") <= MAX_FRAME_BYTES;
}

function utf8SafePrefix(output: Buffer): Buffer {
  let candidate = output;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (candidate.byteLength > 0) {
    try {
      decoder.decode(candidate);
      return candidate;
    } catch {
      candidate = candidate.subarray(0, candidate.byteLength - 1);
    }
  }
  return candidate;
}

function outputCap(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_OUTPUT_BYTES) {
    throw new RpcRuntimeError("invalid_params", `max_bytes must be an integer from 1 to ${MAX_OUTPUT_BYTES}`);
  }
  // The per-result fitting below handles JSON escaping. This cap reserves the
  // fixed response envelope before git is spawned, keeping memory bounded.
  return Math.min(value as number, MAX_PROCESS_OUTPUT_BYTES);
}
function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error("invalid GitService timeout option");
  return value;
}
function gitFailure(prefix: string, run: GitRun): RpcRuntimeError {
  // Timeout classification wins even if a killed descendant eventually reports
  // a non-zero status/signal. The configured seam is reflected in the error.
  if (run.timedOut) return new RpcRuntimeError("git_timeout", `${prefix}: command exceeded ${run.timeoutMs}ms timeout`);
  const detail = run.stderr.toString("utf8").trim() || run.stdout.toString("utf8").trim() || run.signal || "unknown git failure";
  return new RpcRuntimeError("git_failed", `${prefix}: ${detail.slice(0, 1_024)}`);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "params must be an object");
  return value as Record<string, unknown>;
}
