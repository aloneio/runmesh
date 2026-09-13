import { assertRpcResultFits, jsonBytes, MAX_RPC_RESULT_BYTES } from "./rpc-budget.js";
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, relative, sep } from "node:path";
import { PathPolicyError, type PathPolicy, type PathSnapshot } from "./path-policy.js";
import { RpcRuntimeError } from "./errors.js";
import type { WorkspaceConfig } from "./config.js";
import { utf8ForwardBoundary, utf8SafePrefixLength } from "./utf8-pagination.js";

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_DIRECTORIES = 1_000;
const MAX_SEARCH_DEPTH = 16;
const MAX_SEARCH_ENTRIES = 10_000;
const MAX_SEARCH_FILES = 1_000;
const MAX_SEARCH_DURATION_MS = 5_000;
// Directory cursors are entry indexes, so serving an arbitrarily large cursor
// would require scanning every preceding entry even though each response is
// capped at 256 items. Keep the worst-case scan bounded and fail closed for
// cursors beyond the supported window.
const MAX_LIST_CURSOR = 100_000;
const MAX_SEARCH_CURSOR = 100_000;
const COMMON_HUGE_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", ".cache"]);

type SearchContextLine = { readonly line: number; readonly text: string };
type SearchResult = { readonly path: string; readonly line: number; readonly column: number; readonly match: string; readonly text: string; readonly context_before: readonly SearchContextLine[]; readonly context_after: readonly SearchContextLine[] };
type SearchTruncatedReason = "time_budget" | "byte_budget" | "directory_budget" | "entry_budget" | "file_budget" | "result_budget" | "response_bytes";
type SearchBudget = { bytes: number; directories: number; entries: number; files: number; deadline: number; truncated: boolean; truncatedReason: SearchTruncatedReason | null; readonly snapshotXor: Buffer };
type SearchMode = "literal" | "filename";
type SearchOptions = { readonly mode: SearchMode; readonly caseSensitive: boolean; readonly includeGlobs: readonly RegExp[]; readonly excludeGlobs: readonly RegExp[]; readonly contextBefore: number; readonly contextAfter: number };
type IgnoreRule = { readonly negative: boolean; readonly directoryOnly: boolean; readonly matcher: RegExp; readonly exactMatcher: RegExp };
type DirectoryEntryVisitor = (entry: Dirent<string>, index: number) => boolean | Promise<boolean>;

export class FilesystemService {
  public constructor(private readonly policy: PathPolicy) {}

  /** Return bounded metadata without decoding file contents. */
  public async stat(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const resolved = await this.policy.resolve(params.workspace_id, params.path, "read");
    const { workspace, path } = resolved;
    // Resolve() is a path check, not an OS capability. Capture the object
    // identity and verify it again after opening so a swapped ancestor cannot
    // redirect this request to an outside file.
    const snapshot = await this.policy.snapshot(resolved);
    const relativePath = relative(workspace.rootPath, path).split(sep).join("/");
    if (snapshot.type !== "file") {
      // Return metadata from the checked snapshot rather than stat(path) after
      // the check; a later path replacement can therefore only make this
      // request stale, not disclose metadata for the replacement target.
      await this.policy.verifySnapshot(resolved, snapshot);
      return { workspace_id: workspace.workspaceId, path: relativePath, type: snapshot.type, size: snapshot.size, modified_at_ms: snapshot.modifiedAtMs };
    }
    const handle = await openNoFollow(path, true);
    try {
      const info = await handle.stat();
      await this.policy.verifySnapshot(resolved, snapshot);
      if (!info.isFile() || !sameIdentity(info, snapshot)) throw symlinkEscape();
      const utf8 = await readSample(handle, Math.min(info.size, 4 * 1024));
      const binary = !utf8;
      return { workspace_id: workspace.workspaceId, path: relativePath, type: "file", size: info.size, modified_at_ms: info.mtimeMs, encoding: binary ? "binary" : "utf-8", binary };
    } finally { await handle.close(); }
  }

