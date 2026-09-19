import type { Baseline } from "./contracts.js";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { ResolvedOperation } from "./contracts.js";
import type { ResolvedPath } from "./contracts.js";
import { RpcRuntimeError } from "../errors.js";
import { sep } from "node:path";
import { SHA256 } from "./limits.js";

export function checkExpectedHash(value: unknown, baseline: Baseline, path: string): void {
  if (value !== null && (typeof value !== "string" || !SHA256.test(value))) {
    throw new RpcRuntimeError("invalid_params", `expected hash for ${path} must be a lowercase SHA-256 hex digest or null`);
  }
  if (value !== baseline.hash) {
    throw conflict("expected_hash_mismatch", `expected hash does not match baseline: ${path}`, {
      path,
      expected_hash: value as string | null,
      actual_hash: baseline.hash,
    });
  }
}

export function toResolved(value: { workspace: { workspaceId: string; rootPath: string }; path: string }): ResolvedPath {
  return {
    path: value.path,
    relativePath: relative(value.workspace.rootPath, value.path).split(sep).join("/"),
    workspaceId: value.workspace.workspaceId,
  };
}

export function rejectConflictingPaths(operations: readonly ResolvedOperation[]): void {
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const operation of operations) {
    if (operation.source !== undefined) {
      const key = pathKey(operation.source.relativePath);
      if (sources.has(key)) throw new RpcRuntimeError("invalid_patch", `duplicate source path: ${operation.source.relativePath}`);
      sources.add(key);
    }
    if (operation.target !== undefined) {
      const key = pathKey(operation.target.relativePath);
      if (targets.has(key)) throw new RpcRuntimeError("invalid_patch", `duplicate target path: ${operation.target.relativePath}`);
      targets.add(key);
    }
  }
  for (const operation of operations) {
    if (operation.source !== undefined && operation.target === undefined && targets.has(pathKey(operation.source.relativePath))) {
      throw new RpcRuntimeError("invalid_patch", "patch source and target paths conflict");
    }
    if (operation.source === undefined || operation.target === undefined || pathKey(operation.source.relativePath) === pathKey(operation.target.relativePath)) continue;
    if (targets.has(pathKey(operation.source.relativePath)) || sources.has(pathKey(operation.target.relativePath))) {
      throw new RpcRuntimeError("invalid_patch", "patch source and target paths conflict");
    }
  }
}

export function operationResult(operation: ResolvedOperation, changes: readonly Record<string, unknown>[]): Record<string, unknown> {
  const paths = [operation.source?.relativePath, operation.target?.relativePath]
    .filter((path): path is string => path !== undefined)
    .map(pathKey);
  return {
    operation: operation.kind === "update" && operation.destination !== undefined ? "move" : operation.kind,
    path: operation.source?.relativePath ?? operation.target?.relativePath,
    ...(operation.destination === undefined ? {} : { destination: operation.target?.relativePath }),
    status: "applied",
    results: changes.filter((change) => typeof change.path === "string" && paths.includes(pathKey(change.path))).map((change) => ({ ...change })),
  };
}

export function requiredBaseline(baselines: ReadonlyMap<string, Baseline>, path: ResolvedPath): Baseline {
  const baseline = baselines.get(pathKey(path.relativePath));
  if (baseline === undefined) throw new Error("missing staged baseline");
  return baseline;
}

export function requiredPath(path: ResolvedPath | undefined): ResolvedPath {
  if (path === undefined) throw new Error("missing resolved path");
  return path;
}

export function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export function conflict(code: string, messageText: string, details: Record<string, unknown> = {}): RpcRuntimeError { return new RpcRuntimeError(code, messageText, details); }

export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RpcRuntimeError("invalid_params", "params must be an object");
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function message(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1_024) : "filesystem operation failed"; }


/**
 * Windows path lookup is case-insensitive and trims trailing dots/spaces on
 * ordinary NTFS components. Keep internal transaction keys aligned with that
 * lookup so aliases such as `Foo`/`foo` cannot bypass conflict detection or
 * cause two staged changes to target one inode. POSIX keeps case-sensitive
 * semantics intact.
 */
export function pathKey(path: string): string {
  const normalized = path.replace(/[\\/]+/g, "/");
  if (process.platform !== "win32") return normalized;
  return normalized.split("/").map((part) => part.replace(/[ .]+$/u, "")).join("/").toLowerCase();
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
