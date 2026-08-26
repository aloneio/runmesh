import { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { PathPolicy } from "./path-policy.js";
import { utf8ForwardBoundary, utf8SafePrefixLength } from "./utf8-pagination.js";

const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 1_000;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_DIRECTORIES = 1_000;
const MAX_SEARCH_DEPTH = 16;
const MAX_SEARCH_CURSOR = 100_000;
const COMMON_HUGE_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", ".cache"]);

type SearchResult = { path: string; line: number; text: string };
type SearchBudget = { bytes: number; directories: number; truncated: boolean };

export class FilesystemService {
  public constructor(private readonly policy: PathPolicy) {}

  /** Return bounded metadata without decoding file contents. */
  public async stat(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const { workspace, path } = await this.policy.resolve(params.workspace_id, params.path, "read");
    const info = await stat(path);
    const relativePath = relative(workspace.rootPath, path).split(sep).join("/");
    if (!info.isFile()) {
      return { workspace_id: workspace.workspaceId, path: relativePath, type: info.isDirectory() ? "directory" : "other", size: info.size, modified_at_ms: info.mtimeMs };
    }
    const utf8 = await readSample(path, Math.min(info.size, 4 * 1024));
    const binary = !utf8;
    return { workspace_id: workspace.workspaceId, path: relativePath, type: "file", size: info.size, modified_at_ms: info.mtimeMs, encoding: binary ? "binary" : "utf-8", binary };
  }

  public async read(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    const { workspace, path } = await this.policy.resolve(params.workspace_id, params.path, "read");
    const requestedOffset = boundedInteger(params.cursor ?? params.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const requested = boundedInteger(params.limit, 1, MAX_READ_BYTES, MAX_READ_BYTES);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("path is not a file");
    const rawStart = Math.min(requestedOffset, info.size);
    const probeStart = Math.max(0, rawStart - 3);
    const handle = await open(path, "r");
    try {
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
    const { workspace, path } = await this.policy.resolve(params.workspace_id, params.path ?? ".", "list");
    const entries = await readdir(path, { withFileTypes: true });
    const limit = boundedInteger(params.limit, 1, 256, 200);
    const offset = boundedInteger(params.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
    const page = entries.slice(offset, offset + limit).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
    const next = offset + page.length;
    return { workspace_id: workspace.workspaceId, path: relative(workspace.rootPath, path).split(sep).join("/"), entries: page, next_cursor: next < entries.length ? String(next) : null, truncated: next < entries.length };
  }

  public async search(input: unknown): Promise<Record<string, unknown>> {
    const params = object(input);
    if (typeof params.query !== "string" || params.query.length === 0 || params.query.length > 512) throw new Error("query must be a non-empty string");
    const { workspace, path } = await this.policy.resolve(params.workspace_id, params.path ?? ".", "search");
    const limit = boundedInteger(params.max_results ?? params.limit, 1, 256, 100);
    const offset = boundedInteger(params.cursor, 0, MAX_SEARCH_CURSOR, 0);
    const results: SearchResult[] = [];
    const budget: SearchBudget = { bytes: 0, directories: 0, truncated: false };
    await this.searchDirectory(workspace.workspaceId, workspace.rootPath, path, params.query, results, budget, 0, Math.min(MAX_SEARCH_RESULTS, offset + limit + 1));
    const page = results.slice(offset, offset + limit);
    const next = offset + page.length;
    const more = results.length > next;
    return { workspace_id: workspace.workspaceId, query: params.query, results: page, next_cursor: more ? String(next) : null, truncated: budget.truncated || more };
  }

  private async searchDirectory(
    workspaceId: string,
    root: string,
    directory: string,
    query: string,
    results: SearchResult[],
    budget: SearchBudget,
    depth: number,
    resultLimit: number,
  ): Promise<void> {
    if (budget.truncated || results.length >= resultLimit) return;
    if (depth > MAX_SEARCH_DEPTH || budget.directories >= MAX_SEARCH_DIRECTORIES) { budget.truncated = true; return; }
    budget.directories += 1;
    let entries: Dirent<string>[];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget.truncated || results.length >= resultLimit) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && COMMON_HUGE_DIRECTORIES.has(entry.name)) continue;
      const childRelative = relative(root, `${directory}${sep}${entry.name}`).split(sep).join("/");
      let resolved: Awaited<ReturnType<PathPolicy["resolve"]>>;
      try { resolved = await this.policy.resolve(workspaceId, childRelative, "search"); } catch { continue; }
      let info: Awaited<ReturnType<typeof stat>>;
      try { info = await stat(resolved.path); } catch { continue; }
      if (info.isDirectory()) {
        await this.searchDirectory(workspaceId, root, resolved.path, query, results, budget, depth + 1, resultLimit);
        continue;
      }
      if (!info.isFile() || info.size > MAX_SEARCH_FILE_BYTES || budget.bytes + info.size > MAX_SEARCH_TOTAL_BYTES) {
        if (info.isFile() && budget.bytes + info.size > MAX_SEARCH_TOTAL_BYTES) budget.truncated = true;
        continue;
      }
      budget.bytes += info.size;
      const content = await readUtf8File(resolved.path, info.size).catch(() => undefined);
      if (content === undefined) continue;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (line.includes(query)) results.push({ path: childRelative, line: index + 1, text: line.slice(0, 4_096) });
        if (results.length >= resultLimit || results.length >= MAX_SEARCH_RESULTS) { budget.truncated = results.length >= MAX_SEARCH_RESULTS; return; }
      }
    }
  }
}

async function readSample(path: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(sample); return true; } catch { return false; }
  } finally { await handle.close(); }
}

async function readUtf8File(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const data = Buffer.alloc(size);
    const { bytesRead } = await handle.read(data, 0, size, 0);
    const sample = data.subarray(0, bytesRead);
    if (sample.includes(0)) throw new Error("binary file");
    return new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } finally {
    await handle.close();
  }
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
