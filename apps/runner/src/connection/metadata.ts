import { RPC_OPERATION_METHODS } from "@aloneio/runmesh-protocol";
import { userInfo } from "node:os";
import { DEFAULT_MAX_CONCURRENT_JOBS } from "../config.js";
import type { CapabilityMetadata } from "../protocol-types.js";

export function discoverCapabilities(maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS): CapabilityMetadata {
  return {
    filesystem: true,
    process_execution: true,
    workspace_sync: true,
    pty: false,
    network_access: true,
    max_concurrent_jobs: maxConcurrentJobs,
    supported_rpc_methods: ["echo", "runner.info", ...RPC_OPERATION_METHODS],
    labels: { runtime: "node" },
  };
}

/** Return the local process identity without invoking a shell or exposing a path. */
export function currentProcessServiceIdentity(): string | undefined {
  try {
    if (process.platform !== "win32" && process.getuid?.() === 0) return "root";
    const username = userInfo().username.trim();
    return username.length > 0 && username.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(username) ? username : undefined;
  } catch {
    const username = process.platform === "win32" ? process.env.USERNAME : undefined;
    return typeof username === "string" && username.length > 0 && username.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(username) ? username : undefined;
  }
}

export function sanitizeServiceIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? trimmed : undefined;
}

export function processPrivilegeState(mode: "dedicated_user" | "privileged_host", identity: string | undefined): "privileged" | "restricted" | "mismatch" | "unknown" {
  if (identity === undefined) return "unknown";
  const normalized = identity.trim().replaceAll("/", "\\").toLowerCase();
  const privileged = process.platform === "win32"
    ? normalized === "system" || normalized === "nt authority\\system" || normalized === "s-1-5-18"
    : normalized === "root";
  if (mode === "privileged_host") return privileged ? "privileged" : "mismatch";
  return privileged ? "mismatch" : "restricted";
}
