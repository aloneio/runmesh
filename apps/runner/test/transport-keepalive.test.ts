import { expect, it, vi } from "vitest";
import { RunnerTransportKeepalive, negotiatedHeartbeatInterval, type TransportKeepaliveClock } from "../src/connection/keepalive.js";

function fixture() {
  let now = 0, current = true, nextId = 0;
  const callbacks = new Map<number, () => void>();
  const clock: TransportKeepaliveClock = { now: () => now,
    every: callback => { callbacks.set(++nextId, callback); return nextId; },
    clear: handle => { callbacks.delete(handle as number); } };
  const ping = vi.fn(), expired = vi.fn();
  const keepalive = new RunnerTransportKeepalive(() => current, ping, expired, clock);
  return { keepalive, ping, expired, callbacks, retire: () => { current = false; },
    advance: (milliseconds: number) => { now += milliseconds; for (const callback of [...callbacks.values()]) callback(); } };
}

it("keeps one outstanding probe and expires at the monotonic transport deadline", () => {
  const f = fixture(); f.keepalive.start();
  expect(f.ping).toHaveBeenCalledOnce();
  f.advance(25000); f.advance(49999);
  expect(f.ping).toHaveBeenCalledOnce(); expect(f.expired).not.toHaveBeenCalled();
  f.advance(1);
  expect(f.expired).toHaveBeenCalledOnce(); expect(f.callbacks.size).toBe(0);
});

it("accepts pongs only for the current active probe and clears all retired timers", () => {
  const f = fixture(); expect(f.keepalive.acknowledge()).toBe(false);
  f.keepalive.start(); expect(f.keepalive.acknowledge()).toBe(true);
  expect(f.keepalive.acknowledge()).toBe(false);
  f.advance(25000); expect(f.ping).toHaveBeenCalledTimes(2);
  f.retire(); expect(f.keepalive.acknowledge()).toBe(false);
  f.advance(75000); expect(f.expired).not.toHaveBeenCalled(); expect(f.callbacks.size).toBe(0);
});

it("handles failed sends and stops without retaining timers", () => {
  const f = fixture(); f.ping.mockImplementation(() => { throw new Error("synthetic send failure"); });
  f.keepalive.start(); expect(f.expired).toHaveBeenCalledOnce(); expect(f.callbacks.size).toBe(0);
  f.keepalive.stop(); expect(f.keepalive.acknowledge()).toBe(false);
});

it.each([undefined, {}, { runmesh_transport_ping: 1 }, { runmesh_heartbeat_interval_ms: 120000 },
  { runmesh_transport_ping: 1, runmesh_heartbeat_interval_ms: 180000 },
  { runmesh_transport_ping: 1, runmesh_heartbeat_interval_ms: "120000" }])("preserves the older Worker heartbeat cadence for %j", extensions => {
  expect(negotiatedHeartbeatInterval(extensions)).toBe(30000);
});

it("negotiates low-frequency persistence only alongside independent keepalive", () => {
  expect(negotiatedHeartbeatInterval({ runmesh_transport_ping: 1, runmesh_heartbeat_interval_ms: 120000 })).toBe(120000);
});