  public async read(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const resolved = await this.policy.resolve(params.workspace_id, params.path, "read");
    const { workspace, path } = resolved;
    const requestedOffset = boundedInteger(params.cursor ?? params.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const requested = boundedInteger(params.limit, 1, MAX_READ_BYTES, MAX_READ_BYTES);
    const snapshot = await this.policy.snapshot(resolved);
    if (snapshot.type !== "file") throw new Error("path is not a file");
    // O_NOFOLLOW protects the leaf on POSIX; the post-open snapshot also
    // catches Windows junction/reparse swaps in any ancestor before bytes are
    // read. The descriptor remains bound if an ancestor changes afterwards.
    const handle = await openNoFollow(path, true);
    try {
      const info = await handle.stat();
      await this.policy.verifySnapshot(resolved, snapshot);
      if (!info.isFile() || !sameIdentity(info, snapshot)) throw symlinkEscape();
      const rawStart = Math.min(requestedOffset, info.size);
      const probeStart = Math.max(0, rawStart - 3);
      const probe = Buffer.alloc(Math.min(7, info.size - probeStart));
      const { bytesRead: probeRead } = await handle.read(probe, 0, probe.byteLength, probeStart);
      const start = probeStart + utf8ForwardBoundary(probe.subarray(0, probeRead), rawStart - probeStart);
      const data = Buffer.alloc(Math.min(info.size - start, requested + 3));
      const { bytesRead } = await handle.read(data, 0, data.byteLength, start);
      const actual = data.subarray(0, bytesRead);
      let used = utf8SafePrefixLength(actual, requested);
      if (used === 0 && actual.byteLength > 0) used = utf8SafePrefixLength(actual, Math.min(4, actual.byteLength));
      const resultFor = (length: number) => ({
        workspace_id: workspace.workspaceId, path: relative(workspace.rootPath, path).split(sep).join("/"),
        data: actual.subarray(0, length).toString("utf8"), encoding: "utf-8", offset: start,
        next_cursor: start + length < info.size ? String(start + length) : null, truncated: start + length < info.size, size: info.size,
      });
      // JSON escaping, not just the source bytes, determines transport size.
      let low = 0; let high = used;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (jsonBytes(resultFor(utf8SafePrefixLength(actual, middle))) <= MAX_RPC_RESULT_BYTES) low = middle;
        else high = middle - 1;
      }
      used = utf8SafePrefixLength(actual, low);
      const result = resultFor(used);
      assertRpcResultFits(result);
      return result;
    } finally {
      await handle.close();
    }
  }

  public async list(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const resolved = await this.policy.resolve(params.workspace_id, params.path ?? ".", "list");
    const { workspace, path } = resolved;
    const snapshot = await this.policy.snapshot(resolved);
    if (snapshot.type !== "directory") throw new Error("path is not a directory");
    const limit = boundedInteger(params.limit, 1, 256, 200);
    const offset = boundedInteger(params.cursor, 0, MAX_LIST_CURSOR, 0);
    // Do not emit a continuation cursor beyond the hard scan window. A
    // directory larger than the window is reported as truncated at the
    // boundary instead of handing the client an unusable cursor.
    const pageLimit = Math.min(limit, MAX_LIST_CURSOR - offset);
    // Read only the requested page plus one look-ahead entry.  The previous
    // implementation accumulated every directory entry before slicing, which
    // made a single large directory an unbounded memory allocation despite the
    // 256-entry response limit.
    const pageEntries: Dirent<string>[] = [];
    let hasMore = false;
    await readDirectoryThroughHandle(this.policy, resolved, snapshot, async (entry, index) => {
      if (index < offset) return true;
      if (index >= MAX_LIST_CURSOR || pageEntries.length >= pageLimit) {
        hasMore = true;
        return false;
      }
      pageEntries.push(entry);
      return true;
    });
    const page = pageEntries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
    const resultFor = () => ({ workspace_id: workspace.workspaceId, path: relative(workspace.rootPath, path).split(sep).join("/"), entries: page,
      next_cursor: hasMore && offset + page.length < MAX_LIST_CURSOR ? String(offset + page.length) : null, truncated: hasMore });
    while (page.length > 1 && jsonBytes(resultFor()) > MAX_RPC_RESULT_BYTES) { page.pop(); hasMore = true; }
    const result = resultFor();
    assertRpcResultFits(result);
    return result;
  }

