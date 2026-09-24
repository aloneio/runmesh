import { expect, it, vi } from "vitest";
import { createCapabilityAccess } from "../../apps/worker/src/application/capabilities/access.js";
import { CAPABILITY_LIMITS, parseCapabilityGrant, type CapabilityGrant, type CapabilityTarget } from "../../apps/worker/src/contracts/capabilities.js";

const principal = { client_id: "client-test", secret_version: 1 };
const identity = { ...principal, schema_version: 2 as const, label: "Central", native_scopes: [] };
const target: CapabilityTarget = { kind: "remote_tool", resource_id: "docs.search", version: "a".repeat(64), connection_profile_id: "shared-docs" };
const grant: CapabilityGrant = { schema_version: 1, client_id: principal.client_id, revision: 1, enabled: true, rules: [target] };
const signal = () => new AbortController().signal;
function fixture(value: CapabilityGrant | undefined = grant) {
  const ports = { identity: { revalidate: vi.fn(async () => ({ state: "allowed" as const, identity })) },
    grants: { readGrant: vi.fn(async () => value) } };
  return { ports, access: createCapabilityAccess(true, () => ports) };
}

it("W03 disabled central access does not resolve ports, bindings or credentials", async () => {
  const load = vi.fn(() => { throw new Error("must not resolve"); });
  const access = createCapabilityAccess(false, load);
  expect(load).not.toHaveBeenCalled();
  expect(await access.check(principal, target, signal())).toEqual({ state: "disabled" });
  expect(load).not.toHaveBeenCalled();
});

it("W02 central grants work without native scopes or any Runner dependency", async () => {
  const { access, ports } = fixture();
  expect(await access.check(principal, target, signal())).toEqual({ state: "allowed", identity, grant_revision: 1 });
  expect(ports.identity.revalidate).toHaveBeenCalledTimes(2);
  expect(ports.grants.readGrant).toHaveBeenCalledOnce();
});

it.each([undefined, { ...grant, enabled: false }, { ...grant, client_id: "other" }, { ...grant, rules: [] }])(
  "W03 absent, disabled or foreign grants deny rather than using coding scopes", async value => {
    const { access, ports } = fixture();
    ports.grants.readGrant.mockResolvedValue(value);
    expect(await access.check(principal, target, signal())).toEqual({ state: "denied" });
  });

it.each([{ ...target, version: "b".repeat(64) }, { ...target, connection_profile_id: "other-profile" },
  { kind: "skill", resource_id: target.resource_id, version: target.version }])("W03 requires exact resource version and connection ownership", async value => {
  expect(await fixture().access.check(principal, value as CapabilityTarget, signal())).toEqual({ state: "denied" });
});

it("W03 identity revoked during independent grant reads is rejected", async () => {
  let calls = 0;
  const access = createCapabilityAccess(true, () => ({
    identity: { revalidate: async () => ++calls === 1 ? { state: "allowed", identity } : { state: "denied" } },
    grants: { readGrant: async () => grant },
  }));
  expect(await access.check(principal, target, signal())).toEqual({ state: "denied" });
});

it("W03 a failed grant owner is unavailable, not an empty successful result", async () => {
  const { access, ports } = fixture();
  ports.grants.readGrant.mockRejectedValue(new Error("synthetic storage outage"));
  expect(await access.check(principal, target, signal())).toEqual({ state: "unavailable" });
});

it("W03 malformed grant records do not become authorization", async () => {
  const { access, ports } = fixture();
  ports.grants.readGrant.mockResolvedValue({ ...grant, revision: 0 });
  expect(await access.check(principal, target, signal())).toEqual({ state: "malformed" });
});

it("W03 a stalled dependency has a bounded deadline and no persistent timer", async () => {
  vi.useFakeTimers();
  try {
    const { access, ports } = fixture();
    ports.grants.readGrant.mockImplementation(() => new Promise(() => undefined));
    const pending = access.check(principal, target, signal());
    await vi.advanceTimersByTimeAsync(CAPABILITY_LIMITS.access_timeout_ms + 1);
    expect(await pending).toEqual({ state: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("W03 an expired observation cannot beat a delayed timer callback", async () => {
  let clock = 100;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const { access, ports } = fixture();
    ports.grants.readGrant.mockImplementation(async () => { clock += CAPABILITY_LIMITS.access_timeout_ms + 1; return grant; });
    expect(await access.check(principal, target, signal())).toEqual({ state: "unavailable" });
    expect(ports.identity.revalidate).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); }
});

it("W03 cancellation stops waiting without a retry", async () => {
  const controller = new AbortController();
  const { access, ports } = fixture();
  ports.grants.readGrant.mockImplementation(() => new Promise(() => undefined));
  const pending = access.check(principal, target, controller.signal);
  controller.abort();
  expect(await pending).toEqual({ state: "unavailable" });
  expect(ports.identity.revalidate).toHaveBeenCalledOnce();
});

it("W03 grant decoding is bounded, rejects duplicates and strips unrelated content", () => {
  expect(parseCapabilityGrant({ ...grant, rules: [target, target] })).toBeUndefined();
  expect(parseCapabilityGrant({ ...grant, rules: Array.from({ length: 129 }, (_, i) => ({ ...target, resource_id: `tool-${i}` })) })).toBeUndefined();
  expect(parseCapabilityGrant({ ...grant, credential: "private", rules: [{ ...target, script: "not executable" }] })).toEqual(grant);
});
