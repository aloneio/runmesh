import { copySafeCursorFields } from "./primitives.js";
import { copySafeInteger } from "./primitives.js";
import { copySafeRelativePath } from "./primitives.js";
import { copySafeWorkspaceId } from "./primitives.js";
import { hasControlCharacters } from "./primitives.js";
import type { InspectResultKind } from "../contracts.js";
import { isRecord } from "./primitives.js";
import { isSafeCursor } from "./primitives.js";
import { isSafeMode } from "./primitives.js";
import { isSafeNonnegativeInteger } from "./primitives.js";
import { isSafePositiveInteger } from "./primitives.js";
import { isSha256 } from "./primitives.js";
import { projectBytePageMetadata } from "../byte-pages.js";
import { safeDirectoryName } from "./primitives.js";
import { safeRelativePathValue } from "./primitives.js";

/**
 * Project filesystem read results at the MCP boundary.  A current Runner
 * emits workspace-relative paths, but a stale or compromised peer is still
 * untrusted: absolute/UNC/drive-qualified paths are omitted instead of being
 * allowed through the generic redactor.
 */
export function safeReadResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  copySafeRelativePath(value, output, "path");
  if (typeof value.data === "string") output.data = value.data.slice(0, 65_536);
  if (value.encoding === "utf-8" || value.encoding === "utf8") output.encoding = "utf-8";
  if (isSafeNonnegativeInteger(value.offset)) output.offset = value.offset;
  if (value.next_cursor === null || isSafeCursor(value.next_cursor)) output.next_cursor = value.next_cursor;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
  if (isSafeNonnegativeInteger(value.size)) output.size = value.size;
  projectBytePageMetadata(value, output, "file");
  return output;
}