  public async search(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    if (typeof params.query !== "string" || params.query.length === 0 || params.query.length > 512) throw new RpcRuntimeError("invalid_params", "query must be a non-empty string");
    const resolved = await this.policy.resolve(params.workspace_id, params.path ?? ".", "search");
    const { workspace } = resolved;
    const limit = boundedInteger(params.max_results ?? params.limit, 1, 256, 100);
    const cursor = parseSearchCursor(params.cursor);
    const offset = cursor.offset;
    const options = searchOptions(params);
    const results: SearchResult[] = [];
    const budget: SearchBudget = { bytes: 0, directories: 0, entries: 0, files: 0, deadline: performance.now() + MAX_SEARCH_DURATION_MS, truncated: false, truncatedReason: null, snapshotXor: Buffer.alloc(32) };
    const snapshot = await this.policy.snapshot(resolved);
    if (snapshot.type !== "directory") throw new Error("path is not a directory");
    addSearchSnapshotPart(budget, relative(workspace.rootPath, resolved.path).split(sep).join("/"), snapshot);
    await this.searchDirectory(resolved, snapshot, params.query, options, results, budget, 0, []);
    const snapshotId = searchSnapshotId(workspace.workspaceId, params.query, options, budget.snapshotXor);
    if (cursor.snapshotId !== null && cursor.snapshotId !== snapshotId) throw new RpcRuntimeError("search_snapshot_changed", "search results changed since the supplied cursor was issued", { expected_snapshot_id: cursor.snapshotId, actual_snapshot_id: snapshotId });
    const page = results.slice(offset, offset + limit);
    let responseTrimmed = false;
    const resultFor = (): Record<string, unknown> => {
      const next = offset + page.length;
      const more = results.length > next;
      return { workspace_id: workspace.workspaceId, query: params.query, mode: options.mode, case_sensitive: options.caseSensitive,
        engine: options.mode === "filename" ? "builtin_filename" : "builtin_literal", results: page,
        next_cursor: more ? `s1:${snapshotId}:${next}` : null, snapshot_id: snapshotId,
        truncated: budget.truncated || more || responseTrimmed,
        truncated_reason: responseTrimmed ? "response_bytes" : budget.truncatedReason ?? (more ? "result_budget" : null),
        scanned: { bytes: budget.bytes, files: budget.files, directories: budget.directories, entries: budget.entries } };
    };
    // Preserve an actionable cursor when long/CJK/escaped lines fill a page.
    // Trimming after the Runner sends a frame would be too late.
    while (page.length > 1 && jsonBytes(resultFor()) > MAX_RPC_RESULT_BYTES) { page.pop(); responseTrimmed = true; }
    const result = resultFor();
    result.returned_bytes = jsonBytes(result);
    assertRpcResultFits(result);
    return result;
  }

