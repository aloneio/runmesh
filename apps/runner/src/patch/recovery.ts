import { RpcRuntimeError } from "../errors.js";
import { isRecord, message } from "./values.js";

/** Preserve recovery paths when a later cleanup adds its own failure. */
export function withRecovery(error: unknown, recovery: readonly Record<string, unknown>[]): unknown {
  if (recovery.length === 0) return error;
  const details = error instanceof RpcRuntimeError ? error.details : undefined;
  const retained = error instanceof RpcRuntimeError && error.code === "patch_rollback_failed" && Array.isArray(details?.recovery)
    ? details.recovery.filter(isRecord)
    : [];
  return new RpcRuntimeError("patch_rollback_failed", "patch failed and recovery is required", {
    install_error: typeof details?.install_error === "string" ? details.install_error : message(error),
    recovery: [...retained, ...recovery],
  });
}
