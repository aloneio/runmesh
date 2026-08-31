import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS, MAX_FRAME_BYTES, PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { RpcRuntimeError } from "./errors.js";
import { PathPolicy } from "./path-policy.js";
import { trustedWindowsEnvironment, trustedWindowsRoot } from "./windows-tools.js";

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

type IsolatedGitContext = {
  readonly directory: string;
  readonly commandCwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<void>;
};

const MAX_GIT_METADATA_BYTES = 4 * 1_024 * 1_024;

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
      // A repository controls its own `.git/config`.  In particular,
      // `core.fsmonitor` can name an arbitrary helper which Git executes
      // during `status`; read-only inspection must not turn into code
      // execution merely because a workspace is untrusted.  Override the
      // setting on the command line (after repository/system config loading)
      // while retaining Git's normal status parsing behavior.
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", literalPathspec(scope.relativePath)],
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
    // `git diff` may refresh the index before producing output; keep the same
    // repository-config execution guard as status (notably for core.fsmonitor).
    const args = ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-color", "--no-textconv"];
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
  const context = await createIsolatedGitContext(cwd);
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

/**
 * Build a throw-away Git directory containing only the current HEAD and
 * index.  A repository's own `.git/config`, hooks, filters, and fsmonitor
 * settings are intentionally not copied.  Git has no command-line switch to
 * ignore only local config, so running against this sanitized directory is
 * the reliable way to keep read-only status/diff from executing repository
 * supplied clean/smudge/process helpers.
 */
async function createIsolatedGitContext(worktree: string): Promise<IsolatedGitContext> {
  let directory: string | undefined;
  try {
    const gitDirectory = await locateGitDirectory(worktree);
    const commonDirectory = await locateCommonDirectory(gitDirectory);
    directory = await mkdtemp(join(tmpdir(), "runmesh-git-"));
    await Promise.all([
      mkdir(join(directory, "hooks"), { recursive: true }),
      mkdir(join(directory, "info"), { recursive: true }),
      mkdir(join(directory, "refs", "heads"), { recursive: true }),
      mkdir(join(directory, "refs", "tags"), { recursive: true }),
      mkdir(join(directory, "objects", "info"), { recursive: true }),
    ]);

    const head = await readRegularText(join(gitDirectory, "HEAD"), 4_096);
    const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)\s*$/u.exec(head.trim());
    const safeHead = head.trim() + "\n";
    if (ref?.[1] !== undefined) {
      const hash = await resolveGitRef(gitDirectory, commonDirectory, ref[1]);
      // A branch without a commit is a valid freshly initialized repository;
      // leave its symbolic HEAD unresolved so Git reports the unborn branch.
      if (hash !== undefined) {
        const refPath = join(directory, ref[1].replaceAll("/", "/"));
        await mkdir(dirname(refPath), { recursive: true });
        await writeFile(refPath, `${hash}\n`, { mode: 0o600 });
      }
    } else if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(head.trim())) {
      throw new Error("the current Git HEAD is malformed");
    }
    await writeFile(join(directory, "HEAD"), safeHead, { mode: 0o600 });

    const index = join(gitDirectory, "index");
    const indexInfo = await lstat(index).catch(() => undefined);
    if (indexInfo !== undefined) {
      if (!indexInfo.isFile() || indexInfo.isSymbolicLink() || indexInfo.size > MAX_GIT_METADATA_BYTES) throw new Error("Git index is not a safe regular file");
      await copyFile(index, join(directory, "index"));
    }

    const objectPath = join(commonDirectory, "objects");
    const objectInfo = await lstat(objectPath);
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink()) throw new Error("Git object directory is not a regular directory");
    const objectDirectory = await realpath(objectPath);
    if (!isPathWithin(objectDirectory, commonDirectory)) throw new Error("Git object directory escapes the repository");
    const alternateFile = join(commonDirectory, "objects", "info", "alternates");
    const alternateInfo = await lstat(alternateFile).catch(() => undefined);
    if (alternateInfo !== undefined) {
      const alternateText = await readRegularText(alternateFile, 64 * 1_024);
      if (alternateText.trim() !== "") throw new Error("Git object alternates are not supported for isolated inspection");
    }
    await writeFile(join(directory, "objects", "info", "alternates"), `${objectDirectory}\n`, { mode: 0o600 });

    const objectFormat = await gitObjectFormat(gitDirectory, commonDirectory);
    const config = `[core]\n\trepositoryformatversion = ${objectFormat === "sha256" ? 1 : 0}\n\tfilemode = ${process.platform === "win32" ? "false" : "true"}\n\tbare = false\n\tignorecase = ${process.platform === "win32" ? "true" : "false"}\n` + (objectFormat === "sha256" ? "[extensions]\n\tobjectFormat = sha256\n" : "");
    await writeFile(join(directory, "config"), config, { mode: 0o600 });

    const environment = isolatedGitEnvironment(directory, worktree);
    return { directory, commandCwd: trustedGitCwd(), environment, cleanup: () => rm(directory!, { recursive: true, force: true }) };
  } catch (error) {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message.slice(0, 512) : "repository metadata is unavailable";
    throw new RpcRuntimeError("git_unavailable", `cannot inspect repository safely: ${detail}`);
  }
}

