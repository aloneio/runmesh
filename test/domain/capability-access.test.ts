import { expect, it } from "vitest";
import { createDirectoryReader } from "../../apps/worker/src/application/capabilities/directory.js";
import { createSharedProfileReader } from "../../apps/worker/src/application/capabilities/profile-read.js";
import { catalogProfile, catalogSnapshot, fixtureDigest } from "./catalog-fixtures.js";
import { parseCapabilityGrant, type CapabilityGrant } from "../../apps/worker/src/contracts/capabilities.js";
const target = { kind: "skill" as const, resource_id: "legacy", version: "a".repeat(64) };
const grant: CapabilityGrant = { schema_version: 1, client_id: "legacy", revision: 1, enabled: true, rules: [target] };

it("shared profile discovery crosses storage pages and exceeds direct catalog limits without grants", async () => {
  const profiles = Array.from({ length: 51 }, (_, n) => catalogProfile("service-" + String(n).padStart(3, "0")));
  const snapshot = await catalogSnapshot();
  const ports = {
    profiles: (after: string) => { const rest = profiles.filter(p => p.profile_id > after); return { profiles: rest.slice(0, 50), next_after: rest.length > 50 ? rest[49]!.profile_id : null }; },
    profile: (id: string) => profiles.find(p => p.profile_id === id),
    repository: { readHead: (profile_id: string) => ({ schema_version: 1 as const, profile_id, revision: 1, observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: ["search"] }),
      readSnapshot: () => snapshot, stage: () => ({ state: "invalid" as const }), approve: () => ({ state: "invalid" as const }), disable: () => ({ state: "invalid" as const }) },
    identity: async (p: { client_id: string; secret_version: number }) => ({ state: "allowed" as const, identity: { ...p, schema_version: 2 as const, label: "Fixture", native_scopes: [] } }),
    cursor: { seal: async () => "unused", open: async () => undefined }, now: Date.now, digest: fixtureDigest,
  };
  for (const client_id of ["first", "second"]) {
    const principal = { client_id, secret_version: 1 }, signal = new AbortController().signal;
    const result = await createSharedProfileReader(ports)(principal, signal);
    expect(result.state === "listed" && result.profiles).toHaveLength(51);
    expect(await createDirectoryReader(ports)(principal, signal, () => false)).toEqual({ state: "capacity" });
  }
  profiles[0]!.enabled = false;
  const result = await createSharedProfileReader(ports)({ client_id: "first", secret_version: 1 }, new AbortController().signal);
  expect(result.state === "listed" && result.profiles).toHaveLength(50);
  const revoked = { ...ports, identity: async () => ({ state: "denied" as const }) };
  expect(await createSharedProfileReader(revoked)({ client_id: "first", secret_version: 1 }, new AbortController().signal)).toEqual({ state: "denied" });
});

it("shared profile discovery rejects looping pages and in-flight identity revocation", async () => {
  const profile = catalogProfile(), snapshot = await catalogSnapshot();
  let reads = 0;
  const ports = { profiles: () => ({ profiles: [profile], next_after: profile.profile_id }), profile: () => profile,
    repository: { readHead: () => ({ schema_version: 1 as const, profile_id: profile.profile_id, revision: 1, observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: ["search"] }),
      readSnapshot: () => snapshot, stage: () => ({ state: "invalid" as const }), approve: () => ({ state: "invalid" as const }), disable: () => ({ state: "invalid" as const }) },
    identity: async (p: { client_id: string; secret_version: number }) => ++reads > 1 ? { state: "denied" as const } : { state: "allowed" as const, identity: { ...p, schema_version: 2 as const, label: "Fixture", native_scopes: [] } },
  };
  const principal = { client_id: "first", secret_version: 1 }, signal = new AbortController().signal;
  expect(await createSharedProfileReader(ports)(principal, signal)).toEqual({ state: "unavailable" });
  reads = 0;
  expect(await createSharedProfileReader({ ...ports, profiles: () => ({ profiles: [profile], next_after: null }) })(principal, signal)).toEqual({ state: "denied" });
});

it("W03 grant decoding is bounded, rejects duplicates and strips unrelated content", () => {
  expect(parseCapabilityGrant({ ...grant, rules: [target, target] })).toBeUndefined();
  expect(parseCapabilityGrant({ ...grant, rules: Array.from({ length: 129 }, (_, i) => ({ ...target, resource_id: `tool-${i}` })) })).toBeUndefined();
  expect(parseCapabilityGrant({ ...grant, credential: "private", rules: [{ ...target, script: "not executable" }] })).toEqual(grant);
});
