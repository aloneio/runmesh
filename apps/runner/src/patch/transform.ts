import { conflict } from "./values.js";
import type { Hunk } from "./contracts.js";
import { MAX_MATCH_COMPARISONS } from "./limits.js";
import { MAX_TEXT_FILE_BYTES } from "./limits.js";
import type { PatchLine } from "./contracts.js";
import { RpcRuntimeError } from "../errors.js";
import type { TextFile } from "./contracts.js";

export function applyHunks(file: TextFile, hunks: readonly Hunk[], path: string): Buffer {
  if (hunks.length === 0) throw new RpcRuntimeError("invalid_patch", `Update File requires a hunk: ${path}`);
  type Match = { readonly start: number; readonly end: number; readonly hunk: Hunk };
  const matches: Match[] = [];
  let comparisons = 0;
  for (const hunk of hunks) {
    const old = hunk.lines.filter((line) => line.kind !== "add");
    const found = findMatches(file.lines, old, file.endsWithNewline, MAX_MATCH_COMPARISONS - comparisons);
    comparisons += found.comparisons;
    if (comparisons > MAX_MATCH_COMPARISONS) throw new RpcRuntimeError("invalid_patch", "patch context matching exceeded its work limit");
    const candidates = found.matches;
    if (candidates.length === 0) {
      throw conflict("hunk_not_found", `hunk context was not found exactly once: ${path}`, { path, ...hunkConflictContext(file.lines, old) });
    }
    if (candidates.length > 1) {
      throw conflict("hunk_ambiguous", `hunk context matched more than once: ${path}`, { path, matches: candidates.length, candidate_lines: candidates.slice(0, 8).map((line) => line + 1), ...hunkConflictContext(file.lines, old) });
    }
    const start = candidates[0] as number;
    matches.push({ start, end: start + old.length, hunk });
  }
  const ordered = [...matches].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as Match;
    const current = ordered[index] as Match;
    if (current.start < previous.end) {
      throw conflict("hunk_overlap", `hunks overlap in ${path}`, { path });
    }
  }

  const output: string[] = [];
  let cursor = 0;
  let endsWithNewline = file.endsWithNewline;
  for (const match of ordered) {
    output.push(...file.lines.slice(cursor, match.start));
    const replacement = match.hunk.lines.filter((line) => line.kind !== "delete");
    output.push(...replacement.map((line) => line.text));
    if (match.end === file.lines.length) {
      const last = replacement[replacement.length - 1];
      // The hunk rewrites the end of the file, so it alone decides the trailing
      // newline. When it deletes the trailing lines without adding any, the
      // preceding line becomes the new last line and still ends with a newline
      // (it was followed by more content in the original), so the flag must be
      // preserved rather than cleared by the removal. Only an empty result or an
      // explicit no-newline marker on the final replacement line clears it.
      endsWithNewline = replacement.length === 0 ? output.length > 0 : last?.noNewline !== true;
    }
    cursor = match.end;
  }
  output.push(...file.lines.slice(cursor));
  return renderText({ ...file, lines: output, endsWithNewline });
}

function hunkConflictContext(lines: readonly string[], old: readonly PatchLine[]): { readonly context_start_line: number; readonly context: readonly string[] } {
  const first = old[0]?.text;
  let anchor = 0;
  if (first !== undefined) {
    const exact = lines.findIndex((line) => line === first);
    if (exact >= 0) anchor = exact;
    else {
      const needle = first.slice(0, Math.min(first.length, 64));
      if (needle.length > 0) {
        const partial = lines.findIndex((line) => line.includes(needle));
        if (partial >= 0) anchor = partial;
      }
    }
  }
  const start = Math.max(0, anchor - 3);
  return { context_start_line: start + 1, context: lines.slice(start, start + 8).map((line) => line.slice(0, 1_024)) };
}

function findMatches(lines: readonly string[], old: readonly PatchLine[], endsWithNewline: boolean, budget: number): { readonly matches: readonly number[]; readonly comparisons: number } {
  if (old.length === 0) return { matches: [], comparisons: 0 };
  const matches: number[] = [];
  let comparisons = 0;
  for (let start = 0; start + old.length <= lines.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < old.length; offset += 1) {
      comparisons += 1;
      if (comparisons > budget) return { matches, comparisons };
      const expected = old[offset] as PatchLine;
      if (lines[start + offset] !== expected.text) { match = false; break; }
      if (expected.noNewline && (start + offset !== lines.length - 1 || endsWithNewline)) { match = false; break; }
    }
    if (match) matches.push(start);
  }
  return { matches, comparisons };
}

export function renderAddedFile(lines: readonly PatchLine[]): Buffer {
  if (lines.some((line) => line.kind !== "add")) throw new RpcRuntimeError("invalid_patch", "Add File contains invalid line type");
  if (lines.length === 0) return Buffer.alloc(0);
  const final = lines[lines.length - 1];
  return Buffer.from(`${lines.map((line) => line.text).join("\n")}${final?.noNewline ? "" : "\n"}`, "utf8");
}

export function parseText(bytes: Buffer, path: string): TextFile {
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new RpcRuntimeError("file_too_large", `text file exceeds ${MAX_TEXT_FILE_BYTES} bytes: ${path}`);
  const bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    throw new RpcRuntimeError("not_utf8", `file is not valid UTF-8 text: ${path}`, { path });
  }
  const crlf = text.includes("\r\n");
  const lf = /(^|[^\r])\n/.test(text);
  if (crlf && lf) throw new RpcRuntimeError("mixed_newlines", `file has mixed newline styles: ${path}`, { path });
  if (text.includes("\r") && !crlf) throw new RpcRuntimeError("mixed_newlines", `file has unsupported carriage returns: ${path}`, { path });
  const newline: "\n" | "\r\n" = crlf ? "\r\n" : "\n";
  const endsWithNewline = text.endsWith(newline);
  const lines = text.length === 0 ? [] : text.split(newline);
  if (endsWithNewline) lines.pop();
  return { bom, newline, endsWithNewline, lines };
}

function renderText(file: TextFile): Buffer {
  if (file.lines.length === 0) return file.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return Buffer.from(`${file.bom ? "\ufeff" : ""}${file.lines.join(file.newline)}${file.endsWithNewline ? file.newline : ""}`, "utf8");
}
