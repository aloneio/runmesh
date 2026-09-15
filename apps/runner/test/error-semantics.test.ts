import { failureMetadata as protocolFailure } from "@aloneio/runmesh-protocol";
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
      next_action: "inspect_job",
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


it.each(["queue_full", "request_id_conflict", "search_snapshot_changed", "context_revision_conflict", "timeout"])("keeps %s metadata identical between Runner and protocol", (code) => {
  expect(failureMetadata(code)).toEqual(protocolFailure(code));
});
it("never recommends blind replay for an operation whose outcome is unknown", () => {
  const error = protocolFailure("timeout");
  expect(error.operation_state).toBe("unknown");
  expect(error.next_action).not.toBe("wait_and_retry");
  expect(error.retry_after_ms).toBeUndefined();
});

it("permits dependency retries only when the caller proves it never dispatched", () => {
  expect(protocolFailure("registry_unavailable", "not_started")).toMatchObject({operation_state:"not_started",next_action:"wait_and_retry"});
  expect(protocolFailure("busy", "unknown")).toEqual({failure_class:"resource",operation_state:"unknown",next_action:"inspect_job"});
});
