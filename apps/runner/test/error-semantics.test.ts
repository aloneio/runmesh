import { describe, expect, it } from "vitest";
import { RpcRuntimeError, failureMetadata } from "../src/errors.js";
import { rpcError } from "../src/runtime.js";

describe("RPC failure semantics", () => {
  it("classifies authorization failures without relying on message text", () => {
    expect(failureMetadata("permission_denied")).toEqual({
      failure_class: "authorization",
      operation_state: "not_started",
      next_action: "refresh_permissions",
    });
  });

  it("only exposes a retry delay for failures known to be safe", () => {
    expect(failureMetadata("runner_offline")).toMatchObject({
      failure_class: "availability",
      operation_state: "unknown",
      next_action: "wait_and_retry",
    });
    expect(failureMetadata("runner_offline").retry_after_ms).toBeUndefined();
    expect(failureMetadata("busy")).toMatchObject({ retry_after_ms: 1000, next_action: "wait_and_retry" });
    expect(failureMetadata("patch_rollback_failed").retry_after_ms).toBeUndefined();
  });

  it("maps stale policy to a stable, bounded RPC error", () => {
    expect(rpcError(new Error("stale_policy"))).toMatchObject({
      code: "stale_policy",
      failure_class: "authorization",
      operation_state: "not_started",
      next_action: "refresh_permissions",
    });
  });

  it("preserves unknown operation state for rollback failures", () => {
    expect(rpcError(new RpcRuntimeError("patch_rollback_failed", "rollback incomplete"))).toMatchObject({
      failure_class: "execution",
      operation_state: "unknown",
      next_action: "inspect_job",
    });
  });
});