  private async searchDirectory(
    resolvedDirectory: { readonly workspace: WorkspaceConfig; readonly path: string },
    directorySnapshot: PathSnapshot,
    query: string,
    options: SearchOptions,
    results: SearchResult[],
    budget: SearchBudget,
    depth: number,
    inheritedIgnoreRules: readonly IgnoreRule[],
  ): Promise<void> {
    if (budget.truncated || results.length >= MAX_SEARCH_RESULTS) return;
    if (depth > MAX_SEARCH_DEPTH || budget.directories >= MAX_SEARCH_DIRECTORIES) { truncateSearch(budget, "directory_budget"); return; }
    budget.directories += 1;
    const { workspace, path: directory } = resolvedDirectory;
    const directoryRelative = relative(workspace.rootPath, directory).split(sep).join("/");
    const ignoreRules = await this.loadIgnoreRules(resolvedDirectory, directoryRelative, inheritedIgnoreRules, budget);
    try {
      await readDirectoryThroughHandle(this.policy, resolvedDirectory, directorySnapshot, async (entry) => {
        if (budget.truncated || results.length >= MAX_SEARCH_RESULTS) return false;
        if (budget.entries >= MAX_SEARCH_ENTRIES) { truncateSearch(budget, "entry_budget"); return false; }
        if (performance.now() >= budget.deadline) { truncateSearch(budget, "time_budget"); return false; }
        if (budget.bytes >= MAX_SEARCH_TOTAL_BYTES) { truncateSearch(budget, "byte_budget"); return false; }
        budget.entries += 1;
        if (entry.isSymbolicLink()) return true;
        if (entry.isDirectory() && COMMON_HUGE_DIRECTORIES.has(entry.name)) return true;
        const childRelative = relative(workspace.rootPath, `${directory}${sep}${entry.name}`).split(sep).join("/");
        let resolved: Awaited<ReturnType<PathPolicy["resolve"]>>;
        try { resolved = await this.policy.resolve(workspace.workspaceId, childRelative, "search"); } catch { return true; }
        let snapshot: PathSnapshot;
        try { snapshot = await this.policy.snapshot(resolved); } catch { return true; }
        addSearchSnapshotPart(budget, childRelative, snapshot);
        if (snapshot.type === "directory") {
          const ignored = isIgnored(childRelative, true, ignoreRules);
          if (!ignored || ignoreRules.some((rule) => rule.negative)) await this.searchDirectory(resolved, snapshot, query, options, results, budget, depth + 1, ignoreRules);
          return !budget.truncated && results.length < MAX_SEARCH_RESULTS;
        }
        if (snapshot.type !== "file") return true;
        if (isIgnored(childRelative, false, ignoreRules) || !matchesUserGlobs(childRelative, options)) return true;
        if (budget.files >= MAX_SEARCH_FILES) { truncateSearch(budget, "file_budget"); return false; }
        budget.files += 1;
        if (snapshot.size > MAX_SEARCH_FILE_BYTES) return true;
        if (options.mode === "filename") {
          const match = literalMatch(entry.name, query, options.caseSensitive);
          if (match !== null) results.push(searchResult(childRelative, 1, entry.name, match, query.length, [], options));
          if (results.length >= MAX_SEARCH_RESULTS) { truncateSearch(budget, "result_budget"); return false; }
          return true;
        }
        const loaded = await readUtf8FileSecure(this.policy, resolved, snapshot, budget).catch(() => undefined);
        if (loaded === undefined) return !budget.truncated;
        addSearchContentPart(budget, childRelative, loaded.content);
        const lines = loaded.content.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          const match = literalMatch(line, query, options.caseSensitive);
          if (match !== null) results.push(searchResult(childRelative, index + 1, line, match, query.length, lines, options));
          if (results.length >= MAX_SEARCH_RESULTS) { truncateSearch(budget, "result_budget"); return false; }
        }
        return true;
      });
    } catch {
      // Search is best-effort over a mutable workspace.  A directory that is
      // removed or replaced while traversing it is skipped, as before.
      return;
    }
  }

  private async loadIgnoreRules(
    resolvedDirectory: { readonly workspace: WorkspaceConfig; readonly path: string },
    directoryRelative: string,
    inherited: readonly IgnoreRule[],
    budget: SearchBudget,
  ): Promise<readonly IgnoreRule[]> {
    if (budget.truncated || inherited.length >= 1_024) return inherited;
    const ignoreRelative = directoryRelative === "" ? ".gitignore" : `${directoryRelative}/.gitignore`;
    let resolved: Awaited<ReturnType<PathPolicy["resolve"]>>;
    let snapshot: PathSnapshot;
    try {
      resolved = await this.policy.resolve(resolvedDirectory.workspace.workspaceId, ignoreRelative, "search");
      snapshot = await this.policy.snapshot(resolved);
    } catch { return inherited; }
    if (snapshot.type !== "file" || snapshot.size > 64 * 1024 || budget.files >= MAX_SEARCH_FILES) return inherited;
    budget.files += 1;
    addSearchSnapshotPart(budget, ignoreRelative, snapshot);
    const loaded = await readUtf8FileSecure(this.policy, resolved, snapshot, budget).catch(() => undefined);
    if (loaded === undefined) return inherited;
    addSearchContentPart(budget, ignoreRelative, loaded.content);
    return [...inherited, ...parseIgnoreRules(loaded.content, directoryRelative, 1_024 - inherited.length)];
  }
}

