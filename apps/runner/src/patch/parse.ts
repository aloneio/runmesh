import type { Hunk } from "./contracts.js";
import { MAX_HUNK_LINES } from "./limits.js";
import { MAX_HUNKS } from "./limits.js";
import { MAX_PATCH_LINES } from "./limits.js";
import { MAX_PATCH_OPERATIONS } from "./limits.js";
import type { PatchLine } from "./contracts.js";
import type { PatchOperation } from "./contracts.js";
import { RpcRuntimeError } from "../errors.js";

export function parsePatch(value: string): readonly PatchOperation[] {
  const lines = value.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.length > MAX_PATCH_LINES) throw new RpcRuntimeError("invalid_patch", `patch has too many lines (maximum ${MAX_PATCH_LINES})`);
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") {
    throw new RpcRuntimeError("invalid_patch", "patch must use *** Begin Patch and *** End Patch envelope");
  }
  const operations: PatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const header = lines[index] as string;
    if (header === "") {
      index += 1;
      continue;
    }
    const add = header.match(/^\*\*\* Add File: (.+)$/);
    const update = header.match(/^\*\*\* Update File: (.+)$/);
    const remove = header.match(/^\*\*\* Delete File: (.+)$/);
    const move = header.match(/^\*\*\* Move File: (.+)$/);
    if (add !== null) {
      assertOperationLimit(operations);
      const body = parseAddBody(lines, index + 1);
      operations.push({ kind: "add", path: patchPath(add[1] as string), lines: body.lines, hunks: [] });
      index = body.next;
      continue;
    }
    if (update !== null) {
      assertOperationLimit(operations);
      const body = parseUpdateBody(lines, index + 1);
      operations.push({ kind: "update", path: patchPath(update[1] as string), ...(body.destination === undefined ? {} : { destination: patchPath(body.destination) }), lines: [], hunks: body.hunks });
      index = body.next;
      continue;
    }
    if (remove !== null) {
      assertOperationLimit(operations);
      const next = consumeToHeader(lines, index + 1, (line) => {
        if (line === "*** End of File") return true;
        if (line.startsWith("*** ")) throw new RpcRuntimeError("invalid_patch", "Delete File cannot contain a patch body");
        if (line !== "") throw new RpcRuntimeError("invalid_patch", "Delete File cannot contain a patch body");
        return true;
      });
      operations.push({ kind: "delete", path: patchPath(remove[1] as string), lines: [], hunks: [] });
      index = next;
      continue;
    }
    if (move !== null) {
      assertOperationLimit(operations);
      const body = parseMoveBody(lines, index + 1);
      operations.push({ kind: "move", path: patchPath(move[1] as string), destination: patchPath(body.destination), lines: [], hunks: body.hunks });
      index = body.next;
      continue;
    }
    throw new RpcRuntimeError("invalid_patch", `unexpected patch line: ${header.slice(0, 80)}`);
  }
  if (operations.length === 0) throw new RpcRuntimeError("invalid_patch", "patch contains no file operations");
  return operations;
}

function parseAddBody(lines: readonly string[], start: number): { readonly lines: readonly PatchLine[]; readonly next: number } {
  const body: PatchLine[] = [];
  let index = start;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] as string)) {
    const line = lines[index] as string;
    if (line === "*** End of File") { index += 1; continue; }
    if (line === "\\ No newline at end of file") {
      markNoNewline(body);
      index += 1;
      continue;
    }
    if (!line.startsWith("+")) throw new RpcRuntimeError("invalid_patch", "Add File body may contain only added lines");
    if (body.length >= MAX_HUNK_LINES) throw new RpcRuntimeError("invalid_patch", `Add File has too many lines (maximum ${MAX_HUNK_LINES})`);
    body.push({ kind: "add", text: line.slice(1), noNewline: false });
    index += 1;
  }
  if (body.some((line) => line.noNewline) && body[body.length - 1]?.noNewline !== true) {
    throw new RpcRuntimeError("invalid_patch", "Add File no-newline marker is allowed only at the end of the file");
  }
  return { lines: body, next: index };
}