async function locateGitDirectory(worktree: string): Promise<string> {
  const dotGit = join(worktree, ".git");
  const info = await lstat(dotGit);
  if (info.isDirectory() && !info.isSymbolicLink()) return realpath(dotGit);
  // A linked-worktree `.git` file can point at an arbitrary external object
  // database.  Following it would let a read-only request select and expose
  // another repository's index/objects, so isolated inspection deliberately
  // supports only a real `.git` directory.
  throw new Error("linked Git worktrees and .git pointer files are not supported for isolated inspection");
}

async function locateCommonDirectory(gitDirectory: string): Promise<string> {
  const pointer = join(gitDirectory, "commondir");
  const info = await lstat(pointer).catch(() => undefined);
  if (info === undefined) return gitDirectory;
  throw new Error("Git common-directory pointers are not supported for isolated inspection");
}

async function resolveGitRef(gitDirectory: string, commonDirectory: string, ref: string, depth = 0): Promise<string | undefined> {
  if (depth > 4 || !/^refs\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  for (const root of [gitDirectory, commonDirectory]) {
    const path = join(root, ref.replaceAll("/", "/"));
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    const value = (await readRegularText(path, 4_096)).trim();
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) return value;
    const symbolic = /^ref:\s*(refs\/[A-Za-z0-9._/-]+)$/u.exec(value);
    return symbolic?.[1] === undefined ? undefined : resolveGitRef(gitDirectory, commonDirectory, symbolic[1], depth + 1);
  }
  const packed = join(commonDirectory, "packed-refs");
  const packedInfo = await lstat(packed).catch(() => undefined);
  if (packedInfo === undefined) return undefined;
  if (!packedInfo.isFile() || packedInfo.isSymbolicLink() || packedInfo.size > MAX_GIT_METADATA_BYTES) return undefined;
  const lines = (await readFile(packed, "utf8")).split(/\r?\n/u);
  for (const line of lines) {
    const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(refs\/[A-Za-z0-9._/-]+)$/iu.exec(line);
    if (match?.[2] === ref && match[1] !== undefined) return match[1];
  }
  return undefined;
}

async function gitObjectFormat(gitDirectory: string, commonDirectory: string): Promise<"sha1" | "sha256"> {
  for (const path of [join(gitDirectory, "config"), join(commonDirectory, "config")]) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_GIT_METADATA_BYTES) throw new Error("Git config is not a safe regular file");
    const text = await readFile(path, "utf8");
    const match = /^\s*objectformat\s*=\s*(sha1|sha256)\s*$/imu.exec(text);
    if (match?.[1]?.toLowerCase() === "sha256") return "sha256";
    if (match?.[1]?.toLowerCase() === "sha1") return "sha1";
  }
  return "sha1";
}

async function readRegularText(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(`Git metadata file is invalid: ${path}`);
  return readFile(path, "utf8");
}