async function readSample(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<boolean> {
  if (size === 0) return true;
  const buffer = Buffer.alloc(size);
  const { bytesRead } = await handle.read(buffer, 0, size, 0);
  const sample = buffer.subarray(0, bytesRead);
  if (sample.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(sample); return true; } catch { return false; }
}

async function readDirectoryThroughHandle(
  policy: PathPolicy,
  resolved: { readonly workspace: WorkspaceConfig; readonly path: string },
  snapshot: PathSnapshot,
  visit: DirectoryEntryVisitor,
): Promise<void> {
  // On Linux bind traversal to a verified descriptor, not a pathname which
  // could be swapped away and restored between opendir and revalidation.
  // Keep the descriptor alive until Dir closes; never fall back to the path
  // if procfs is unavailable. Other platforms retain the documented local
  // mutator/ABA limitation until a native directory-handle adapter is added.
  const anchor = process.platform === "linux"
    ? await open(resolved.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    : undefined;
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    if (anchor !== undefined) {
      const info = await anchor.stat();
      if (!info.isDirectory() || !sameIdentity(info, snapshot)) throw symlinkEscape();
      await policy.verifySnapshot(resolved, snapshot);
    }
    directory = await opendir(anchor === undefined ? resolved.path : `/proc/self/fd/${anchor.fd}`);
    await policy.verifySnapshot(resolved, snapshot);
    let index = 0;
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      if (!await visit(entry, index)) break;
      index += 1;
    }
  } finally {
    await directory?.close().catch(() => undefined);
    await anchor?.close().catch(() => undefined);
  }
}

async function readUtf8FileSecure(
  policy: PathPolicy,
  resolved: { readonly workspace: WorkspaceConfig; readonly path: string },
  snapshot: PathSnapshot,
  budget: SearchBudget,
): Promise<{ readonly content: string; readonly size: number }> {
  const handle = await openNoFollow(resolved.path, true);
  try {
    const info = await handle.stat();
    await policy.verifySnapshot(resolved, snapshot);
    if (!info.isFile() || !sameIdentity(info, snapshot) || info.size > MAX_SEARCH_FILE_BYTES) throw new Error("file is not a bounded regular file");
    if (info.size > MAX_SEARCH_TOTAL_BYTES - budget.bytes) {
      truncateSearch(budget, "byte_budget");
      throw new Error("search byte budget exhausted");
    }
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.byteLength) {
      if (performance.now() >= budget.deadline) { truncateSearch(budget, "time_budget"); throw new Error("search time budget exhausted"); }
      const length = Math.min(data.byteLength - offset, MAX_SEARCH_TOTAL_BYTES - budget.bytes);
      if (length <= 0) { truncateSearch(budget, "byte_budget"); throw new Error("search byte budget exhausted"); }
      const { bytesRead } = await handle.read(data, offset, length, offset);
      // Account for I/O before binary detection, decoding, or any later error.
      budget.bytes += bytesRead;
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const sample = data.subarray(0, offset);
    if (sample.includes(0)) throw new Error("binary file");
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(sample), size: offset };
  } finally {
    await handle.close();
  }
}

