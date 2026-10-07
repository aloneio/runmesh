import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { ConnectionState } from "../src/platform/connectors/store.js";
import { CONNECTOR_LIMITS, type ProfileRecord } from "../src/contracts/connectors.js";

const record: ProfileRecord = { profile: { schema_version: 1, profile_id: "profile-a", connector_id: "docs", endpoint: "https://docs.example/mcp",
  owner: { kind: "instance_admin" }, revision: 1, enabled: false, authentication: "none", credential: null },
  envelope: null };
function owner() {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  return namespace.get(namespace.idFromName(`connector-state-${crypto.randomUUID()}`));
}
const store = (state: DurableObjectState) => new ConnectionState(state.storage, () => new CentralSchema(state.storage).initialize());

it("W03 connection repository initializes independently of client authorization storage", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const repository = store(state);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='connector_meta'").toArray()).toEqual([]);
    expect(repository.replace(record, 0)).toMatchObject({ state: "written" });
    const schema = new CentralSchema(state.storage);
    schema.initialize();
    expect(store(state).read("profile-a")).toEqual(record);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='capability_grants_v1'").toArray()).toEqual([]);
  });
});

it("W03 observed revisions prevent overwrites and destination changes", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const repository = store(state);
    expect(repository.replace(record, 0)).toMatchObject({ state: "written" });
    expect(repository.replace(record, 0)).toEqual({ state: "conflict", current_revision: 1 });
    const next = { ...record, profile: { ...record.profile, revision: 2, enabled: true } };
    expect(repository.replace({ ...next, profile: { ...next.profile, endpoint: "https://other.example/mcp" } }, 1)).toEqual({ state: "invalid" });
    expect(repository.replace({ ...next, envelope: JSON.parse('{"ciphertext":"unexpected"}') }, 1)).toEqual({ state: "invalid" });
    expect(repository.replace(next, 1)).toMatchObject({ state: "written" });
    expect(repository.read("profile-a")).toEqual(next);
  });
});

it("connection profile pages use one bounded metadata read without changing pagination", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const repository = store(state);
    const profiles = Array.from({ length: 52 }, (_, index) => ({ ...record.profile, profile_id: `profile-${String(index).padStart(2, "0")}` }));
    for (const profile of profiles) expect(repository.replace({ ...record, profile }, 0)).toMatchObject({ state: "written" });
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const measurements: Array<{ after: string; queries: number; read: number; written: number }> = [];
    for (const after of ["", "profile-49", "profile-51"]) {
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const exec = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
        const cursor = original(query, ...args); cursors.push(cursor); return cursor;
      });
      try {
        const candidates = profiles.filter(profile => profile.profile_id > after);
        expect(repository.list(after)).toEqual({ profiles: candidates.slice(0, 50),
          next_after: candidates.length > 50 ? candidates[49]!.profile_id : null });
        measurements.push({ after, queries: cursors.length,
          read: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
          written: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) });
      } finally { exec.mockRestore(); }
    }
    console.info("connection-profile-page-sql", JSON.stringify(measurements));
    for (const measurement of measurements) {
      expect(measurement.read).toBeLessThanOrEqual(51);
      expect(measurement.queries).toBe(1);
      expect(measurement.written).toBe(0);
    }
    state.storage.sql.exec("UPDATE connection_profiles_v1 SET profile_json='invalid' WHERE profile_id='profile-50'");
    expect(repository.list()).toEqual({ profiles: profiles.slice(0, 50), next_after: "profile-49" });
    expect(() => repository.list("profile-49")).toThrow("connector_record_invalid");
  });
});

it("W03 schema upgrades are forward-only and never clear unknown version data", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const repository = store(state); repository.replace(record, 0);
    state.storage.sql.exec("UPDATE connector_meta SET schema_version=2 WHERE id=1");
    expect(() => store(state).read("profile-a")).toThrow("connector_schema_unsupported");
    expect(state.storage.sql.exec("SELECT * FROM connection_profiles_v1").toArray()).toHaveLength(1);
    expect(() => new CentralSchema(state.storage).initialize()).not.toThrow();
    expect(state.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM connector_meta WHERE id=1").one().schema_version).toBe(2);
  });
});

it("W03 partial connector migrations remain failures rather than creating replacement tables", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    new CentralSchema(state.storage).initialize();
    state.storage.sql.exec("CREATE TABLE connector_meta (id INTEGER PRIMARY KEY, schema_version INTEGER)");
    state.storage.sql.exec("INSERT INTO connector_meta VALUES(1,1)");
    expect(() => store(state).read("profile-a")).toThrow("connector_schema_unsupported");
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='connection_profiles_v1'").toArray()).toEqual([]);
  });
});

it.each(["invalid-json", "wrong-id", "wrong-revision", "oversized-envelope"])("W03 rejects corrupt stored %s without returning it", async field => {
  await runInDurableObject(owner(), (_instance, state) => {
    const repository = store(state); repository.replace(record, 0);
    if (field === "invalid-json") state.storage.sql.exec("UPDATE connection_profiles_v1 SET profile_json='invalid'");
    if (field === "wrong-id") state.storage.sql.exec("UPDATE connection_profiles_v1 SET profile_json=?", JSON.stringify({ ...record.profile, profile_id: "other" }));
    if (field === "wrong-revision") state.storage.sql.exec("UPDATE connection_profiles_v1 SET revision=2");
    if (field === "oversized-envelope") state.storage.sql.exec("UPDATE connection_profiles_v1 SET envelope_json=?", "a".repeat(CONNECTOR_LIMITS.profile_bytes + 1));
    expect(() => repository.read("profile-a")).toThrow("connector_record_invalid");
    expect(() => repository.list()).toThrow("connector_record_invalid");
    expect(repository.list("profile-a")).toEqual({ profiles: [], next_after: null });
    expect(state.storage.sql.exec("SELECT * FROM connection_profiles_v1").toArray()).toHaveLength(1);
  });
});

it("W03 storage faults roll back profile writes atomically", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const repository = store(state); repository.read("profile-a");
    const sql = { exec: (query: string, ...args: unknown[]) => {
      const result = state.storage.sql.exec(query, ...args);
      if (query.startsWith("INSERT INTO connection_profiles_v1")) throw new Error("synthetic transaction failure");
      return result;
    } } as unknown as SqlStorage;
    const faulty = new ConnectionState({ sql, transactionSync: state.storage.transactionSync.bind(state.storage) }, () => undefined);
    expect(() => faulty.replace(record, 0)).toThrow("synthetic transaction failure");
    expect(repository.read("profile-a")).toBeUndefined();
  });
});
