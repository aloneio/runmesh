import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { CapabilityState } from "../src/platform/capabilities/store.js";
import { CatalogState } from "../src/platform/capabilities/catalog-store.js";
import { createCatalogCursor, newCatalogCursorKey } from "../src/platform/capabilities/catalog-crypto.js";
import { CATALOG_LIMITS, type CatalogCursor } from "../src/contracts/catalog.js";
import { catalogDefinition, catalogSnapshot } from "../../../test/domain/catalog-fixtures.js";

function owner() {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  return namespace.get(namespace.idFromName(`catalog-state-${crypto.randomUUID()}`));
}
function repository(storage: DurableObjectStorage) {
  const grants = new CapabilityState(storage);
  return new CatalogState(storage, () => grants.initialize());
}

it("W04 catalog construction creates no tables and no credentials", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    repository(state.storage);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='catalog_meta'").toArray()).toEqual([]);
  });
});

it("W04 staging preserves immutable bodies and never implicitly approves", async () => {
  const a = await catalogSnapshot(), b = await catalogSnapshot("docs", [catalogDefinition("search", "Updated description")]);
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    expect(store.stage(a, 0)).toMatchObject({ state: "written", head: { revision: 1, observed_digest: a.digest, approved_digest: null, approved_names: [] } });
    expect(store.approve("docs", a.digest, ["search"], 1)).toMatchObject({ state: "written", head: { revision: 2 } });
    expect(store.stage(b, 2)).toMatchObject({ state: "written", head: { revision: 3, observed_digest: b.digest, approved_digest: a.digest } });
    expect(store.readSnapshot("docs", a.digest)).toEqual(a);
    expect(store.readSnapshot("docs", b.digest)).toEqual(b);
    expect(store.approve("docs", a.digest, ["search"], 3)).toEqual({ state: "invalid" });
    expect(store.approve("docs", b.digest, ["missing"], 3)).toEqual({ state: "invalid" });
    expect(store.stage(b, 3)).toMatchObject({ state: "written", head: { revision: 4 } });
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_snapshots_v1").one().n).toBe(2);
  });
});

it("W04 stale revisions, duplicate selections and mismatched digests cannot publish", async () => {
  const snapshot = await catalogSnapshot();
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    store.stage(snapshot, 0);
    expect(store.stage(snapshot, 0)).toEqual({ state: "conflict", current_revision: 1 });
    expect(store.approve("docs", snapshot.digest, ["search", "search"], 1)).toEqual({ state: "invalid" });
    expect(store.approve("docs", "a".repeat(64), ["search"], 1)).toEqual({ state: "invalid" });
    expect(store.disable("docs", 0)).toEqual({ state: "invalid" });
    expect(store.readHead("docs")?.revision).toBe(1);
    expect(store.stage(snapshot, Number.MAX_SAFE_INTEGER - 1)).toEqual({ state: "invalid" });
  });
});

it("W04 a failure updating the head rolls back a newly inserted snapshot", async () => {
  const first = await catalogSnapshot(), next = await catalogSnapshot("docs", [catalogDefinition("search", "Second capture")]);
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage); store.stage(first, 0);
    state.storage.sql.exec("CREATE TRIGGER reject_catalog_head BEFORE UPDATE ON catalog_heads_v1 BEGIN SELECT RAISE(ABORT,'synthetic catalog fault'); END");
    expect(() => store.stage(next, 1)).toThrow();
    expect(store.readSnapshot("docs", next.digest)).toBeUndefined();
    expect(store.readHead("docs")?.observed_digest).toBe(first.digest);
  });
});

it("W04 disable retains immutable snapshots and rollback still requires review", async () => {
  const first = await catalogSnapshot(), next = await catalogSnapshot("docs", [catalogDefinition("search", "Second capture")]);
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    store.stage(first, 0); store.approve("docs", first.digest, ["search"], 1); store.stage(next, 2);
    expect(store.disable("docs", 3)).toMatchObject({ state: "written", head: { revision: 4, approved_digest: null } });
    store.stage(first, 4);
    expect(store.readHead("docs")?.approved_digest).toBeNull();
    expect(store.approve("docs", first.digest, ["search"], 5)).toMatchObject({ state: "written", head: { revision: 6, approved_digest: first.digest } });
    expect(store.readSnapshot("docs", next.digest)).toEqual(next);
  });
});

