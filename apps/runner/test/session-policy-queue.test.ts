import { describe, expect, it } from "vitest";
import { SessionPolicyQueue } from "../src/connection/session-policy-queue.js";

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

describe("per-socket policy application ownership", () => {
  it("preserves FIFO on one socket without blocking a replacement socket", async () => {
    const queue = new SessionPolicyQueue<object>();
    const oldSocket = {}, newSocket = {};
    const trace: string[] = [];
    let releaseOld!: () => void;
    queue.enqueue(oldSocket, async () => {
      trace.push("old-first");
      await new Promise<void>(resolve => { releaseOld = resolve; });
    });
    queue.enqueue(oldSocket, async () => { trace.push("old-second"); });
    queue.enqueue(newSocket, async () => { trace.push("new-first"); });
    await turn();
    expect(trace).toEqual(["old-first", "new-first"]);
    releaseOld();
    await turn();
    expect(trace).toEqual(["old-first", "new-first", "old-second"]);
  });

  it("does not allow a rejected policy candidate to poison later updates", async () => {
    const queue = new SessionPolicyQueue<object>();
    const socket = {};
    let applied = 0;
    queue.enqueue(socket, async () => { throw new Error("invalid policy candidate"); });
    queue.enqueue(socket, async () => { applied += 1; });
    await turn();
    expect(applied).toBe(1);
  });
});
