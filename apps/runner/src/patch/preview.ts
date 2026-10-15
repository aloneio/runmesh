import { createHash } from "node:crypto";
import { hash } from "./values.js";
import type { PlannedChange } from "./contracts.js";

export function changeReceipt(change: PlannedChange): { readonly path: string; readonly status: "updated" | "created" | "deleted"; readonly before_hash: string | null; readonly after_hash: string | null; readonly mode: number | null } {
  return {
    path: change.path.relativePath,
    status: change.action === "write" ? (change.baseline.exists ? "updated" : "created") : "deleted",
    before_hash: change.baseline.hash,
    after_hash: change.action === "write" ? hash(change.bytes as Buffer) : null,
    mode: change.action === "write" ? change.mode ?? null : null,
  };
}

export function patchPreviewId(workspaceId: string, generation: number, patch: string, changes: readonly ReturnType<typeof changeReceipt>[]): string {
  return createHash("sha256")
    .update(workspaceId).update("\0").update(String(generation)).update("\0")
    .update(createHash("sha256").update(patch).digest())
    .update(JSON.stringify([...changes].sort((left, right) => left.path.localeCompare(right.path))))
    .digest("hex");
}

export function changePreview(change: PlannedChange): Record<string, unknown> & { insertions: number; deletions: number } {
  if (change.previewHunks !== undefined) return hunkPreview(change);
  const before = change.baseline.bytes === undefined ? [] : decodePreviewLines(change.baseline.bytes);
  const after = change.action === "write" ? decodePreviewLines(change.bytes as Buffer) : [];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const maxLines = 24;
  const shownRemoved = removed.slice(0, maxLines);
  const remaining = Math.max(0, maxLines - shownRemoved.length);
  const shownAdded = added.slice(0, remaining);
  const maxLineLength = 1_024;
  const maxDiffLength = 16 * 1_024;
  const contentTruncated = shownRemoved.length < removed.length || shownAdded.length < added.length
    || shownRemoved.some((line) => line.length > maxLineLength) || shownAdded.some((line) => line.length > maxLineLength);
  const diff = [
    `--- a/${change.path.relativePath}`,
    `+++ b/${change.path.relativePath}`,
    `@@ line ${prefix + 1} @@`,
    ...shownRemoved.map((line) => `-${line.slice(0, maxLineLength)}`),
    ...shownAdded.map((line) => `+${line.slice(0, maxLineLength)}`),
    ...(contentTruncated ? ["... preview truncated ..."] : []),
  ].join("\n");
  return {
    path: change.path.relativePath,
    status: change.action === "write" ? (change.baseline.exists ? "updated" : "created") : "deleted",
    insertions: added.length,
    deletions: removed.length,
    diff: diff.slice(0, maxDiffLength),
    truncated: contentTruncated || diff.length > maxDiffLength,
  };
}

function hunkPreview(change: PlannedChange): Record<string, unknown> & { insertions: number; deletions: number } {
  const maxLines = 24;
  const maxLineLength = 1_024;
  const maxDiffLength = 16 * 1_024;
  let insertions = 0;
  let deletions = 0;
  let shown = 0;
  let contentTruncated = false;
  const lines = [
    `--- a/${change.path.relativePath}`,
    `+++ b/${change.path.relativePath}`,
  ];
  for (const hunk of change.previewHunks ?? []) {
    if (shown >= maxLines) { contentTruncated = true; break; }
    lines.push("@@");
    for (const line of hunk.lines) {
      if (line.kind === "add") insertions += 1;
      else if (line.kind === "delete") deletions += 1;
      if (shown >= maxLines) { contentTruncated = true; continue; }
      const prefix = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
      if (line.text.length > maxLineLength) contentTruncated = true;
      lines.push(`${prefix}${line.text.slice(0, maxLineLength)}`);
      shown += 1;
    }
  }
  // Totals must describe the complete validated patch even if the display
  // excerpt reaches its line budget.
  if (contentTruncated) {
    insertions = 0;
    deletions = 0;
    for (const hunk of change.previewHunks ?? []) {
      for (const line of hunk.lines) {
        if (line.kind === "add") insertions += 1;
        else if (line.kind === "delete") deletions += 1;
      }
    }
    lines.push("... preview truncated ...");
  }
  const diff = lines.join("\n");
  return {
    path: change.path.relativePath,
    status: "updated",
    insertions,
    deletions,
    diff: diff.slice(0, maxDiffLength),
    truncated: contentTruncated || diff.length > maxDiffLength,
  };
}

function decodePreviewLines(bytes: Buffer): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\ufeff/u, "");
  const lines = text.split(/\r?\n/u);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
