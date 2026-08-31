import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { relative, sep } from "node:path";
import { PathPolicyError, type PathPolicy, type PathSnapshot } from "./path-policy.js";
import type { WorkspaceConfig } from "./config.js";
import { utf8ForwardBoundary, utf8SafePrefixLength } from "./utf8-pagination.js";

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_DIRECTORIES = 1_000;
const MAX_SEARCH_DEPTH = 16;
// Directory cursors are entry indexes, so serving an arbitrarily large cursor
// would require scanning every preceding entry even though each response is
// capped at 256 items. Keep the worst-case scan bounded and fail closed for
// cursors beyond the supported window.
const MAX_LIST_CURSOR = 100_000;
const MAX_SEARCH_CURSOR = 100_000;
const COMMON_HUGE_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", ".cache"]);

type SearchResult = { path: string; line: number; text: string };
type SearchBudget = { bytes: number; directories: number; truncated: boolean };
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
      const end = start + used;
      return {
        workspace_id: workspace.workspaceId, path: relative(workspace.rootPath, path).split(sep).join("/"),
        data: actual.subarray(0, used).toString("utf8"), encoding: "utf-8", offset: start,
        next_cursor: end < info.size ? String(end) : null, truncated: end < info.size, size: info.size,
      };
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
    const next = offset + page.length;
    const canContinue = hasMore && next < MAX_LIST_CURSOR;
    return { workspace_id: workspace.workspaceId, path: relative(workspace.rootPath, path).split(sep).join("/"), entries: page, next_cursor: canContinue ? String(next) : null, truncated: hasMore };
  }

  public async search(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    if (typeof params.query !== "string" || params.query.length === 0 || params.query.length > 512) throw new Error("query must be a non-empty string");
    const resolved = await this.policy.resolve(params.workspace_id, params.path ?? ".", "search");
    const { workspace } = resolved;
    const limit = boundedInteger(params.max_results ?? params.limit, 1, 256, 100);
    const offset = boundedInteger(params.cursor, 0, MAX_SEARCH_CURSOR, 0);
    const results: SearchResult[] = [];
    const budget: SearchBudget = { bytes: 0, directories: 0, truncated: false };
    const snapshot = await this.policy.snapshot(resolved);
    if (snapshot.type !== "directory") throw new Error("path is not a directory");
    await this.searchDirectory(resolved, snapshot, params.query, results, budget, 0, Math.min(MAX_SEARCH_RESULTS, offset + limit + 1));
    const page = results.slice(offset, offset + limit);
    const next = offset + page.length;
    const more = results.length > next;
    return { workspace_id: workspace.workspaceId, query: params.query, results: page, next_cursor: more ? String(next) : null, truncated: budget.truncated || more };
  }

  private async searchDirectory(
    resolvedDirectory: { readonly workspace: WorkspaceConfig; readonly path: string },
    directorySnapshot: PathSnapshot,
    query: string,
    results: SearchResult[],
    budget: SearchBudget,
    depth: number,
    resultLimit: number,
  ): Promise<void> {
    if (budget.truncated || results.length >= resultLimit) return;
    if (depth > MAX_SEARCH_DEPTH || budget.directories >= MAX_SEARCH_DIRECTORIES) { budget.truncated = true; return; }
    budget.directories += 1;
    const { workspace, path: directory } = resolvedDirectory;
    try {
      await readDirectoryThroughHandle(this.policy, resolvedDirectory, directorySnapshot, async (entry) => {
        if (budget.truncated || results.length >= resultLimit) return false;
        if (entry.isSymbolicLink()) return true;
        if (entry.isDirectory() && COMMON_HUGE_DIRECTORIES.has(entry.name)) return true;
        const childRelative = relative(workspace.rootPath, `${directory}${sep}${entry.name}`).split(sep).join("/");
        let resolved: Awaited<ReturnType<PathPolicy["resolve"]>>;
        try { resolved = await this.policy.resolve(workspace.workspaceId, childRelative, "search"); } catch { return true; }
        let snapshot: PathSnapshot;
        try { snapshot = await this.policy.snapshot(resolved); } catch { return true; }
        if (snapshot.type === "directory") {
          await this.searchDirectory(resolved, snapshot, query, results, budget, depth + 1, resultLimit);
          return !budget.truncated && results.length < resultLimit;
        }
        if (snapshot.type !== "file" || snapshot.size > MAX_SEARCH_FILE_BYTES) return true;
        const loaded = await readUtf8FileSecure(this.policy, resolved, snapshot).catch(() => undefined);
        if (loaded === undefined) return true;
        if (budget.bytes + loaded.size > MAX_SEARCH_TOTAL_BYTES) {
          budget.truncated = true;
          return false;
        }
        budget.bytes += loaded.size;
        const content = loaded.content;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          if (line.includes(query)) results.push({ path: childRelative, line: index + 1, text: line.slice(0, 4_096) });
          if (results.length >= resultLimit || results.length >= MAX_SEARCH_RESULTS) {
            budget.truncated = results.length >= MAX_SEARCH_RESULTS;
            return false;
          }
        }
        return true;
      });
    } catch {
      // Search is best-effort over a mutable workspace.  A directory that is
      // removed or replaced while traversing it is skipped, as before.
      return;
    }
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
  const directory = await opendir(resolved.path);
  try {
    // opendir() binds an OS directory handle. Re-check the pathname only after
    // that handle exists; once this succeeds, later ancestor replacement does
    // not redirect Dir.read(). (On Windows Node does not expose dirfd/reparse
    // flags, so an extremely narrow ABA replacement window remains.)
    await policy.verifySnapshot(resolved, snapshot);
    let index = 0;
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      if (!await visit(entry, index)) break;
      index += 1;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function readUtf8FileSecure(
  policy: PathPolicy,
  resolved: { readonly workspace: WorkspaceConfig; readonly path: string },
  snapshot: PathSnapshot,
): Promise<{ readonly content: string; readonly size: number }> {
  const handle = await openNoFollow(resolved.path, true);
  try {
    const info = await handle.stat();
    await policy.verifySnapshot(resolved, snapshot);
    if (!info.isFile() || !sameIdentity(info, snapshot) || info.size > MAX_SEARCH_FILE_BYTES) throw new Error("file is not a bounded regular file");
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset);
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
