import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";

function owner() {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  return namespace.get(namespace.idFromName("central-schema-" + crypto.randomUUID()));
}

it("central namespace initialization is lazy, idempotent and independent of removed authorization tables", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capabilities_meta'").toArray()).toEqual([]);
    schema.initialize(); schema.initialize(); new CentralSchema(state.storage).initialize();
    expect(state.storage.sql.exec("SELECT * FROM capabilities_meta").toArray()).toEqual([{ id: 1, schema_version: 1 }]);
    const names = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
    expect(names).not.toContain("capability_grants_v1");
    expect(names).not.toContain("central_toolsets_v1");
    expect(names).not.toContain("connection_profiles_v1");
    expect(names).not.toContain("skill_heads_v1");
  });
});

it("central namespace rejects unknown versions without rewriting data", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    new CentralSchema(state.storage).initialize();
    state.storage.sql.exec("UPDATE capabilities_meta SET schema_version=99 WHERE id=1");
    expect(() => new CentralSchema(state.storage).initialize()).toThrow("capabilities_schema_unsupported");
    expect(state.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM capabilities_meta").one().schema_version).toBe(99);
  });
});

it("central namespace rejects partial or foreign state without fabricating ownership", async () => {
  for (const partial of [false, true]) await runInDurableObject(owner(), (_instance, state) => {
    if (partial) state.storage.sql.exec("CREATE TABLE capabilities_meta (id INTEGER PRIMARY KEY, schema_version INTEGER)");
    else { state.storage.sql.exec("CREATE TABLE unrelated (value TEXT)"); state.storage.sql.exec("INSERT INTO unrelated VALUES ('preserve')"); }
    expect(() => new CentralSchema(state.storage).initialize()).toThrow("capabilities_schema_unsupported");
    if (partial) expect(state.storage.sql.exec("SELECT * FROM capabilities_meta").toArray()).toEqual([]);
    else expect(state.storage.sql.exec("SELECT * FROM unrelated").toArray()).toEqual([{ value: "preserve" }]);
  });
});

it("namespace initialization rolls back atomically after a storage fault", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const sql = { exec: (query: string, ...args: unknown[]) => {
      const result = state.storage.sql.exec(query, ...args);
      if (query.startsWith("INSERT INTO capabilities_meta")) throw new Error("injected storage failure");
      return result;
    } } as unknown as DurableObjectStorage["sql"];
    const schema = new CentralSchema({ sql, transactionSync: operation => state.storage.transactionSync(operation) });
    expect(() => schema.initialize()).toThrow("injected storage failure");
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capabilities_meta'").toArray()).toEqual([]);
    expect(() => new CentralSchema(state.storage).initialize()).not.toThrow();
  });
});
