import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

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
const MAX_WORKSPACES = 64;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const MAX_SERVER_URL_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_DISCONNECT_AFTER_MS = 24 * 60 * 60 * 1_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export async function validateRunnerConfig(options: RawRunnerOptions): Promise<RunnerConfig> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error("runner options must be an object");
  const suppliedServer = typeof options.server === "string" ? options.server : undefined;
  const server = suppliedServer?.trim();
  const suppliedToken = options.token ?? process.env.RUNMESH_RUNNER_TOKEN ?? process.env.CODING_RUNNER_TOKEN;
  if ((suppliedServer !== undefined && CONTROL_CHARACTER_PATTERN.test(suppliedServer)) || (typeof suppliedToken === "string" && CONTROL_CHARACTER_PATTERN.test(suppliedToken))) {
    throw new Error("server and token must not contain control characters");
  }
  const token = typeof suppliedToken === "string" ? suppliedToken.trim() : undefined;
  const runnerId = typeof options.runnerId === "string" ? options.runnerId.trim() : undefined;
  let parsedServer: URL | undefined;
  try { parsedServer = server === undefined ? undefined : new URL(server); } catch { parsedServer = undefined; }
  if (server === undefined || server.length > MAX_SERVER_URL_LENGTH || CONTROL_CHARACTER_PATTERN.test(server) || parsedServer === undefined || !["ws:", "wss:"].includes(parsedServer.protocol)) {
    throw new Error("--server must be a ws:// or wss:// URL");
  }
  const loopback = parsedServer.hostname === "127.0.0.1" || parsedServer.hostname === "localhost" || parsedServer.hostname === "[::1]";
  if (parsedServer.protocol !== "wss:" && !(loopback && options.insecureLocal === true)) {
    throw new Error("wss:// is required; use --insecure-local only for loopback ws://");
  }
  if (parsedServer.username !== "" || parsedServer.password !== "" || parsedServer.search !== "" || parsedServer.hash !== "") {
    throw new Error("--server must not contain credentials, query parameters, or a fragment");
  }
  if (parsedServer.toString().length > MAX_SERVER_URL_LENGTH) throw new Error(`--server URL must not exceed ${MAX_SERVER_URL_LENGTH} characters`);
  if (token === undefined || token.length < 16 || token.length > MAX_TOKEN_LENGTH || /[\s]/.test(token) || CONTROL_CHARACTER_PATTERN.test(token)) throw new Error(`--token must be 16-${MAX_TOKEN_LENGTH} non-whitespace characters without control characters`);
  if (runnerId === undefined || !SAFE_ID.test(runnerId)) throw new Error("--runner-id must be a safe protocol identifier");
  if (options.insecureLocal !== undefined && typeof options.insecureLocal !== "boolean") throw new Error("insecureLocal must be a boolean");
  if (options.maxConcurrentJobs !== undefined && (!Number.isSafeInteger(options.maxConcurrentJobs) || options.maxConcurrentJobs < 1 || options.maxConcurrentJobs > 64)) {
    throw new Error("--max-concurrent-jobs must be an integer from 1 to 64");
  }
  for (const [name, value] of [["maxRetainedJobs", options.maxRetainedJobs], ["maxLogBytesPerJob", options.maxLogBytesPerJob], ["maxTotalLogBytes", options.maxTotalLogBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 512 * 1024 * 1024)) throw new Error(`--${name} must be a positive bounded integer`);
  }
  if (options.disconnectAfterMs !== undefined && (!Number.isSafeInteger(options.disconnectAfterMs) || options.disconnectAfterMs < 1 || options.disconnectAfterMs > MAX_DISCONNECT_AFTER_MS)) {
    throw new Error("--disconnect-after-ms must be a positive bounded integer");
  }
  if (options.disconnectControlFile !== undefined && (typeof options.disconnectControlFile !== "string" || options.disconnectControlFile.length === 0 || options.disconnectControlFile.length > MAX_WORKSPACE_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(options.disconnectControlFile))) {
    throw new Error("--disconnect-control-file must be a bounded path without control characters");
  }

  const seen = new Set<string>();
  const workspaces: WorkspaceConfig[] = [];
  if (options.workspaces !== undefined && !Array.isArray(options.workspaces)) throw new Error("workspaces must be an array");
  if ((options.workspaces?.length ?? 0) > MAX_WORKSPACES) throw new Error(`at most ${MAX_WORKSPACES} workspaces are supported`);
  for (const value of options.workspaces ?? []) {
    const option = typeof value === "string" ? parseWorkspaceString(value) : value;
    if (option === undefined || typeof option !== "object" || option === null || Array.isArray(option) || typeof option.workspaceId !== "string" || !SAFE_ID.test(option.workspaceId) || seen.has(option.workspaceId)) {
      throw new Error(`invalid or duplicate workspace id: ${typeof value === "string" ? value : option?.workspaceId ?? "unknown"}`);
    }
    const suppliedPath = option.rootPath;
    if (typeof suppliedPath !== "string" || suppliedPath.length === 0 || suppliedPath.length > MAX_WORKSPACE_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(suppliedPath)) throw new Error("workspace path must be a bounded path without control characters");
    if (option.readonly !== undefined && typeof option.readonly !== "boolean") throw new Error("workspace readonly must be a boolean");
    if (option.shell !== undefined && typeof option.shell !== "boolean") throw new Error("workspace shell must be a boolean");
    const absolute = isAbsolute(suppliedPath) ? suppliedPath : resolve(suppliedPath);
    const rootPath = await realpath(absolute).catch(() => { throw new Error(`workspace path does not exist: ${suppliedPath}`); });
    const stat = await lstat(rootPath);
    if (!stat.isDirectory()) throw new Error(`workspace path is not a directory: ${suppliedPath}`);
    // Two workspace IDs that overlap the same canonical tree could carry
    // different readonly/shell flags, letting a caller select the more
    // permissive alias to reach files advertised as restricted. Keep local
    // profiles subject to the same non-overlap invariant as central policy.
    if (workspaces.some((existing) => pathsOverlap(existing.rootPath, rootPath))) {
      throw new Error(`workspace roots must not overlap: ${suppliedPath}`);
    }
    seen.add(option.workspaceId);
    workspaces.push({ workspaceId: option.workspaceId, rootPath, readonly: option.readonly ?? true, shell: option.shell ?? false });
  }
  let stateDir: string | undefined;
  if (options.stateDir !== undefined) {
    stateDir = await validateStateDirectory(options.stateDir);
    // Job metadata and command output are local secrets. Keeping the state
    // tree inside (or equal to) a configured Workspace would make those files
    // readable through the authenticated filesystem RPC surface.
    if (workspaces.some((workspace) => pathsOverlap(stateDir as string, workspace.rootPath))) {
      throw new Error("--state-dir must not overlap a workspace root");
    }
  }
  return { server, token, runnerId, workspaces, ...(options.maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs: options.maxConcurrentJobs }), ...(options.maxRetainedJobs === undefined ? {} : { maxRetainedJobs: options.maxRetainedJobs }), ...(options.maxLogBytesPerJob === undefined ? {} : { maxLogBytesPerJob: options.maxLogBytesPerJob }), ...(options.maxTotalLogBytes === undefined ? {} : { maxTotalLogBytes: options.maxTotalLogBytes }), ...(stateDir === undefined ? {} : { stateDir }), ...(options.disconnectAfterMs === undefined ? {} : { disconnectAfterMs: options.disconnectAfterMs }), ...(options.disconnectControlFile === undefined ? {} : { disconnectControlFile: options.disconnectControlFile }) };
}

/**
 * Explicit state is consumed by several independent persistence writers. Keep
 * it absolute and free of control characters so a service manager cannot
 * reinterpret it relative to an attacker-controlled working directory or
 * inject a line/argument into a generated service invocation.
 */
async function validateStateDirectory(value: string): Promise<string> {
  if (value.length === 0 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value) || !isAbsolute(value)) {
    throw new Error("--state-dir must be an absolute path without control characters");
  }
  const normalized = resolve(value);
  if (normalized === parse(normalized).root) throw new Error("--state-dir must not be a filesystem root");
  const existing = await lstat(normalized).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("--state-dir must be a regular directory");
  }
  if (existing !== undefined && process.platform !== "win32" && (existing.mode & 0o022) !== 0) {
    throw new Error("--state-dir must not be writable by group or others");
  }
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  const isWithin = (parent: string, child: string): boolean => {
    const childRelative = relative(parent, child);
    return childRelative === "" || (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative));
  };
  return isWithin(leftResolved, rightResolved) || isWithin(rightResolved, leftResolved);
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
