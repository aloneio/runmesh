import type { GitPath } from "./contracts.js";
import type { GitRun } from "./contracts.js";
import { MAX_OUTPUT_BYTES } from "./limits.js";
import { MAX_PROCESS_OUTPUT_BYTES } from "./limits.js";
import { PathPolicy } from "../path-policy.js";
import { relative } from "node:path";
import { RpcRuntimeError } from "../errors.js";
import { sep } from "node:path";

export async function resolveGitPath(policy: PathPolicy, workspaceId: unknown, path: unknown): Promise<GitPath> {
  // Do not require a leaf to exist: both `git diff -- path` and `git status --
  // path` are useful for deleted tracked files. PathPolicy still validates the
  // lexical path and every existing ancestor against the workspace boundary.
  const resolved = await policy.resolve(workspaceId, path, "cwd");
  const relativePath = relative(resolved.workspace.rootPath, resolved.path).split(sep).join("/") || ".";
  return { rootPath: resolved.workspace.rootPath, relativePath };
}

export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

export function outputCap(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_OUTPUT_BYTES) {
    throw new RpcRuntimeError("invalid_params", `max_bytes must be an integer from 1 to ${MAX_OUTPUT_BYTES}`);
  }
  // The per-result fitting below handles JSON escaping. This cap reserves the
  // fixed response envelope before git is spawned, keeping memory bounded.
  return Math.min(value as number, MAX_PROCESS_OUTPUT_BYTES);
}

export function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error("invalid GitService timeout option");
  return value;
}

export function gitFailure(prefix: string, run: GitRun): RpcRuntimeError {
  // Timeout classification wins even if a killed descendant eventually reports
  // a non-zero status/signal. The configured seam is reflected in the error.
  if (run.timedOut) return new RpcRuntimeError("git_timeout", `${prefix}: command exceeded ${run.timeoutMs}ms timeout`);
  const detail = run.stderr.toString("utf8").trim() || run.stdout.toString("utf8").trim() || run.signal || "unknown git failure";
  return new RpcRuntimeError("git_failed", `${prefix}: ${detail.slice(0, 1_024)}`);
}

export function boundedCount(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new RpcRuntimeError("invalid_params", `value must be an integer from 1 to ${max}`);
  return value as number;
}

export function safeRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{7,64}(?:\^\{0,1\})?$/.test(value)) throw new RpcRuntimeError("invalid_params", "revision must be a git commit identifier");
  return value;
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcRuntimeError("invalid_params", "params must be an object");
  return value as Record<string, unknown>;
}
