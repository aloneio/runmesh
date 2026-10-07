import { expect, it } from "vitest";
import { capturedIdentityState, parseClientIdentity, parseNativeScopes, parseStoredNativeScopes, type IdentityDecision } from "../../apps/worker/src/contracts/identity.js";

const identity = { schema_version: 2 as const, client_id: "client-test", label: "Central only", secret_version: 1, native_scopes: [] };

it("W02 distinguishes a valid central-only identity from malformed legacy scopes", () => {
  expect(parseNativeScopes([])).toBeUndefined();
  expect(parseNativeScopes([], true)).toEqual([]);
  expect(parseStoredNativeScopes("[]")).toBeUndefined();
  expect(parseStoredNativeScopes('{"schema_version":2,"native_scopes":[]}')).toEqual([]);
  expect(parseStoredNativeScopes('["coding:read"]')).toEqual(["coding:read"]);
  expect(parseClientIdentity(identity)).toEqual(identity);
});

it.each([null, {}, { ...identity, schema_version: 3 }, { ...identity, client_id: "../wrong" },
  { ...identity, native_scopes: ["coding:read", "coding:read"] }, { ...identity, native_scopes: ["mcp:call"] },
  { ...identity, secret_version: 0 }, { ...identity, label: " " }, { ...identity, label: "x".repeat(257) },
])("W02 rejects malformed or unknown identity contracts: %j", value => {
  expect(parseClientIdentity(value)).toBeUndefined();
});

it.each(["", "null", "{}", '"coding:read"', '["unknown"]', '{"schema_version":3,"native_scopes":[]}',
  '{"schema_version":2,"native_scopes":[],"grant":"all"}', " ".repeat(1025),
])("W02 persisted scope decoding fails closed: %s", value => {
  expect(parseStoredNativeScopes(value)).toBeUndefined();
});

it("W02 identity projection omits arbitrary fields and does not alias input scopes", () => {
  const native_scopes = ["coding:read"];
  const parsed = parseClientIdentity({ ...identity, native_scopes, credential: "test-only", central_grants: ["all"] });
  native_scopes.push("coding:exec");
  expect(parsed).toEqual({ ...identity, native_scopes: ["coding:read"] });
});

const capturedCases: readonly [IdentityDecision, ReturnType<typeof capturedIdentityState>][] = [
  [{ state: "allowed", identity }, "allowed"],
  [{ state: "allowed", identity: { ...identity, client_id: "another-client" } }, "denied"],
  [{ state: "allowed", identity: { ...identity, secret_version: 2 } }, "denied"],
  // @ts-expect-error Unknown-version receipt intentionally violates the declared identity contract.
  [{ state: "allowed", identity: { ...identity, schema_version: 3 } }, "unavailable"],
  [{ state: "allowed", identity: { ...identity, secret_version: 0 } }, "unavailable"],
  // @ts-expect-error Empty receipt intentionally violates the declared identity contract.
  [{ state: "allowed", identity: null }, "unavailable"],
  [{ state: "malformed" }, "unavailable"],
  [{ state: "unavailable" }, "unavailable"],
  [{ state: "denied" }, "denied"],
];
it.each(capturedCases)("W02 captured identity distinguishes rejection from an unreadable observation: %j", (decision, state) => {
  expect(capturedIdentityState(identity, decision)).toBe(state);
});
