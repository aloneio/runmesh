import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { RunnerConnection, RunnerAuthenticationError, RunnerServiceUnavailableError, classifyConnectionFailure } from "../src/connection.js";
import { serviceReconnectDelayMs, retryAfterDelayMs } from "../src/backoff.js";
import type { RunnerRuntime } from "../src/runtime.js";
import type { PolicyStore } from "../src/policy-store.js";

function runner(sleep: (ms: number) => Promise<void>, server = "ws://127.0.0.1:1") {
  return new RunnerConnection({ config: { runnerId: "outage-runner", server, token: "synthetic-token", workspaces: [] },
    runtime: { initialize: async () => {} } as unknown as RunnerRuntime,
    policyStore: { load: async () => undefined } as unknown as PolicyStore, sleep, random: () => 0 });
}
function mockConnect(connection: RunnerConnection) { return vi.spyOn(connection as unknown as { connectOnce(): Promise<void> }, "connectOnce"); }

describe("availability-aware connection recovery", () => {
  it.each([429, 500, 502, 503, 504])("keeps HTTP %s retryable even when an error mentions authentication", (statusCode) => {
    expect(classifyConnectionFailure({ statusCode, reason: "authentication storage unavailable" })).toBe("network");
  });
  it.each([1011, 1012, 1013, 1006, 4002])("does not reclassify close %s by untrusted reason text", (closeCode) => {
    expect(classifyConnectionFailure({ closeCode, reason: "credentials revoked: service unavailable" })).toBe("network");
  });
  it("does not treat a generic storage/auth-service error message as a credential decision", () => {
    expect(classifyConnectionFailure({ error: new Error("authentication database unavailable") })).toBe("network");
  });
  it("preserves typed and explicit authentication rejection", () => {
    for (const input of [{ statusCode: 401 }, { statusCode: 403 }, { closeCode: 4001 }, { closeCode: 1002 }, { closeCode: 1008, reason: "stale credentials" }, { error: new RunnerAuthenticationError() }]) expect(classifyConnectionFailure(input)).toBe("authentication");
  });
  it("bounds service retries to a slower jittered 30-second to 5-minute backoff", () => {
    expect([0,1,2,3,4,99].map((n) => serviceReconnectDelayMs(n, 0))).toEqual([30000,60000,120000,240000,300000,300000]);
    for (const n of [-1, 0, 1, 99, Number.NaN]) for (const random of [-1, 0, 0.5, 1, 99, Number.NaN]) {
      expect(serviceReconnectDelayMs(n, random)).toBeGreaterThanOrEqual(30000);
      expect(serviceReconnectDelayMs(n, random)).toBeLessThanOrEqual(300000);
    }
    expect(serviceReconnectDelayMs(0, 0, 600000)).toBe(600000);
    expect(serviceReconnectDelayMs(0, 0, Number.MAX_SAFE_INTEGER)).toBe(900000);
  });
  it("honors bounded Retry-After seconds and dates without accepting invalid values", () => {
    const now = Date.parse("2026-09-11T00:00:00Z");
    expect(retryAfterDelayMs("120", now)).toBe(120000);
    expect(retryAfterDelayMs("Fri, 11 Sep 2026 00:02:00 GMT", now)).toBe(120000);
    expect(retryAfterDelayMs("99999999", now)).toBe(900000);
    for (const value of [undefined, "garbage", "0", "Fri, 01 Jan 2021 00:00:00 GMT"]) expect(retryAfterDelayMs(value, now)).toBe(30000);
  });
  it("keeps the reconnect loop alive across repeated service outages without a busy retry", async () => {
    const waits: number[] = [];
    const connection = runner(async (ms) => { waits.push(ms); if (waits.length === 6) connection.stop(); });
    const connect = mockConnect(connection).mockRejectedValue(new RunnerServiceUnavailableError());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await connection.start();
      expect(waits).toEqual([30000,60000,120000,240000,300000,300000]); expect(connect).toHaveBeenCalledTimes(6);
    } finally { connection.stop(); connect.mockRestore(); log.mockRestore(); }
  });
  it("stops rather than retrying a real credential rejection", async () => {
    const sleep = vi.fn(async () => {}), connection = runner(sleep);
    const connect = mockConnect(connection).mockRejectedValue(new RunnerAuthenticationError());
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await expect(connection.start()).rejects.toBeInstanceOf(RunnerAuthenticationError); expect(sleep).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(1); }
    finally { connection.stop(); connect.mockRestore(); log.mockRestore(); }
  });
  it.each([429, 503])("exercises real WebSocket HTTP %s rejection and Retry-After", async (status) => {
    const server = createServer((_req, res) => { res.writeHead(status, { "retry-after": "120" }); res.end("authentication dependency unavailable"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing test port");
    const waits: number[] = [];
    const connection = runner(async (ms) => { waits.push(ms); connection.stop(); }, `ws://127.0.0.1:${address.port}`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await connection.start(); expect(waits).toEqual([120000]); }
    finally { connection.stop(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); log.mockRestore(); }
  });
  it("exercises a real WebSocket 1013 close without leaving the reconnect loop", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => socket.once("message", () => socket.close(1013, "authentication dependency unavailable")));
    const address = server.address(); if (typeof address === "string") throw new Error("missing test port");
    const waits: number[] = [], connection = runner(async (ms) => { waits.push(ms); connection.stop(); }, `ws://127.0.0.1:${address.port}`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await connection.start(); expect(waits).toEqual([30000]); }
    finally { connection.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); log.mockRestore(); }
  });
});

it("stop interrupts a long service cooldown instead of waiting for its timer", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const connection = new RunnerConnection({ config: { runnerId: "stop-runner", server: "ws://127.0.0.1:1", token: "synthetic", workspaces: [] },
    runtime: { initialize: async () => {} } as unknown as RunnerRuntime,
    policyStore: { load: async () => undefined } as unknown as PolicyStore, random: () => 0 });
  const connect = mockConnect(connection).mockRejectedValue(new RunnerServiceUnavailableError("service unavailable", 900000));
  try {
    const running = connection.start(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); connection.stop(); await running;
    expect(vi.getTimerCount()).toBe(0); expect(connect).toHaveBeenCalledTimes(1);
  } finally { connection.stop(); connect.mockRestore(); log.mockRestore(); vi.useRealTimers(); }
});
