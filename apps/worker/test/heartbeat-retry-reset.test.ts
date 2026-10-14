import { afterEach, expect, it, vi } from "vitest";
import { RunnerHeartbeatPersistence } from "../src/platform/runner-heartbeat.js";
import { heartbeatRetryActive, isTemporaryHeartbeatFailure, nextHeartbeatRetry } from "../src/domain/heartbeat-retry.js";

const now = Date.parse("2026-10-14T00:00:00Z");
const policy = { active: heartbeatRetryActive, next: nextHeartbeatRetry, temporaryFailure: isTemporaryHeartbeatFailure };
afterEach(() => { vi.restoreAllMocks(); });

function socket(initial: Record<string, unknown> | unknown[] = { runnerId: "retry-reset-runner", epoch: 1 }) {
  let attachment = structuredClone(initial);
  let failWrite = false;
  const serializeAttachment = vi.fn((value: unknown) => {
    if (failWrite) throw new Error("attachment unavailable");
    attachment = structuredClone(value) as typeof initial;
  });
  return {
    ws: { serializeAttachment, deserializeAttachment: () => structuredClone(attachment) } as unknown as WebSocket,
    serializeAttachment,
    failWrite: (value: boolean) => { failWrite = value; },
    attachment: () => structuredClone(attachment) as Record<string, unknown>,
  };
}

it("does not restore an old failure count after a successful retry cannot clear the attachment", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(Math, "random").mockReturnValue(0);
  const f = socket(), adapter = new RunnerHeartbeatPersistence(policy), reject = vi.fn();
  await adapter.record(f.ws, async () => new Response(null, { status: 503 }), reject);
  f.failWrite(true); clock.mockReturnValue(now + 30000);
  await adapter.record(f.ws, async () => new Response(null, { status: 204 }), reject);
  // The persisted attachment deliberately remains stale. The isolate must
  // retain the successful reset, without inventing any authorization state.
  expect(f.attachment().heartbeatRetry).toMatchObject({ failures: 1, failedAtMs: now });
  f.failWrite(false); clock.mockReturnValue(now + 150000);
  await adapter.record(f.ws, async () => new Response(null, { status: 503 }), reject);
  expect(f.attachment().heartbeatRetry).toEqual({ failures: 1, failedAtMs: now + 150000, retryAtMs: now + 180000 });
  expect(reject).not.toHaveBeenCalled();
});

it("uses the local fallback without treating an array attachment as a metadata object", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  const f = socket([]), adapter = new RunnerHeartbeatPersistence(policy), reject = vi.fn();
  const request = vi.fn(async () => new Response(null, { status: 503 }));
  await adapter.record(f.ws, request, reject);
  await adapter.record(f.ws, request, reject);
  expect(request).toHaveBeenCalledOnce();
  expect(f.serializeAttachment).not.toHaveBeenCalled();
  expect(reject).not.toHaveBeenCalled();
});

it.each([401, 403, 409])("retains explicit rejection for receipt %s after metadata reset", async status => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(Math, "random").mockReturnValue(0);
  const f = socket(), adapter = new RunnerHeartbeatPersistence(policy), reject = vi.fn();
  await adapter.record(f.ws, async () => new Response(null, { status: 503 }), reject);
  clock.mockReturnValue(now + 30000); f.failWrite(true);
  await adapter.record(f.ws, async () => new Response(null, { status: 204 }), reject);
  clock.mockReturnValue(now + 150000);
  const response = new Response(null, { status });
  await adapter.record(f.ws, async () => response, reject);
  expect(reject).toHaveBeenCalledExactlyOnceWith(response);
});

it.each([200, 202, 206, 429, 500, 503])("returns explicit false for an uncommitted persistence receipt %s", async status => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = socket(), adapter = new RunnerHeartbeatPersistence(policy), reject = vi.fn();
  expect(await adapter.record(f.ws, async () => new Response(null, { status }), reject)).toBe(false);
  expect(f.attachment().heartbeatPersistedAtMs).toBeUndefined();
  expect(f.attachment().heartbeatRetry).toBeDefined();
  expect(reject).not.toHaveBeenCalled();
});

it("returns explicit false on a transport exception without claiming persistence", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = socket(), adapter = new RunnerHeartbeatPersistence(policy), reject = vi.fn();
  expect(await adapter.record(f.ws, async () => { throw new Error("synthetic outage"); }, reject)).toBe(false);
  expect(f.attachment().heartbeatPersistedAtMs).toBeUndefined();
  expect(reject).not.toHaveBeenCalled();
});

it("reports success only at completed persistence boundaries, not skipped frames", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const f = socket(), adapter = new RunnerHeartbeatPersistence(policy), reject = vi.fn();
  const request = vi.fn(async () => new Response(null, { status: 204 }));
  expect(await adapter.record(f.ws, request, reject)).toBe(true);
  clock.mockReturnValue(now + 119999);
  expect(await adapter.record(f.ws, request, reject)).toBe(false);
  clock.mockReturnValue(now + 120000);
  expect(await adapter.record(f.ws, request, reject)).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(f.attachment().heartbeatPersistedAtMs).toBe(now + 120000);
  expect(reject).not.toHaveBeenCalled();
});
