import { expect, it, vi } from "vitest";
import { reportTransportClose } from "../src/connection/diagnostics.js";

it.each([
  [1013, "control plane temporarily unavailable", "control_plane_unavailable"],
  [4000, "stale runner session", "session_replaced"],
  [4001, "runner credentials rejected", "credentials_rejected"],
  [1006, "", "empty"],
  [1000, "Bearer SECRET\nforged_log=true", "unclassified"],
  [1000, "__proto__", "unclassified"],
  [1000, "constructor", "unclassified"],
] as const)("logs close %s without untrusted reason text", (code, reason, expected) => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    reportTransportClose({ code, reason, welcomed: true, current: false, connectedMs: 1234.9 });
    expect(log).toHaveBeenCalledExactlyOnceWith(`RUNMESH_TRANSPORT_CLOSE code=${code} reason=${expected} welcomed=true current=false connected_ms=1234`);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  } finally { log.mockRestore(); }
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("bounds invalid diagnostic numbers %s", value => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    reportTransportClose({ code: value, reason: "", welcomed: false, current: true, connectedMs: value });
    expect(log).toHaveBeenCalledExactlyOnceWith("RUNMESH_TRANSPORT_CLOSE code=unknown reason=empty welcomed=false current=true connected_ms=0");
  } finally { log.mockRestore(); }
});

it("a failed logger cannot interrupt reconnect handling", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("log sink unavailable"); });
  try { expect(() => reportTransportClose({ code: 1006, reason: "", welcomed: true, current: true, connectedMs: 42 })).not.toThrow(); }
  finally { log.mockRestore(); }
});
