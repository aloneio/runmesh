import { expect, it, vi } from "vitest";
import { createProfileManager } from "../../apps/worker/src/application/connectors/profiles.js";
import { profileEndpoint } from "../../apps/worker/src/contracts/connector-values.js";
import type { AdminDecision, ProfileRecord, ProfileResult } from "../../apps/worker/src/contracts/connectors.js";

const command = { action: "connect", profile_id: "docs", connector_id: "docs", endpoint: "https://docs.example.com/mcp",
  authentication: "none" };
function fixture() {
  let record: ProfileRecord | undefined;
  const ports = {
    authorize: vi.fn(async (): Promise<AdminDecision> => "allowed"),
    repository: { read: vi.fn(() => record), replace: vi.fn((next: ProfileRecord, expected: number): ProfileResult => {
      if ((record?.profile.revision ?? 0) !== expected) return { state: "conflict", current_revision: record?.profile.revision ?? 0 };
      record = structuredClone(next); return { state: "written", profile: next.profile };
    }) },
  };
  const manager = createProfileManager(ports);
  return { ports, record: () => record, run: (value: unknown, signal = new AbortController().signal) => manager.mutate(value, signal) };
}

it("W03 creates disabled profiles then enables only an observed revision", async () => {
  const f = fixture();
  expect(await f.run(command)).toMatchObject({ state: "written", profile: { enabled: false, revision: 1 } });
  expect(await f.run({ action: "enable", profile_id: "docs", expected_revision: 1 }))
    .toMatchObject({ state: "written", profile: { revision: 2, enabled: true } });
  expect(await f.run({ action: "disable", profile_id: "docs", expected_revision: 1 })).toEqual({ state: "conflict", current_revision: 2 });
});

it.each(["denied", "unavailable"] as const)("W03 initial %s does not touch state", async decision => {
  const f = fixture(); f.ports.authorize.mockResolvedValue(decision);
  expect(await f.run(command)).toEqual({ state: decision });
  expect(f.ports.repository.read).not.toHaveBeenCalled();
});

it("W03 revocation before commit prevents any write", async () => {
  const f = fixture();
  f.ports.authorize.mockResolvedValueOnce("allowed").mockResolvedValueOnce("denied");
  expect(await f.run(command)).toEqual({ state: "denied" });
  expect(f.ports.repository.replace).not.toHaveBeenCalled();
});

it("W03 uncertain commit errors are not reported as safely retryable", async () => {
  const f = fixture(); f.ports.repository.replace.mockImplementation(() => { throw new Error("receipt lost"); });
  expect(await f.run(command)).toEqual({ state: "unknown" });
  expect(f.ports.repository.replace).toHaveBeenCalledOnce();
});

it("W03 storage failures remain unavailable and do not write", async () => {
  const f = fixture(); f.ports.repository.read.mockImplementation(() => { throw new Error("private details"); });
  expect(await f.run(command)).toEqual({ state: "unavailable" });
  expect(f.ports.repository.replace).not.toHaveBeenCalled();
});

it("W03 aborted and expired operations do not commit or leave timers", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); f.ports.authorize.mockImplementation(() => new Promise(() => undefined));
    const pending = f.run(command);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ state: "unavailable" });
    expect(f.ports.repository.replace).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController(); controller.abort();
    expect(await f.run(command, controller.signal)).toEqual({ state: "unavailable" });
  } finally { vi.useRealTimers(); }
});

it("W03 closed commands cannot alter owner, endpoint or caller-supplied credential versions", async () => {
  const f = fixture();
  expect(await f.run({ ...command, owner: "other" })).toEqual({ state: "invalid" });
  expect(await f.run({ action: "rotate", profile_id: "docs", expected_revision: 1, credential: command.credential, endpoint: command.endpoint })).toEqual({ state: "invalid" });
  expect(f.ports.authorize).not.toHaveBeenCalled();
});

it("W03 malformed storage adapters cannot cross the mutation boundary", async () => {
  const f = fixture(); await f.run(command);
  f.ports.repository.read.mockReturnValue({ ...f.record()!, profile: { ...f.record()!.profile, profile_id: "other" } });
  expect(await f.run({ action: "disable", profile_id: "docs", expected_revision: 1 })).toEqual({ state: "unavailable" });
  expect(f.ports.repository.replace).toHaveBeenCalledOnce();

});

it("W03 expired admission completion cannot beat a late timer and commit", async () => {
  let clock = 100;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const f = fixture();
    f.ports.authorize.mockImplementation(async () => {
      clock += 5_001; return "allowed";
    });
    expect(await f.run(command)).toEqual({ state: "unavailable" });
    expect(f.ports.repository.replace).not.toHaveBeenCalled();
    expect(f.ports.authorize).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); }
});

it("W03 endpoint size is bounded after URL normalization as well as before", () => {
  expect(profileEndpoint(`https://docs.example/${"文".repeat(500)}`)).toBeUndefined();
  expect(profileEndpoint("https://docs.example/文")).toBe("https://docs.example/%E6%96%87");
});

it.each(["create", "create_oauth", "rotate", "rekey"])("removed command %s never reaches admission", async action => {
  const f = fixture(); expect(await f.run({ ...command, action })).toEqual({ state: "invalid" }); expect(f.ports.authorize).not.toHaveBeenCalled();
});