/** Project each inspect operation without exposing host roots or raw errors. */
export function safeInspectResult(value: unknown, kind: InspectResultKind): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  if (kind === "stat") {
    copySafeRelativePath(value, output, "path");
    if (value.type === "file" || value.type === "directory" || value.type === "other") output.type = value.type;
    if (isSafeNonnegativeInteger(value.size)) output.size = value.size;
    if (isSafeNonnegativeInteger(value.modified_at_ms)) output.modified_at_ms = value.modified_at_ms;
    if (value.encoding === "utf-8" || value.encoding === "binary") output.encoding = value.encoding;
    if (typeof value.binary === "boolean") output.binary = value.binary;
    return output;
  }
  if (kind === "list") {
    copySafeRelativePath(value, output, "path");
    if (Array.isArray(value.entries)) {
      output.entries = value.entries.slice(0, 256).flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.name !== "string" || !safeDirectoryName(entry.name)) return [];
        const type = entry.type === "file" || entry.type === "directory" || entry.type === "other" ? entry.type : undefined;
        return type === undefined ? [] : [{ name: entry.name, type }];
      });
    }
    copySafeCursorFields(value, output);
    return output;
  }
  if (kind === "search") {
    if (typeof value.query === "string" && value.query.length <= 512 && !hasControlCharacters(value.query)) output.query = value.query;
    if (value.mode === "literal" || value.mode === "filename") output.mode = value.mode;
    if (typeof value.case_sensitive === "boolean") output.case_sensitive = value.case_sensitive;
    if (value.engine === "builtin_literal" || value.engine === "builtin_filename") output.engine = value.engine;
    if (typeof value.snapshot_id === "string" && /^[a-f0-9]{16}$/u.test(value.snapshot_id)) output.snapshot_id = value.snapshot_id;
    if (Array.isArray(value.results)) {
      output.results = value.results.slice(0, 256).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const path = safeRelativePathValue(entry.path);
        if (path === undefined || !isSafePositiveInteger(entry.line) || typeof entry.text !== "string") return [];
        const item: Record<string, unknown> = { path, line: entry.line, text: entry.text.slice(0, 4_096) };
        if (isSafePositiveInteger(entry.column)) item.column = entry.column;
        if (typeof entry.match === "string") item.match = entry.match.slice(0, 1_024);
        for (const key of ["context_before", "context_after"] as const) {
          if (!Array.isArray(entry[key])) continue;
          item[key] = entry[key].slice(0, 8).flatMap((contextLine) => isRecord(contextLine) && isSafePositiveInteger(contextLine.line) && typeof contextLine.text === "string" ? [{ line: contextLine.line, text: contextLine.text.slice(0, 4_096) }] : []);
        }
        return [item];
      });
    }
    copySafeCursorFields(value, output);
    if (value.next_snapshot_cursor === null || (typeof value.next_snapshot_cursor === "string" && /^s1:[a-f0-9]{16}:\d+$/u.test(value.next_snapshot_cursor))) output.next_snapshot_cursor = value.next_snapshot_cursor;
    if (["time_budget", "byte_budget", "directory_budget", "entry_budget", "file_budget", "result_budget", "response_bytes"].includes(String(value.truncated_reason))) output.truncated_reason = value.truncated_reason;
    if (isRecord(value.scanned)) {
      const scanned: Record<string, unknown> = {};
      for (const key of ["bytes", "files", "directories", "entries"] as const) if (isSafeNonnegativeInteger(value.scanned[key])) scanned[key] = value.scanned[key];
      output.scanned = scanned;
    }
    copySafeInteger(value, output, "returned_bytes");
    return output;
  }
  if (kind === "git_status") {
    copySafeRelativePath(value, output, "path");
    if (isRecord(value.branch)) {
      const branch: Record<string, unknown> = {};
      for (const key of ["oid", "head", "upstream"] as const) {
        if (typeof value.branch[key] === "string" && value.branch[key].length <= 512 && !hasControlCharacters(value.branch[key] as string)) branch[key] = value.branch[key];
      }
      output.branch = branch;
    }
    if (Array.isArray(value.entries)) {
      output.entries = value.entries.slice(0, 1_000).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const path = safeRelativePathValue(entry.path);
        if (path === undefined) return [];
        const item: Record<string, unknown> = { path };
        for (const key of ["original_path"] as const) {
          const original = safeRelativePathValue(entry[key]);
          if (original !== undefined) item[key] = original;
        }
        for (const key of ["index_status", "worktree_status"] as const) {
          if (typeof entry[key] === "string" && entry[key].length <= 8 && !hasControlCharacters(entry[key] as string)) item[key] = entry[key];
        }
        if (typeof entry.untracked === "boolean") item.untracked = entry.untracked;
        if (typeof entry.ignored === "boolean") item.ignored = entry.ignored;
        return [item];
      });
    }
    copySafeInteger(value, output, "ahead");
    copySafeInteger(value, output, "behind");
    copySafeInteger(value, output, "output_bytes");
    if (typeof value.truncated === "boolean") output.truncated = value.truncated;
    return output;
  }
  if (kind === "git_log") {
    copySafeRelativePath(value, output, "path");
    if (Array.isArray(value.commits)) output.commits = value.commits.slice(0, 100).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.oid !== "string" || !/^[0-9a-f]{40,64}$/i.test(entry.oid)) return [];
      return [{ oid: entry.oid, author: typeof entry.author === "string" ? entry.author.slice(0, 512) : "", date: typeof entry.date === "string" ? entry.date.slice(0, 64) : "", subject: typeof entry.subject === "string" ? entry.subject.slice(0, 4096) : "" }];
    });
    copySafeInteger(value, output, "limit");
    if (typeof value.truncated === "boolean") output.truncated = value.truncated;
    return output;
  }
  if (kind === "git_show" || kind === "git_blame") {
    copySafeRelativePath(value, output, "path");
    if (typeof value.revision === "string") output.revision = value.revision;
    for (const key of ["start_line", "end_line"] as const) copySafeInteger(value, output, key);
    if (typeof value.output === "string") output.output = value.output.slice(0, 65_536);
    if (value.encoding === "utf-8") output.encoding = "utf-8";
    copySafeInteger(value, output, "bytes");
    if (typeof value.truncated === "boolean") output.truncated = value.truncated;
    return output;
  }
  // git_diff.  GitService returns `path`, `diff`, `encoding`, and `bytes`;
  // keep those names stable at the MCP boundary (and accept the older
  // aliases only for compatibility with pre-privileged Runners).
  const path = safeRelativePathValue(value.path) ?? safeRelativePathValue(value.requested_path);
  if (path !== undefined) output.path = path;
  if (typeof value.staged === "boolean") output.staged = value.staged;
  const diff = typeof value.diff === "string" ? value.diff : value.output;
  if (typeof diff === "string") output.diff = diff.slice(0, 65_536);
  if (value.encoding === "utf-8" || value.encoding === "utf8") output.encoding = "utf-8";
  const bytes = value.bytes ?? value.output_bytes;
  if (isSafeNonnegativeInteger(bytes)) output.bytes = bytes;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
  return output;
}

