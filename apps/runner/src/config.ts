import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface PermissionSet {
  readonly read: boolean;
  readonly edit: boolean;
  readonly shell: boolean;
  readonly job_control: boolean;
}

export interface WorkspaceConfig {
  readonly workspaceId: string;
  readonly rootPath: string;
  /** Compatibility presentation flag derived from permissions.edit. */
  readonly readonly: boolean;
  /** Compatibility presentation flag derived from permissions.shell. */
  readonly shell: boolean;
  /** Present for centrally managed policy; omitted by legacy CLI configurations. */
  readonly permissions?: PermissionSet;
}

export interface RunnerConfig {
  readonly server: string;
  readonly token: string;
  readonly runnerId: string;
  readonly workspaces: readonly WorkspaceConfig[];
  /** Local supervisor concurrency; defaults to one to match advertised capability. */
  readonly maxConcurrentJobs?: number;
  readonly maxRetainedJobs?: number;
  readonly maxLogBytesPerJob?: number;
  readonly maxTotalLogBytes?: number;
  /** Persistent local job metadata/log directory. */
  readonly stateDir?: string;
  /** Test-only delay before closing only the Runner WebSocket. */
  readonly disconnectAfterMs?: number;
  /** Test-only file trigger that closes only the transport. */
  readonly disconnectControlFile?: string;
}

export interface WorkspaceOption {
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly readonly?: boolean;
  readonly shell?: boolean;
}

export interface RawRunnerOptions {
  readonly server?: string;
  readonly token?: string;
  readonly runnerId?: string;
  readonly insecureLocal?: boolean;
  readonly maxConcurrentJobs?: number;
  readonly maxRetainedJobs?: number;
  readonly maxLogBytesPerJob?: number;
  readonly maxTotalLogBytes?: number;
  readonly stateDir?: string;
  readonly disconnectAfterMs?: number;
  readonly disconnectControlFile?: string;
  readonly workspaces?: readonly (string | WorkspaceOption)[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export async function validateRunnerConfig(options: RawRunnerOptions): Promise<RunnerConfig> {
  const server = options.server?.trim();
  const token = (options.token ?? process.env.CODING_RUNNER_TOKEN)?.trim();
  const runnerId = options.runnerId?.trim();
  let parsedServer: URL | undefined;
  try { parsedServer = server === undefined ? undefined : new URL(server); } catch { parsedServer = undefined; }
  if (server === undefined || parsedServer === undefined || !["ws:", "wss:"].includes(parsedServer.protocol)) {
    throw new Error("--server must be a ws:// or wss:// URL");
  }
  const loopback = parsedServer.hostname === "127.0.0.1" || parsedServer.hostname === "localhost" || parsedServer.hostname === "[::1]";
  if (parsedServer.protocol !== "wss:" && !(loopback && options.insecureLocal === true)) {
    throw new Error("wss:// is required; use --insecure-local only for loopback ws://");
  }
  if (token === undefined || token.length < 16 || /[\s]/.test(token)) throw new Error("--token must be at least 16 non-whitespace characters");
  if (runnerId === undefined || !SAFE_ID.test(runnerId)) throw new Error("--runner-id must be a safe protocol identifier");
  if (options.maxConcurrentJobs !== undefined && (!Number.isSafeInteger(options.maxConcurrentJobs) || options.maxConcurrentJobs < 1 || options.maxConcurrentJobs > 64)) {
    throw new Error("--max-concurrent-jobs must be an integer from 1 to 64");
  }
  for (const [name, value] of [["maxRetainedJobs", options.maxRetainedJobs], ["maxLogBytesPerJob", options.maxLogBytesPerJob], ["maxTotalLogBytes", options.maxTotalLogBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024)) throw new Error(`--${name} must be a positive bounded integer`);
  }

  const seen = new Set<string>();
  const workspaces: WorkspaceConfig[] = [];
  for (const value of options.workspaces ?? []) {
    const option = typeof value === "string" ? parseWorkspaceString(value) : value;
    if (option === undefined || !SAFE_ID.test(option.workspaceId) || seen.has(option.workspaceId)) {
      throw new Error(`invalid or duplicate workspace id: ${typeof value === "string" ? value : option?.workspaceId ?? "unknown"}`);
    }
    const suppliedPath = option.rootPath;
    if (suppliedPath.includes("\0")) throw new Error("workspace path must not contain NUL");
    const absolute = isAbsolute(suppliedPath) ? suppliedPath : resolve(suppliedPath);
    const rootPath = await realpath(absolute).catch(() => { throw new Error(`workspace path does not exist: ${suppliedPath}`); });
    const stat = await lstat(rootPath);
    if (!stat.isDirectory()) throw new Error(`workspace path is not a directory: ${suppliedPath}`);
    seen.add(option.workspaceId);
    workspaces.push({ workspaceId: option.workspaceId, rootPath, readonly: option.readonly ?? true, shell: option.shell ?? false });
  }
  return { server, token, runnerId, workspaces, ...(options.maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs: options.maxConcurrentJobs }), ...(options.maxRetainedJobs === undefined ? {} : { maxRetainedJobs: options.maxRetainedJobs }), ...(options.maxLogBytesPerJob === undefined ? {} : { maxLogBytesPerJob: options.maxLogBytesPerJob }), ...(options.maxTotalLogBytes === undefined ? {} : { maxTotalLogBytes: options.maxTotalLogBytes }), ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }), ...(options.disconnectAfterMs === undefined ? {} : { disconnectAfterMs: options.disconnectAfterMs }), ...(options.disconnectControlFile === undefined ? {} : { disconnectControlFile: options.disconnectControlFile }) };
}