it("W04 unknown and partial schemas are rejected without resetting data", async () => {
  const snapshot = await catalogSnapshot();
  await runInDurableObject(owner(), (_instance, state) => {
    repository(state.storage).stage(snapshot, 0);
    state.storage.sql.exec("UPDATE catalog_meta SET schema_version=2 WHERE id=1");
    expect(() => repository(state.storage).readHead("docs")).toThrow("catalog_schema_unsupported");
    expect(state.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM catalog_meta").one().schema_version).toBe(2);
    expect(state.storage.sql.exec("SELECT * FROM catalog_snapshots_v1").toArray()).toHaveLength(1);
    state.storage.sql.exec("UPDATE catalog_meta SET schema_version=1 WHERE id=1");
    state.storage.sql.exec("DROP TABLE catalog_heads_v1");
    expect(() => repository(state.storage).readHead("docs")).toThrow("catalog_schema_unsupported");
    expect(state.storage.sql.exec("SELECT * FROM catalog_snapshots_v1").toArray()).toHaveLength(1);
  });
});

it("W04 read and immutable insert reject corrupted stored snapshots", async () => {
  const snapshot = await catalogSnapshot();
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage); store.stage(snapshot, 0);
    const changed = structuredClone(snapshot);
    (changed.tools[0]!.definition as { description: string }).description = "Tampered text";
    expect(() => store.stage(changed, 1)).toThrow("catalog_digest_conflict");
    expect(store.readSnapshot("docs", snapshot.digest)).toEqual(snapshot);
    state.storage.sql.exec("UPDATE catalog_snapshots_v1 SET snapshot_json='not-json'");
    expect(() => store.readSnapshot("docs", snapshot.digest)).toThrow("catalog_record_invalid");
  });
});

it("W04 per-profile versions are bounded while stop/review of retained data remains possible", async () => {
  const snapshots = [];
  for (let i = 0; i <= CATALOG_LIMITS.versions_per_profile; i++) snapshots.push(await catalogSnapshot("docs", [catalogDefinition("search", `Version ${i}`)]));
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    for (let i = 0; i < CATALOG_LIMITS.versions_per_profile; i++) expect(store.stage(snapshots[i]!, i).state).toBe("written");
    expect(store.stage(snapshots.at(-1)!, CATALOG_LIMITS.versions_per_profile)).toEqual({ state: "capacity" });
    expect(store.disable("docs", CATALOG_LIMITS.versions_per_profile).state).toBe("written");
    expect(store.readSnapshot("docs", snapshots[0]!.digest)).toEqual(snapshots[0]);
  });
});

it("W04 bounded catalog storage accepts 100 fixture profiles and 2000 tool definitions", async () => {
  const snapshots = [];
  const tools = Array.from({ length: 20 }, (_, index) => catalogDefinition(`tool-${String(index).padStart(2, "0")}`));
  for (let index = 0; index < 100; index++) snapshots.push(await catalogSnapshot(`bulk-${index}`, tools));
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    for (const snapshot of snapshots) expect(store.stage(snapshot, 0).state).toBe("written");
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_heads_v1").one().n).toBe(100);
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_snapshots_v1").one().n).toBe(100);
    expect(store.readSnapshot("bulk-0", snapshots[0]!.digest)?.tools).toHaveLength(20);
    console.log(JSON.stringify({ scenario: "W04_fixture_catalog_inventory", profiles: 100, tools: 2000, upstream_requests: 0 }));
  });
});

it("W04 total storage budget rejects new captures but does not prevent disabling", async () => {
  const first = await catalogSnapshot(), next = await catalogSnapshot("docs", [catalogDefinition("search", "new")]);
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage); store.stage(first, 0);
    // The synthetic second row exercises the accounting limit without allocating
    // a large body. It is never selected, read, approved or presented as a snapshot.
    state.storage.sql.exec("INSERT INTO catalog_snapshots_v1 VALUES (?,?,?,?)", "budget-fixture", "b".repeat(64), CATALOG_LIMITS.storage_bytes, "{}");
    expect(store.stage(next, 1)).toEqual({ state: "capacity" });
    expect(store.disable("docs", 1).state).toBe("written");
    expect(store.readSnapshot("docs", first.digest)).toEqual(first);
  });
});

it("W04 cursor MACs bind the owner and reject tampering without a shared credential", async () => {
  const key = newCatalogCursorKey(), codec = createCatalogCursor("owner-a", () => key), other = createCatalogCursor("owner-b", () => key);
  const value: CatalogCursor = { schema_version: 1, client_id: "client-test", secret_version: 1, profile_id: "docs", profile_revision: 2,
    grant_revision: 3, catalog_revision: 4, offset: 1, limit: 1, expires_at_ms: Date.now() + 1000 };
  const cursor = await codec.seal(value);
  expect(await codec.open(cursor)).toEqual(value);
  expect(await other.open(cursor)).toBeUndefined();
  const tampered = (cursor[0] === "A" ? "B" : "A") + cursor.slice(1);
  expect(await codec.open(tampered)).toBeUndefined();
  expect(await codec.open("a".repeat(CATALOG_LIMITS.cursor_bytes + 1))).toBeUndefined();
});
