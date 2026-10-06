import { afterEach, expect, it, vi } from "vitest";
import { asyncDeadline } from "../src/async-deadline.js";
import { withinDeadline } from "../src/application/connectors/deadline.js";
import { remoteDeadline } from "../src/application/capabilities/remote-deadline.js";
import { CONNECTOR_LIMITS } from "../src/contracts/connectors.js";
import { REMOTE_LIMITS } from "../src/contracts/remote.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("does not start an operation after its parent has aborted", async () => {
  const parent = new AbortController(); parent.abort();
  const operation = vi.fn(async () => "completed");
  expect(await asyncDeadline(parent.signal, 100, () => "timed_out", operation)).toBe("timed_out");
  expect(operation).not.toHaveBeenCalled();
});

it.each(["deadline", "parent"] as const)("settles on %s even when the operation ignores abort and rejects later", async cause => {
  vi.useFakeTimers();
  const parent = new AbortController(), remove = vi.spyOn(parent.signal, "removeEventListener");
  const timedOut = { state: "unknown" }, onTimeout = vi.fn(() => timedOut);
  let reject!: (error: Error) => void, observed!: AbortSignal, expired!: () => boolean;
  const pending = asyncDeadline(parent.signal, 100, onTimeout, (signal, isExpired) => {
    observed = signal; expired = isExpired;
    return new Promise<never>((_resolve, fail) => { reject = fail; });
  });
  expect(expired()).toBe(false);
  if (cause === "parent") parent.abort();
  else await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(timedOut);
  expect(observed.aborted).toBe(true); expect(expired()).toBe(true);
  expect(onTimeout).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  reject(new Error("late operation rejection"));
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(timedOut);
});

it("cleans up the timer, child signal and parent listener after completion", async () => {
  vi.useFakeTimers();
  const parent = new AbortController(), remove = vi.spyOn(parent.signal, "removeEventListener");
  const onTimeout = vi.fn(() => "timed_out");
  let observed!: AbortSignal;
  expect(await asyncDeadline(parent.signal, 100, onTimeout, async signal => {
    observed = signal; return "completed";
  })).toBe("completed");
  expect(observed.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  parent.abort(); await vi.advanceTimersByTimeAsync(100);
  expect(onTimeout).not.toHaveBeenCalled();
});

it.each(["deadline", "parent"] as const)("rejects and cleans up when the %s timeout outcome throws", async cause => {
  vi.useFakeTimers();
  const parent = new AbortController(), remove = vi.spyOn(parent.signal, "removeEventListener");
  const error = new Error("timeout outcome failure");
  // Parent cancellation during the timeout callback must not re-enter it.
  const onTimeout = vi.fn(() => { parent.abort(); throw error; });
  let observed!: AbortSignal;
  const pending = asyncDeadline(parent.signal, 100, onTimeout, signal => {
    observed = signal; return new Promise<never>(() => undefined);
  });
  const rejected = expect(pending).rejects.toBe(error);
  if (cause === "parent") parent.abort();
  else await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(observed.aborted).toBe(true);
  expect(onTimeout).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(onTimeout).toHaveBeenCalledTimes(1);
});

it.each(["sync", "async"] as const)("preserves a %s operation failure and releases its deadline", async failure => {
  vi.useFakeTimers();
  const parent = new AbortController(), remove = vi.spyOn(parent.signal, "removeEventListener");
  const error = new Error("operation failure");
  let observed!: AbortSignal;
  const pending = asyncDeadline(parent.signal, 100, () => "timed_out", signal => {
    observed = signal;
    if (failure === "sync") throw error;
    return Promise.reject(error);
  });
  await expect(pending).rejects.toBe(error);
  expect(observed.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it("observes both rejections when an operation aborts its parent before throwing", async () => {
  vi.useFakeTimers();
  const parent = new AbortController(), error = new Error("operation failure");
  const onTimeout = vi.fn(() => { throw new Error("timeout outcome failure"); });
  const pending = asyncDeadline(parent.signal, 100, onTimeout, () => {
    parent.abort(); throw error;
  });
  await expect(pending).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(0);
  expect(onTimeout).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { name: "connector", run: withinDeadline, duration: CONNECTOR_LIMITS.operation_ms },
  { name: "remote", run: remoteDeadline, duration: REMOTE_LIMITS.operation_ms },
])("retains the $name feature budget and caller-owned timeout outcome", async ({ run, duration }) => {
  vi.useFakeTimers();
  const parent = new AbortController(), onTimeout = vi.fn(() => ({ state: "unknown" }));
  const pending = run(parent.signal, onTimeout, () => new Promise<never>(() => undefined));
  await vi.advanceTimersByTimeAsync(duration - 1);
  expect(onTimeout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ state: "unknown" });
  expect(onTimeout).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
