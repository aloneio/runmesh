import { expect, it, vi } from "vitest";
import { createProfileManager } from "../../apps/worker/src/application/connectors/profiles.js";
import { profileEndpoint } from "../../apps/worker/src/contracts/connector-values.js";
import type { AdminDecision, ProfileRecord, ProfileResult } from "../../apps/worker/src/contracts/connectors.js";

const command = { action: "create", profile_id: "docs", connector_id: "docs", endpoint: "https://docs.example/mcp",
  credential: { kind: "bearer", token: "synthetic-token" } };
function fixture() {
  let record: ProfileRecord | undefined;
  const envelope = { schema_version: 1 as const, key_id: "test", iv: "A".repeat(16), ciphertext: "A".repeat(40) };
  const ports = {
    authorize: vi.fn(async (): Promise<AdminDecision> => "allowed"),
    repository: { read: vi.fn(() => record), replace: vi.fn((next: ProfileRecord, expected: number): ProfileResult => {
      if ((record?.profile.revision ?? 0) !== expected) return { state: "conflict", current_revision: record?.profile.revision ?? 0 };
      record = structuredClone(next); return { state: "written", profile: next.profile };
    }) },
    cipher: { seal: vi.fn(async () => ({ ...envelope })), open: vi.fn(async () => ({ kind: "bearer" as const, token: "synthetic-old" })) },
  };
  const manager = createProfileManager(ports);
  return { ports, record: () => record, run: (value: unknown, signal = new AbortController().signal) => manager.mutate(value, signal) };
}

it("W03 creates disabled profiles then rotates only an observed generation", async () => {
  const f = fixture();
  expect(await f.run(command)).toMatchObject({ state: "written", profile: { enabled: false, revision: 1 } });
  expect(await f.run({ action: "rotate", profile_id: "docs", expected_revision: 1, credential: command.credential }))
    .toMatchObject({ state: "written", profile: { revision: 2, credential: { secret_version: 2 } } });
  expect(await f.run({ action: "disable", profile_id: "docs", expected_revision: 1 })).toEqual({ state: "conflict", current_revision: 2 });
});

it.each(["denied", "unavailable"] as const)("W03 initial %s does not touch state or crypto", async decision => {
  const f = fixture(); f.ports.authorize.mockResolvedValue(decision);
  expect(await f.run(command)).toEqual({ state: decision });
  expect(f.ports.repository.read).not.toHaveBeenCalled(); expect(f.ports.cipher.seal).not.toHaveBeenCalled();
});

it("W03 revocation during encryption prevents any write", async () => {
  const f = fixture();
  f.ports.authorize.mockResolvedValueOnce("allowed").mockResolvedValueOnce("denied");
  expect(await f.run(command)).toEqual({ state: "denied" });
  expect(f.ports.repository.replace).not.toHaveBeenCalled();
});

it("W03 disabling does not require decryption or a currently usable key", async () => {
  const f = fixture(); await f.run(command);
  f.ports.cipher.seal.mockRejectedValue(new Error("key unavailable"));
  expect(await f.run({ action: "disable", profile_id: "docs", expected_revision: 1 })).toMatchObject({ state: "written" });
  expect(f.ports.cipher.open).not.toHaveBeenCalled();
  expect(f.ports.cipher.seal).toHaveBeenCalledOnce();
});

it("W03 rekey decrypts the previous generation before sealing a new one", async () => {
  const f = fixture(); await f.run(command);
  expect(await f.run({ action: "rekey", profile_id: "docs", expected_revision: 1 })).toMatchObject({ state: "written", profile: { credential: { secret_version: 2 } } });
  expect(f.ports.cipher.open).toHaveBeenCalledOnce();
  expect(f.ports.cipher.seal).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }), { kind: "bearer", token: "synthetic-old" });
});

it("W03 uncertain commit errors are not reported as safely retryable", async () => {
  const f = fixture(); f.ports.repository.replace.mockImplementation(() => { throw new Error("receipt lost"); });
  expect(await f.run(command)).toEqual({ state: "unknown" });
  expect(f.ports.repository.replace).toHaveBeenCalledOnce();
});

it("W03 crypto failures remain unavailable and do not write", async () => {
  const f = fixture(); f.ports.cipher.seal.mockRejectedValue(new Error("private details"));
  expect(await f.run(command)).toEqual({ state: "unavailable" });
  expect(f.ports.repository.replace).not.toHaveBeenCalled();
});

it("W03 aborted and expired operations do not commit or leave timers", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); f.ports.cipher.seal.mockImplementation(() => new Promise(() => undefined));
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

it("W03 malformed storage or crypto adapters cannot cross the mutation boundary", async () => {
  const f = fixture(); await f.run(command);
  f.ports.repository.read.mockReturnValue({ ...f.record()!, profile: { ...f.record()!.profile, profile_id: "other" } });
  expect(await f.run({ action: "disable", profile_id: "docs", expected_revision: 1 })).toEqual({ state: "unavailable" });
  expect(f.ports.repository.replace).toHaveBeenCalledOnce();
  const badCipher = fixture();
  badCipher.ports.cipher.seal.mockResolvedValue({ schema_version: 1, key_id: "bad", iv: "short", ciphertext: "invalid" });
  expect(await badCipher.run(command)).toEqual({ state: "unavailable" });
  expect(badCipher.ports.repository.replace).not.toHaveBeenCalled();
});

it("W03 expired crypto completion cannot beat a late timer and commit", async () => {
  let clock = 100;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const f = fixture();
    f.ports.cipher.seal.mockImplementation(async () => {
      clock += 5_001; return { schema_version: 1, key_id: "test", iv: "A".repeat(16), ciphertext: "A".repeat(40) };
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
