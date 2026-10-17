import { describe, expect, it } from "vitest";
import { HistoryReceiptTracker } from "../src/connection/history-receipts.js";

describe("session-bound history acknowledgement", () => {
  it("accepts only the pending request and original socket", () => {
    const tracker = new HistoryReceiptTracker<object>();
    const firstSocket = {}, replacementSocket = {};
    tracker.track(firstSocket, "history-1", "snapshot-A", 4);
    expect(tracker.accept(replacementSocket, "history-1", { history_status: "recorded" })).toBeNull();
    expect(tracker.accept(firstSocket, "history-2", { history_status: "recorded" })).toBeNull();
    expect(tracker.lastSnapshot).toBeUndefined();
    expect(tracker.accept(firstSocket, "history-1", { history_status: "recorded" })).toEqual({ status: "recorded", revision: 4 });
    expect(tracker.lastSnapshot).toBe("snapshot-A");
    expect(tracker.accept(firstSocket, "history-1", { history_status: "recorded" })).toBeNull();
  });

  it("never reports invalid or unknown status as persisted execution history", () => {
    const tracker = new HistoryReceiptTracker<object>();
    const socket = {};
    for (const malformed of [{ history_status: "failed" }, {}, null, [], { history_status: false }, { history_status: { toString: null } }]) {
      tracker.track(socket, "history-retry", "snapshot-B", 7);
      expect(tracker.accept(socket, "history-retry", malformed)).toEqual({ status: null });
      expect(tracker.lastSnapshot).toBeUndefined();
    }
    tracker.track(socket, "history-success", "snapshot-B", 8);
    expect(tracker.accept(socket, "history-success", { history_status: "unchanged" })).toEqual({ status: "unchanged", revision: 8 });
    expect(tracker.lastSnapshot).toBe("snapshot-B");
  });

  it("supports disabled receipts and resets all evidence for a replacement session", () => {
    const tracker = new HistoryReceiptTracker<object>();
    const socket = {};
    tracker.track(socket, "history-disabled", "snapshot-C");
    expect(tracker.accept(socket, "history-disabled", { history_status: "disabled" })).toEqual({ status: "disabled" });
    expect(tracker.lastSnapshot).toBe("snapshot-C");
    tracker.track(socket, "history-pending", "snapshot-D", 9);
    tracker.reset();
    expect(tracker.lastSnapshot).toBeUndefined();
    expect(tracker.accept(socket, "history-pending", { history_status: "recorded" })).toBeNull();
    tracker.optimistic("legacy-no-ack");
    expect(tracker.lastSnapshot).toBe("legacy-no-ack");
  });
});
