import { describe, expect, it } from "vitest";
import { pendingBridgeCount, rememberPendingBridge, forgetPendingBridge } from "../src/platform/bridge-pending-attachment.js";

describe("bridge attachment execution evidence ownership", () => {
  it("preserves unresolved ids until an observed response, including after timeout", () => {
    const attachment: { pendingUpdateRpcIds?: string[] } = {};
    expect(pendingBridgeCount(attachment)).toBe(0);
    rememberPendingBridge(attachment, "first");
    rememberPendingBridge(attachment, "second");
    expect(pendingBridgeCount(attachment)).toBe(2);
    // Timeout does not remove the pending execution marker.
    expect(attachment.pendingUpdateRpcIds).toEqual(["first", "second"]);
    forgetPendingBridge(attachment, "first");
    expect(attachment.pendingUpdateRpcIds).toEqual(["second"]);
    forgetPendingBridge(attachment, "unknown");
    expect(pendingBridgeCount(attachment)).toBe(1);
    forgetPendingBridge(attachment, "second");
    expect(pendingBridgeCount(attachment)).toBe(0);
  });
});