function isolatedGitEnvironment(directory: string, worktree: string): NodeJS.ProcessEnv {
  const pathEntries = trustedGitPathEntries(worktree);
  const path = pathEntries.join(process.platform === "win32" ? ";" : ":");
  // Start from an allow-list rather than inheriting the Runner's environment:
  // credentials, NODE_OPTIONS, custom Git helpers, and user config locations
  // must not reach a read-only inspection subprocess.
  let environment: NodeJS.ProcessEnv;
  if (process.platform === "win32") {
    const root = trustedWindowsRoot();
    environment = { ...trustedWindowsEnvironment(root), TEMP: `${root}\\Temp`, TMP: `${root}\\Temp` };
  } else {
    environment = { LANG: "C", LC_ALL: "C" };
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_DIR = directory;
  environment.GIT_WORK_TREE = worktree;
  environment.GIT_INDEX_FILE = join(directory, "index");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = nullDevice;
  environment.GIT_CONFIG_SYSTEM = nullDevice;
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_EXTERNAL_DIFF = "";
  environment.GIT_DIFF_OPTS = "";
  environment.PATH = path;
  environment.Path = path;
  if (process.platform !== "win32") {
    environment.LANG = "C";
    environment.LC_ALL = "C";
  }
  return environment;
}

function trustedGitCwd(): string {
  return process.platform === "win32" ? `${trustedWindowsRoot()}\\System32` : "/";
}

/**
 * Keep only conventional system/runtime Git locations.  In particular, do
 * not pass the caller's arbitrary PATH through to a read-only inspection;
 * the child starts in a trusted directory as an additional defense against
 * Windows current-directory executable search.  A Git installation in a
 * conventional `git/cmd` or `git/bin` directory is retained so portable
 * developer runtimes continue to work.
 */
function trustedGitPathEntries(worktree: string): string[] {
  const entries: string[] = [];
  const add = (value: string | undefined): void => {
    if (value === undefined || value.trim() === "") return;
    const normalized = value.replace(/[\\/]+$/u, "");
    if (entries.some((item) => item.toLowerCase() === normalized.toLowerCase())) return;
    entries.push(normalized);
  };
  add(dirname(process.execPath));
  if (process.platform === "win32") {
    const root = trustedWindowsRoot();
    add(`${root}\\System32`);
    add(`${root}\\System32\\Wbem`);
    add(`${root}\\System32\\WindowsPowerShell\\v1.0`);
    add(process.env.ProgramFiles === undefined ? undefined : `${process.env.ProgramFiles}\\Git\\cmd`);
    add(process.env.ProgramFiles === undefined ? undefined : `${process.env.ProgramFiles}\\Git\\bin`);
    add(process.env["ProgramFiles(x86)"] === undefined ? undefined : `${process.env["ProgramFiles(x86)"]}\\Git\\cmd`);
    add(process.env["ProgramFiles(x86)"] === undefined ? undefined : `${process.env["ProgramFiles(x86)"]}\\Git\\bin`);
  } else {
    add("/usr/bin"); add("/bin"); add("/usr/local/bin");
  }
  const source = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of source.split(process.platform === "win32" ? ";" : ":")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    if (process.platform === "win32" ? !/^[A-Za-z]:[\\/]|^\\\\/u.test(trimmed) : !trimmed.startsWith("/")) continue;
    const conventionalGit = process.platform === "win32"
      ? /[\\/]git[\\/](?:cmd|bin)$/iu.test(trimmed)
      : /(?:^|\/)git(?:\/|$)/u.test(trimmed);
    if (!conventionalGit) continue;
    if (isLexicallyWithin(trimmed, worktree)) continue;
    add(trimmed);
  }
  return entries;
}

function isLexicallyWithin(candidate: string, root: string): boolean {
  const child = normalizePathForComparison(candidate);
  const parent = normalizePathForComparison(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function isPathWithin(candidate: string, root: string): boolean {
  const child = normalizePathForComparison(candidate);
  const parent = normalizePathForComparison(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizePathForComparison(value: string): string {
  const normalized = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  const root = normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized);
  const withoutTrailingSeparators = root ? normalized : normalized.replace(/\/+$/u, "");
  return process.platform === "win32" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
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
