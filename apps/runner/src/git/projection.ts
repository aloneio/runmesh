import { MAX_FRAME_BYTES } from "@aloneio/runmesh-protocol";
import { MAX_REQUEST_ID_BYTES } from "./limits.js";
import type { ParsedStatus } from "./contracts.js";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { RpcRuntimeError } from "../errors.js";
import type { StatusEntry } from "./contracts.js";

export function completeNulRecords(output: Buffer): { readonly output: Buffer; readonly truncated: boolean } {
  if (output.byteLength === 0 || output[output.byteLength - 1] === 0) return { output, truncated: false };
  const boundary = output.lastIndexOf(0);
  return { output: boundary < 0 ? Buffer.alloc(0) : output.subarray(0, boundary + 1), truncated: true };
}

export function parseStatus(output: Buffer): ParsedStatus {
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

export function fitStatusResult(input: {
  readonly workspaceId: string;
  readonly path: string;
  readonly parsed: ParsedStatus;
  readonly outputBytes: number;
  readonly truncated: boolean;
}): Record<string, unknown> {
  const entries = input.parsed.entries;
  const resultFor = (kept: readonly StatusEntry[], truncated: boolean): Record<string, unknown> => ({
    workspace_id: input.workspaceId,
    path: input.path,
    branch: input.parsed.branch,
    entries: kept,
    ...(input.parsed.ahead === undefined ? {} : { ahead: input.parsed.ahead }),
    ...(input.parsed.behind === undefined ? {} : { behind: input.parsed.behind }),
    truncated,
    output_bytes: input.outputBytes,
  });
  if (responseFits(resultFor(entries, input.truncated))) return resultFor(entries, input.truncated);
  // A status list can be arbitrarily long, so re-serializing the whole response
  // after every single removal is quadratic. Binary-search the longest prefix
  // that still fits, exactly as the diff path does.
  const kept = fitPrefix(entries, (prefix) => responseFits(resultFor(prefix, true)));
  if (!responseFits(resultFor(entries.slice(0, kept), true))) throw new RpcRuntimeError("git_output_too_large", "git status metadata cannot fit in one RPC frame");
  return resultFor(entries.slice(0, kept), true);
}

export function fitDiffResult(input: {
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

/**
 * Length of the longest prefix that `fits` accepts, assuming `fits` is
 * monotonic (when a prefix does not fit, no longer prefix fits either).
 * Locating it by binary search keeps truncation logarithmic in the number of
 * serialized candidates instead of re-serializing the whole response after
 * every single removal.
 */
export function fitPrefix<T>(items: readonly T[], fits: (prefix: readonly T[]) => boolean): number {
  let low = 0;
  let high = items.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(items.slice(0, middle))) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function utf8SafePrefix<T extends Uint8Array>(output: T): T {
  // Git may emit arbitrary byte names.  Validate the prefix in one forward
  // pass instead of repeatedly asking TextDecoder to decode a shorter suffix
  // (which made a long malformed result O(n²)).  Stop at the first malformed
  // or incomplete code point; the bytes before it are a valid UTF-8 prefix.
  let offset = 0;
  while (offset < output.byteLength) {
    const first = output[offset] ?? 0;
    let width: 1 | 2 | 3 | 4;
    if (first <= 0x7f) width = 1;
    else if (first >= 0xc2 && first <= 0xdf) width = 2;
    else if (first >= 0xe0 && first <= 0xef) width = 3;
    else if (first >= 0xf0 && first <= 0xf4) width = 4;
    else break;
    if (offset + width > output.byteLength) break;
    const second = output[offset + 1] ?? 0;
    const third = output[offset + 2] ?? 0;
    const fourth = output[offset + 3] ?? 0;
    if ((width >= 2 && !isUtf8ContinuationByte(second))
      || (width >= 3 && !isUtf8ContinuationByte(third))
      || (width >= 4 && !isUtf8ContinuationByte(fourth))) break;
    // Exclude overlong encodings, UTF-16 surrogate code points, and values
    // beyond U+10FFFF. TextDecoder({ fatal:true }) rejects all three too.
    if ((first === 0xe0 && second < 0xa0)
      || (first === 0xed && second >= 0xa0)
      || (first === 0xf0 && second < 0x90)
      || (first === 0xf4 && second >= 0x90)) break;
    offset += width;
  }
  // Preserve the concrete byte-array subtype (notably Node's Buffer) at
  // runtime while keeping the published declaration independent of
  // @types/node.  The helper is also useful to browser-compatible consumers
  // that only have a Uint8Array.
  return output.subarray(0, offset) as T;
}

function isUtf8ContinuationByte(value: number): boolean { return value >= 0x80 && value <= 0xbf; }