/** Return only workspace-relative patch metadata; recovery paths/errors stay local to the Runner. */
export function safeEditResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  copySafeWorkspaceId(value, output);
  if (isSha256(value.preview_id)) output.preview_id = value.preview_id;
  for (const key of ["insertions", "deletions"] as const) copySafeInteger(value, output, key);
  if (typeof value.previews_truncated === "boolean") output.previews_truncated = value.previews_truncated;
  if (Array.isArray(value.changed_paths)) {
    output.changed_paths = value.changed_paths.slice(0, 128).flatMap((item) => safePatchChange(item));
  }
  if (Array.isArray(value.operations)) {
    output.operations = value.operations.slice(0, 128).flatMap((item) => safePatchOperation(item));
  }
  if (Array.isArray(value.previews)) {
    output.previews = value.previews.slice(0, 128).flatMap((item) => {
      if (!isRecord(item)) return [];
      const path = safeRelativePathValue(item.path);
      if (path === undefined || typeof item.diff !== "string") return [];
      const preview: Record<string, unknown> = { path, diff: item.diff.slice(0, 16 * 1_024) };
      if (item.status === "created" || item.status === "updated" || item.status === "deleted") preview.status = item.status;
      for (const key of ["insertions", "deletions"] as const) if (isSafeNonnegativeInteger(item[key])) preview[key] = item[key];
      if (typeof item.truncated === "boolean") preview.truncated = item.truncated;
      return [preview];
    });
  }
  if (Array.isArray(value.warnings)) {
    output.warnings = value.warnings.slice(0, 128).flatMap((item) => {
      if (!isRecord(item)) return [];
      const path = safeRelativePathValue(item.path);
      return path === undefined ? [] : [{ path, code: "recovery_required" }];
    });
  }
  return output;
}

function safePatchChange(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const path = safeRelativePathValue(value.path);
  if (path === undefined) return [];
  const status = value.status === "created" || value.status === "updated" || value.status === "deleted" ? value.status : undefined;
  if (status === undefined) return [];
  const result: Record<string, unknown> = { path, status };
  for (const key of ["before_hash", "after_hash"] as const) {
    if (value[key] === null || isSha256(value[key])) result[key] = value[key];
  }
  if (isSafeMode(value.mode)) result.mode = value.mode;
  return [result];
}

function safePatchOperation(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const path = safeRelativePathValue(value.path);
  if (path === undefined) return [];
  const operation = value.operation === "add" || value.operation === "update" || value.operation === "delete" || value.operation === "move" ? value.operation : undefined;
  if (operation === undefined || value.status !== "applied") return [];
  const result: Record<string, unknown> = { operation, path, status: "applied" };
  const destination = safeRelativePathValue(value.destination);
  if (destination !== undefined) result.destination = destination;
  if (Array.isArray(value.results)) result.results = value.results.slice(0, 128).flatMap((item) => safePatchChange(item));
  return [result];
}
