import { createHash } from "node:crypto";
import { RpcRuntimeError } from "../errors.js";
import type { WorkspaceConfig } from "../config.js";

export function parseInvocation(params: Record<string, unknown>, workspace: WorkspaceConfig): { file: string; args: string[]; command: string[]; shell: boolean } {
  const requestedShell = params.shell === true;
  if (requestedShell && !workspace.shell) throw new Error("shell execution is disabled for this workspace");
  const shellRuntime = params.shell_runtime;
  if (requestedShell && typeof shellRuntime === "object" && shellRuntime !== null && !Array.isArray(shellRuntime)) {
    const invocation = shellRuntime as { file?: unknown; args?: unknown };
    if (!validInvocationPart(invocation.file, false) || !Array.isArray(invocation.args) || invocation.args.length > 256 || invocation.args.some((item) => !validInvocationPart(item, true))) throw new Error("shell runtime invocation is invalid");
    if (typeof params.command !== "string" || params.command.length === 0 || params.command.length > 8_192 || params.command.includes("\0")) throw new Error("command is required");
    return { file: invocation.file, args: invocation.args as string[], command: [params.command], shell: false };
  }
  if (Array.isArray(params.command)) {
    if (params.command.length === 0 || params.command.length > 256 || params.command.some((item, index) => !validInvocationPart(item, index !== 0))) throw new Error("command must be a bounded string array");
    return { file: params.command[0] as string, args: params.command.slice(1) as string[], command: params.command as string[], shell: requestedShell };
  }
  if (typeof params.command !== "string" || params.command.length === 0 || params.command.length > 8_192 || params.command.includes("\0")) throw new Error("command is required");
  const args = params.args === undefined ? [] : stringArray(params.args, "args");
  if (!requestedShell) return { file: params.command, args, command: [params.command, ...args], shell: false };
  return { file: [params.command, ...args].join(" "), args: [], command: [params.command, ...args], shell: true };
}

export function paramsObject(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("params must be an object"); return value as Record<string, unknown>; }

export function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string" || item.includes("\0") || item.length > 8_192)) throw new Error(`${label} must be string array`); return value as string[]; }

/** Bound every OS process argument before it reaches spawn/exec. The command
 * executable itself may not be empty; empty argument values remain valid. */
export function validInvocationPart(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= 8_192 && !value.includes("\0");
}

export function bounded(value: unknown, min: number, max: number, fallback: number): number { if (value === undefined || value === null) return fallback; if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value); if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid pagination value"); return value as number; }

export function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`); return value as number; }

export function boundedPositiveInteger(value: unknown, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer from ${min} to ${max}`); return value as number; }

export function relativeWorkspacePath(workspace: WorkspaceConfig, path: string): string { return path === workspace.rootPath ? "." : path.slice(workspace.rootPath.length + 1); }

export function safeOptionalIdentifier(value: unknown): string | null { if (value === undefined) return null; if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("created_by_client_id is invalid"); return value; }

export function safeOptionalRequestId(value: unknown): string | null { if (value === undefined) return null; if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new RpcRuntimeError("invalid_params", "request_id is invalid"); return value; }

export function launchRequestFingerprint(workspaceId: string, cwd: string, invocation: { readonly file: string; readonly args: readonly string[]; readonly command: readonly string[]; readonly shell: boolean }, clientId: string | null): string {
  return createHash("sha256").update(JSON.stringify({ workspace_id: workspaceId, cwd, file: invocation.file, args: invocation.args, command: invocation.command, shell: invocation.shell, client_id: clientId })).digest("hex");
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
