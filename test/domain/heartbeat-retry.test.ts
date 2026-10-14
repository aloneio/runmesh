import { expect, it } from "vitest";
import { heartbeatRetryActive, isTemporaryHeartbeatFailure, nextHeartbeatRetry } from "../../apps/worker/src/domain/heartbeat-retry.js";

const now = Date.parse("2026-10-14T00:00:00Z");
it("uses bounded exponential retry with jitter even at the ceiling", () => {
  let previous: ReturnType<typeof nextHeartbeatRetry> | undefined;
  const delays: number[] = [];
  for (let n = 0; n < 6; n++) {
    previous = nextHeartbeatRetry(previous, now, null, 0);
    delays.push(previous.retryAtMs - now);
  }
  expect(delays).toEqual([30000, 60000, 120000, 240000, 240000, 240000]);
  expect(nextHeartbeatRetry(previous, now, null, 1).retryAtMs - now).toBe(300000);
});
it.each([-1, 0, 0.5, 1, 99, Number.NaN, Number.POSITIVE_INFINITY])("bounds jitter %s", random => {
  const retry = nextHeartbeatRetry(undefined, now, null, random);
  expect(retry.retryAtMs - now).toBeGreaterThanOrEqual(30000);
  expect(retry.retryAtMs - now).toBeLessThanOrEqual(37500);
});
it.each(["garbage", "", " ", "-1", "0", "Wed, 01 Jan 2020 00:00:00 GMT"])("ignores invalid or expired Retry-After %s", header => {
  expect(nextHeartbeatRetry(undefined, now, header, 0).retryAtMs).toBe(now + 30000);
});
it.each(["120", "Wed, 14 Oct 2026 00:02:00 GMT"])("honors Retry-After %s", header => {
  expect(nextHeartbeatRetry(undefined, now, header, 0).retryAtMs).toBe(now + 120000);
});
it("caps a Retry-After without abandoning recovery", () => {
  expect(nextHeartbeatRetry(undefined, now, "9999999999", 0).retryAtMs).toBe(now + 900000);
});
it("expires at the boundary and permits a clock-rollback probe", () => {
  const retry = nextHeartbeatRetry(undefined, now, null, 0);
  expect(heartbeatRetryActive(retry, now)).toBe(true);
  expect(heartbeatRetryActive(retry, now + 29999)).toBe(true);
  expect(heartbeatRetryActive(retry, now + 30000)).toBe(false);
  expect(heartbeatRetryActive(retry, now - 1)).toBe(false);
});
it.each([undefined, null, {}, { failures: 99, failedAtMs: now, retryAtMs: now + 30000 },
  { failures: 1, failedAtMs: now, retryAtMs: now + 900001 }, { failures: 1, failedAtMs: now, retryAtMs: Number.NaN }])("does not trust malformed retry metadata %#", state => {
  expect(heartbeatRetryActive(state, now)).toBe(false);
  expect(nextHeartbeatRetry(state, now, null, 0).failures).toBe(1);
});
it.each([401, 403, 409, 400, 404, 200, 204, 600])("does not suppress nontemporary status %s", status => {
  expect(isTemporaryHeartbeatFailure(status)).toBe(false);
});
it.each([429, 500, 502, 503, 504, 599])("recognizes temporary dependency status %s", status => {
  expect(isTemporaryHeartbeatFailure(status)).toBe(true);
});