function parseWorkspaceString(value: string): WorkspaceOption | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const workspaceId = value.slice(0, separator);
  let rootPath = value.slice(separator + 1);
  let readonly = true;
  let shell = false;
  // Optional suffixes keep the original id=path syntax compatible while allowing
  // `id=path;writable;shell` for command-line users. Semicolons are not valid POSIX
  // path separators in the suffix grammar and are deliberately unambiguous.
  const parts = rootPath.split(";");
  rootPath = parts.shift() ?? "";
  for (const part of parts) {
    if (part === "readonly") readonly = true;
    else if (part === "writable") readonly = false;
    else if (part === "shell") shell = true;
    else if (part === "noshell") shell = false;
    else return undefined;
  }
  return { workspaceId, rootPath, readonly, shell };
}

export function parseRunnerArgs(args: readonly string[]): RawRunnerOptions {
  const options: { server?: string; token?: string; runnerId?: string; insecureLocal?: boolean; maxConcurrentJobs?: number; stateDir?: string; disconnectAfterMs?: number; disconnectControlFile?: string; workspaces: string[] } = { workspaces: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--insecure-local") { options.insecureLocal = true; continue; }
    if ((arg === "--server" || arg === "--token" || arg === "--runner-id" || arg === "--workspace" || arg === "--max-concurrent-jobs" || arg === "--state-dir" || arg === "--disconnect-after-ms" || arg === "--disconnect-control-file") && next !== undefined) {
      if (arg === "--server") options.server = next;
      if (arg === "--token") options.token = next;
      if (arg === "--runner-id") options.runnerId = next;
      if (arg === "--workspace") options.workspaces.push(next);
      if (arg === "--max-concurrent-jobs") {
        if (!/^\d+$/.test(next)) throw new Error("--max-concurrent-jobs must be a positive integer");
        options.maxConcurrentJobs = Number(next);
      }
      if (arg === "--state-dir") options.stateDir = next;
      if (arg === "--disconnect-control-file") options.disconnectControlFile = next;
      if (arg === "--disconnect-after-ms") {
        if (!/^\d+$/.test(next) || Number(next) < 1) throw new Error("--disconnect-after-ms must be a positive integer");
        options.disconnectAfterMs = Number(next);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete option: ${arg}`);
  }
  return options;
}
