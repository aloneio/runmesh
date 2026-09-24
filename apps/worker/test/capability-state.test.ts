import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { CapabilitiesDOv1 } from "../src/platform/capabilities/owner.js";
import { CapabilityState } from "../src/platform/capabilities/store.js";
import { CAPABILITY_LIMITS, type GrantReplacement } from "../src/contracts/capabilities.js";

function owner() {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  return namespace.get(namespace.idFromName(`central-state-${crypto.randomUUID()}`));
}
const create: GrantReplacement = { client_id: "client-test", expected_revision: 0, enabled: true,
  rules: [{ kind: "skill", resource_id: "release-review", version: "a".repeat(64) }] };

it("W03 constructor and disabled HTTP surface do not initialize central tables", async () => {
  const stub = owner();
  expect((await stub.fetch("https://central.internal/grants")).status).toBe(404);
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capabilities_meta'").toArray()).toEqual([]);
  });
});

it("W03 central records use their own namespace and never require a Runner", async () => {
  const stub = owner(), other = owner();
  expect(await stub.replaceGrant(create)).toMatchObject({ state: "written", grant: { revision: 1 } });
  expect(await other.readGrant(create.client_id)).toBeUndefined();
  expect(await stub.readGrant(create.client_id)).toMatchObject({ client_id: create.client_id, enabled: true, rules: create.rules });
  await runInDurableObject(stub, (_instance, state) => {
    const names = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
    expect(names).toContain("capability_grants_v1");
    expect(names).not.toContain("mcp_clients");
    expect(names).not.toContain("runners");
  });
});

it("W03 concurrent replacements require the observed revision and preserve disable history", async () => {
  const stub = owner();
  const results = await Promise.all([stub.replaceGrant(create), stub.replaceGrant(create)]);
  expect(results.map(result => result.state).sort()).toEqual(["conflict", "written"]);
  expect(await stub.replaceGrant({ ...create, expected_revision: 1, enabled: false })).toMatchObject({ state: "written", grant: { revision: 2, enabled: false, rules: create.rules } });
  expect(await stub.replaceGrant(create)).toEqual({ state: "conflict", current_revision: 2 });
});

it("W03 unknown schema versions are not reset or silently downgraded", async () => {
  const stub = owner();
  await stub.replaceGrant(create);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE capabilities_meta SET schema_version=2 WHERE id=1");
    expect(() => new CapabilityState(state.storage).readGrant(create.client_id)).toThrow("capabilities_schema_unsupported");
    expect(state.storage.sql.exec<{ revision: number }>("SELECT revision FROM capability_grants_v1 WHERE client_id=?", create.client_id).one().revision).toBe(1);
    expect(state.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM capabilities_meta WHERE id=1").one().schema_version).toBe(2);
  });
});

it("W03 incomplete or foreign state is preserved and rejected", async () => {
  const stub = owner();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("CREATE TABLE unrelated (value TEXT)");
    state.storage.sql.exec("INSERT INTO unrelated VALUES ('preserve')");
    expect(() => new CapabilityState(state.storage).readGrant(create.client_id)).toThrow("capabilities_schema_unsupported");
    expect(state.storage.sql.exec("SELECT * FROM unrelated").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capabilities_meta'").toArray()).toEqual([]);
  });
});

it("W03 malformed stored rules are not treated as missing permission data", async () => {
  const stub = owner();
  await stub.replaceGrant(create);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE capability_grants_v1 SET rules_json='not-json'");
    expect(() => new CapabilityState(state.storage).readGrant(create.client_id)).toThrow("capability_record_invalid");
  });
});

it("W03 grant capacity is bounded while disabling an existing record remains possible", async () => {
  const stub = owner();
  await stub.readGrant(create.client_id);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n < ?) INSERT INTO capability_grants_v1 SELECT 'client-' || n, 1, 1, '[]' FROM ids", CAPABILITY_LIMITS.grant_clients);
  });
  expect(await stub.replaceGrant(create)).toEqual({ state: "capacity" });
  expect(await stub.replaceGrant({ ...create, client_id: "client-1", expected_revision: 1, enabled: false })).toMatchObject({ state: "written" });
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER])("W03 rejects unsafe expected revision %s", async expected_revision => {
  const stub = owner();
  expect(await stub.replaceGrant({ ...create, expected_revision })).toEqual({ state: "invalid" });
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capabilities_meta'").toArray()).toEqual([]);
  });
});