function parseSearchCursor(value: unknown): { readonly offset: number; readonly snapshotId: string | null } {
  if (value === undefined || value === null) return { offset: 0, snapshotId: null };
  if (typeof value !== "string") throw new RpcRuntimeError("invalid_params", "search cursor must be a string");
  if (/^\d+$/.test(value)) return { offset: boundedInteger(value, 0, MAX_SEARCH_CURSOR, 0), snapshotId: null };
  const match = /^s1:([a-f0-9]{16}):(\d+)$/.exec(value);
  if (match === null) throw new RpcRuntimeError("invalid_params", "search cursor is invalid");
  return { snapshotId: match[1] as string, offset: boundedInteger(match[2], 0, MAX_SEARCH_CURSOR, 0) };
}

function searchOptions(params: Record<string, unknown>): SearchOptions {
  const mode = params.mode ?? "literal";
  if (mode !== "literal" && mode !== "filename") throw new RpcRuntimeError("invalid_params", "search mode must be literal or filename");
  if (params.case_sensitive !== undefined && typeof params.case_sensitive !== "boolean") throw new RpcRuntimeError("invalid_params", "case_sensitive must be a boolean");
  const include = searchGlobList(params.include_globs, "include_globs");
  const exclude = searchGlobList(params.exclude_globs, "exclude_globs");
  return {
    mode,
    caseSensitive: params.case_sensitive === undefined ? true : params.case_sensitive,
    includeGlobs: include.map(compileUserGlob),
    excludeGlobs: exclude.map(compileUserGlob),
    contextBefore: boundedInteger(params.context_before, 0, 8, 0),
    contextAfter: boundedInteger(params.context_after, 0, 8, 0),
  };
}

function searchGlobList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 256 || item.includes("\0"))) {
    throw new RpcRuntimeError("invalid_params", `${field} must contain at most 32 bounded glob strings`);
  }
  return value as string[];
}

function compileUserGlob(value: string): RegExp {
  const normalized = value.replace(/\\/g, "/");
  return new RegExp(`^${globBody(normalized)}$`, process.platform === "win32" ? "i" : "");
}

function globBody(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char === "*") {
      if (value[index + 1] === "*") {
        while (value[index + 1] === "*") index += 1;
        if (value[index + 1] === "/") { index += 1; result += "(?:.*/)?"; }
        else result += ".*";
      } else result += "[^/]*";
    } else if (char === "?") result += "[^/]";
    else result += char.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
  }
  return result;
}

function matchesUserGlobs(path: string, options: SearchOptions): boolean {
  const candidate = path.replace(/\\/g, "/");
  const name = basename(candidate);
  const matches = (pattern: RegExp): boolean => pattern.test(pattern.source.includes("/") ? candidate : name) || pattern.test(candidate);
  if (options.includeGlobs.length > 0 && !options.includeGlobs.some(matches)) return false;
  return !options.excludeGlobs.some(matches);
}

function literalMatch(value: string, query: string, caseSensitive: boolean): number | null {
  const index = caseSensitive ? value.indexOf(query) : value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return index < 0 ? null : index;
}

function searchResult(path: string, lineNumber: number, line: string, matchOffset: number, queryLength: number, lines: readonly string[], options: SearchOptions): SearchResult {
  const beforeStart = Math.max(0, lineNumber - 1 - options.contextBefore);
  const afterEnd = Math.min(lines.length, lineNumber + options.contextAfter);
  const contextBefore = lines.slice(beforeStart, lineNumber - 1).map((text, index) => ({ line: beforeStart + index + 1, text: text.slice(0, 4_096) }));
  const contextAfter = lines.slice(lineNumber, afterEnd).map((text, index) => ({ line: lineNumber + index + 1, text: text.slice(0, 4_096) }));
  return {
    path,
    line: lineNumber,
    column: Array.from(line.slice(0, matchOffset)).length + 1,
    match: line.slice(matchOffset, matchOffset + queryLength).slice(0, 1_024),
    text: line.slice(0, 4_096),
    context_before: contextBefore,
    context_after: contextAfter,
  };
}