function parseMoveBody(lines: readonly string[], start: number): { readonly destination: string; readonly hunks: readonly Hunk[]; readonly next: number } {
  const destinationLine = lines[start];
  const destination = destinationLine?.match(/^\*\*\* Move to: (.+)$/);
  if (destination === null || destination === undefined) throw new RpcRuntimeError("invalid_patch", "Move File must be followed by *** Move to: path");
  const body = parseHunks(lines, start + 1);
  return { destination: destination[1] as string, hunks: body.hunks, next: body.next };
}

function parseUpdateBody(lines: readonly string[], start: number): { readonly destination?: string; readonly hunks: readonly Hunk[]; readonly next: number } {
  let index = start;
  let destination: string | undefined;
  if ((lines[index] as string | undefined)?.startsWith("*** Move to: ")) {
    destination = (lines[index] as string).slice("*** Move to: ".length);
    if (destination.length === 0) throw new RpcRuntimeError("invalid_patch", "Move to path is required");
    index += 1;
  }
  const body = parseHunks(lines, index);
  if (body.hunks.length === 0 && destination === undefined) throw new RpcRuntimeError("invalid_patch", "Update File requires at least one hunk");
  return { ...(destination === undefined ? {} : { destination }), hunks: body.hunks, next: body.next };
}

function parseHunks(lines: readonly string[], start: number): { readonly hunks: readonly Hunk[]; readonly next: number } {
  const hunks: Hunk[] = [];
  let index = start;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] as string)) {
    const marker = lines[index] as string;
    if (marker === "*** End of File") { index += 1; continue; }
    if (!marker.startsWith("@@")) throw new RpcRuntimeError("invalid_patch", "Update or Move body must use @@ hunk markers");
    if (hunks.length >= MAX_HUNKS) throw new RpcRuntimeError("invalid_patch", `patch has too many hunks (maximum ${MAX_HUNKS})`);
    index += 1;
    const hunk: PatchLine[] = [];
    while (index < lines.length - 1 && !isOperationHeader(lines[index] as string) && !(lines[index] as string).startsWith("@@")) {
      const line = lines[index] as string;
      if (line === "\\ No newline at end of file") {
        markNoNewline(hunk);
      } else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        if (hunk.length >= MAX_HUNK_LINES) throw new RpcRuntimeError("invalid_patch", `hunk has too many lines (maximum ${MAX_HUNK_LINES})`);
        hunk.push({ kind: line[0] === "+" ? "add" : line[0] === "-" ? "delete" : "context", text: line.slice(1), noNewline: false });
      } else if (line === "*** End of File") {
        index += 1;
        break;
      } else {
        throw new RpcRuntimeError("invalid_patch", "invalid hunk line");
      }
      index += 1;
    }
    if (hunk.length === 0 || !hunk.some((line) => line.kind !== "add")) {
      throw new RpcRuntimeError("invalid_patch", "each hunk needs non-added context to match");
    }
    validateNoNewlineMarkers(hunk);
    hunks.push({ lines: hunk });
  }
  return { hunks, next: index };
}

function consumeToHeader(lines: readonly string[], start: number, consume: (line: string) => boolean): number {
  let index = start;
  while (index < lines.length - 1 && !isOperationHeader(lines[index] as string)) {
    consume(lines[index] as string);
    index += 1;
  }
  return index;
}

function assertOperationLimit(operations: readonly PatchOperation[]): void {
  if (operations.length >= MAX_PATCH_OPERATIONS) {
    throw new RpcRuntimeError("invalid_patch", `patch has too many operations (maximum ${MAX_PATCH_OPERATIONS})`);
  }
}

function isOperationHeader(line: string): boolean {
  return /^\*\*\* (?:Add|Update|Delete|Move) File: /.test(line);
}

function patchPath(value: string): string {
  if (value.length === 0 || value.length > 4_096) throw new RpcRuntimeError("invalid_patch", "patch path is invalid");
  return value;
}

function markNoNewline(lines: PatchLine[]): void {
  const last = lines[lines.length - 1];
  if (last === undefined || last.noNewline) throw new RpcRuntimeError("invalid_patch", "no-newline marker must follow one patch line");
  (last as { noNewline: boolean }).noNewline = true;
}

function validateNoNewlineMarkers(lines: readonly PatchLine[]): void {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.noNewline && index !== lines.length - 1) {
      throw new RpcRuntimeError("invalid_patch", "no-newline marker is allowed only at the end of a hunk");
    }
  }
}
