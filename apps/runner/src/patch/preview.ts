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
  const diff = [
    `--- a/${change.path.relativePath}`,
    `+++ b/${change.path.relativePath}`,
    `@@ line ${prefix + 1} @@`,
    ...shownRemoved.map((line) => `-${line.slice(0, 1_024)}`),
    ...shownAdded.map((line) => `+${line.slice(0, 1_024)}`),
    ...(shownRemoved.length < removed.length || shownAdded.length < added.length ? ["... preview truncated ..."] : []),
  ].join("\n").slice(0, 16 * 1_024);
  return {
    path: change.path.relativePath,
    status: change.action === "write" ? (change.baseline.exists ? "updated" : "created") : "deleted",
    insertions: added.length,
    deletions: removed.length,
    diff,
    truncated: shownRemoved.length < removed.length || shownAdded.length < added.length || diff.length >= 16 * 1_024,
  };
}

function decodePreviewLines(bytes: Buffer): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\ufeff/u, "");
  const lines = text.split(/\r?\n/u);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