function truncateSearch(budget: SearchBudget, reason: SearchTruncatedReason): void {
  budget.truncated = true;
  budget.truncatedReason ??= reason;
}

function addSearchSnapshotPart(budget: SearchBudget, path: string, snapshot: PathSnapshot): void {
  xorDigest(budget.snapshotXor, createHash("sha256").update(`${path}\0${snapshot.type}\0${snapshot.device}\0${snapshot.inode}\0${snapshot.size}\0${snapshot.modifiedAtMs}`).digest());
}

function addSearchContentPart(budget: SearchBudget, path: string, content: string): void {
  xorDigest(budget.snapshotXor, createHash("sha256").update(path).update("\0content\0").update(content).digest());
}

function xorDigest(target: Buffer, digest: Buffer): void {
  for (let index = 0; index < target.length; index += 1) target[index] = (target[index] as number) ^ (digest[index] as number);
}

function searchSnapshotId(workspaceId: string, query: string, options: SearchOptions, snapshotXor: Buffer): string {
  return createHash("sha256").update(workspaceId).update("\0").update(query).update("\0").update(options.mode).update(options.caseSensitive ? "1" : "0")
    .update(String(options.contextBefore)).update(":").update(String(options.contextAfter)).update("\0")
    .update(options.includeGlobs.map((item) => item.source).join("\0")).update("\0").update(options.excludeGlobs.map((item) => item.source).join("\0"))
    .update(snapshotXor).digest("hex").slice(0, 16);
}

function parseIgnoreRules(content: string, base: string, remaining: number): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (rules.length >= remaining) break;
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let negative = false;
    if (line.startsWith("!")) { negative = true; line = line.slice(1); }
    if (line === "") continue;
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (line === "") continue;
    const prefix = base === "" ? "" : `${escapeRegex(base)}/`;
    const body = globBody(line);
    const hasSlash = line.includes("/");
    const exactSource = anchored || hasSlash ? `^${prefix}${body}$` : `^${prefix}(?:.*/)?${body}$`;
    const source = anchored || hasSlash ? `^${prefix}${body}(?:/.*)?$` : `^${prefix}(?:.*/)?${body}(?:/.*)?$`;
    const flags = process.platform === "win32" ? "i" : "";
    rules.push({ negative, directoryOnly, matcher: new RegExp(source, flags), exactMatcher: new RegExp(exactSource, flags) });
  }
  return rules;
}

function isIgnored(path: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (!rule.matcher.test(path)) continue;
    if (rule.directoryOnly && !isDirectory && rule.exactMatcher.test(path)) continue;
    ignored = !rule.negative;
  }
  return ignored;
}

function escapeRegex(value: string): string { return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&"); }

async function openNoFollow(path: string, nonBlocking = false): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    // Windows does not expose O_NOFOLLOW; keep the explicit lstat guard for
    // symlink/junction leaves on that platform as well. POSIX still relies on
    // the kernel no-follow flag for the final check/use race.
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink()) throw symlinkEscape();
    const flags = constants.O_RDONLY | (nonBlocking ? (constants.O_NONBLOCK ?? 0) : 0) | (constants.O_NOFOLLOW ?? 0);
    return await open(path, flags);
  } catch (error) {
    if (error instanceof PathPolicyError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw symlinkEscape();
    throw error;
  }
}

function symlinkEscape(): PathPolicyError { return new PathPolicyError("symlink_escape", "symlink paths are not allowed"); }
function sameIdentity(info: { readonly dev: number; readonly ino: number }, snapshot: PathSnapshot): boolean {
  return info.dev === snapshot.device && info.ino === snapshot.inode;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("params must be an object");
  return value as Record<string, unknown>;
}
function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid pagination value");
  return value as number;
}
