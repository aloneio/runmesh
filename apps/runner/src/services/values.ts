import type { ExecutionMode } from "./contracts.js";
import type { HostPlatform } from "../platform-types.js";
import { posix } from "node:path";
import type { ServiceAdapterOptions } from "./contracts.js";
import type { ServiceMode } from "./contracts.js";
import type { ServicePlatform } from "./contracts.js";
import { win32 } from "node:path";

export const MARKER = "runmesh-runner-managed";

export const LINUX_SERVICE_NAME = "runmesh-runner.service";

export const MACOS_LABEL = "io.alone.runmesh.runner";

export const WINDOWS_TASK_NAME = "RunmeshRunner";

export const DEDICATED_SERVICE_USER = "runmesh";

// claim success for a Runner that has already exited.
export const SERVICE_STARTUP_STABILITY_DELAY_MS = 300;

export function currentServicePlatform(platform: HostPlatform = process.platform): ServicePlatform { return platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "win32"; }

export function serviceMode(options: ServiceAdapterOptions = {}): ServiceMode { return options.mode ?? (options.system === false ? "user" : "system"); }

export function serviceExecutionMode(options: Pick<ServiceAdapterOptions, "executionMode"> = {}): ExecutionMode {
  const mode = options.executionMode ?? "dedicated_user";
  if (mode !== "dedicated_user" && mode !== "privileged_host") throw new Error("execution mode must be dedicated_user or privileged_host");
  return mode;
}

export function hashContent(content: string): string { let hash = 2166136261; for (const byte of Buffer.from(content, "utf8")) { hash ^= byte; hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }

export function privilegedIdentity(platform: ServicePlatform): string { return platform === "win32" ? "SYSTEM" : "root"; }

export function isAbsoluteForPlatform(value: string, platform: ServicePlatform): boolean { return platform === "win32" ? win32.isAbsolute(value) : value.startsWith("/"); }

export function isWindowsAbsolute(value: string): boolean { return win32.isAbsolute(value); }

/** Service managers may choose an arbitrary cwd; never emit relative state paths. */
export function absoluteServicePath(value: string, platform: ServicePlatform): string {
  const path = platform === "win32" ? win32 : posix;
  return path.normalize(path.isAbsolute(value) ? value : path.resolve(value));
}

export function safeServiceIdentity(value: string): boolean { return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value); }

export function safeServiceReportedIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? trimmed : undefined;
}

export function isErrno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
