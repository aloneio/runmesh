import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import type { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { CatalogState } from "../src/platform/capabilities/catalog-store.js";
import { createCatalogCursor, newCatalogCursorKey } from "../src/platform/capabilities/catalog-crypto.js";
import { CATALOG_LIMITS, type CatalogCursor } from "../src/contracts/catalog.js";
import { catalogDefinition, catalogProfile, catalogSnapshot, fixtureDigest } from "../../../test/domain/catalog-fixtures.js";
import { createRemoteCaller } from "../src/application/capabilities/remote-call.js";
import { createCatalogManager } from "../src/application/capabilities/catalog-admin.js";

function owner() {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  return namespace.get(namespace.idFromName(`catalog-state-${crypto.randomUUID()}`));
}
function repository(storage: DurableObjectStorage) {
  const schema = new CentralSchema(storage);
  return new CatalogState(storage, () => schema.initialize());
}

it.each(["current", "changed", "approved-history", "aliased-approved", "denied", "revision"])("catalog inspection verifies each distinct snapshot once and preserves final fences: %s", async mode => {
  const first = await catalogSnapshot(), second = await catalogSnapshot("docs", [catalogDefinition("search", "New description")]);
  await runInDurableObject(owner(), async (_instance, state) => {
    const store = repository(state.storage); store.publish(first, 0);
    if (mode === "changed" || mode === "approved-history" || mode === "aliased-approved") store.stage(second, 1);
    const read = vi.spyOn(store, "readSnapshot"), digest = vi.fn(fixtureDigest);
    if (mode === "aliased-approved") read.mockReturnValue(second);
    let authorizations = 0;
    const manager = createCatalogManager({ repository: store, profile: () => catalogProfile(), digest,
      authorize: async () => {
        if (++authorizations === 2) {
          if (mode === "denied") return "denied";
          if (mode === "revision") store.disable("docs", 1);
        }
        return "allowed";
      } });
    try {
      const result = await manager.inspect("docs", mode === "approved-history" ? first.digest : undefined, new AbortController().signal, () => false);
      expect(result.state).toBe(mode === "denied" ? "denied" : mode === "revision" || mode === "aliased-approved" ? "unavailable" : "found");
      if (result.state === "found") expect(result.changes).toEqual([{ name: "search", state: mode === "changed" ? "changed" : "unchanged" }]);
      expect(read).toHaveBeenCalledTimes(mode === "changed" || mode === "aliased-approved" ? 2 : 1);
      expect(digest).toHaveBeenCalledTimes(mode === "changed" ? 2 : 1);
      expect(authorizations).toBe(mode === "aliased-approved" ? 1 : 2);
    } finally { read.mockRestore(); }
  });
});

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

it("W04 catalog history rolls over while observed, approved and retained historical versions remain usable", async () => {
  const snapshots = [];
  for (let i = 0; i < CATALOG_LIMITS.versions_per_profile + 8; i++) snapshots.push(await catalogSnapshot("docs", [catalogDefinition("search", `Version ${i}`)]));
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    expect(store.publish(snapshots[0]!, 0).state).toBe("written");
    for (let i = 1; i < snapshots.length; i++) expect(store.stage(snapshots[i]!, i).state).toBe("written");
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_snapshots_v1").one().n).toBe(CATALOG_LIMITS.versions_per_profile);
    expect(store.readSnapshot("docs", snapshots[0]!.digest)).toEqual(snapshots[0]);
    expect(store.readSnapshot("docs", snapshots[1]!.digest)).toBeUndefined();
    expect(store.readHead("docs")).toMatchObject({ observed_digest: snapshots.at(-1)!.digest, approved_digest: snapshots[0]!.digest });
    const retained = snapshots.at(-2)!;
    expect(store.stage(retained, snapshots.length).state).toBe("written");
    expect(store.approve("docs", retained.digest, ["search"], snapshots.length + 1).state).toBe("written");
    expect(store.disable("docs", snapshots.length + 2).state).toBe("written");
    expect(store.readSnapshot("docs", retained.digest)).toEqual(retained);
  });
});

it("W04 publishing beyond the history window keeps current upstream tools callable", async () => {
  const snapshots = [];
  for (let i = 0; i <= CATALOG_LIMITS.versions_per_profile; i++) snapshots.push(await catalogSnapshot("docs", [catalogDefinition("search", `Release ${i}`)]));
  await runInDurableObject(owner(), async (_instance, state) => {
    const store = repository(state.storage), latest = snapshots.at(-1)!;
    for (let i = 0; i < snapshots.length; i++) expect(store.publish(snapshots[i]!, i).state).toBe("written");
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "current upstream result" }] }));
    const call = createRemoteCaller({ repository: store, profile: () => catalogProfile(), digest: fixtureDigest,
      identity: async principal => ({ state: "allowed", identity: { schema_version: 2, ...principal, label: "fixture", native_scopes: [] } }),
      connector: { validate: () => true, open: async () => ({ current: () => true, close: async () => undefined,
        listTools: async () => latest.tools.map(tool => tool.definition), callTool }) } });
    expect(await call({ client_id: "catalog-client", secret_version: 1 }, { profile_id: "docs", tool_id: latest.tools[0]!.tool_id,
      version: latest.tools[0]!.version, arguments: { query: "current" } }, new AbortController().signal)).toMatchObject({ state: "completed" });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

it("W04 failed or stale captures cannot partially prune retained history", async () => {
  const snapshots = [];
  for (let i = 0; i <= CATALOG_LIMITS.versions_per_profile; i++) snapshots.push(await catalogSnapshot("docs", [catalogDefinition("search", `Revision ${i}`)]));
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage), revision = CATALOG_LIMITS.versions_per_profile, next = snapshots.at(-1)!;
    for (let i = 0; i < revision; i++) expect(store.publish(snapshots[i]!, i).state).toBe("written");
    const before = state.storage.sql.exec("SELECT * FROM catalog_snapshots_v1 ORDER BY rowid").toArray();
    const exec = state.storage.sql.exec.bind(state.storage.sql); let written = 0;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query, ...args) => { const cursor = exec(query, ...args); written += cursor.rowsWritten; return cursor; });
    try { expect(store.publish(next, revision - 1)).toEqual({ state: "conflict", current_revision: revision }); expect(written).toBe(0); }
    finally { spy.mockRestore(); }
    state.storage.sql.exec("CREATE TRIGGER reject_pruned_head BEFORE UPDATE ON catalog_heads_v1 BEGIN SELECT RAISE(ABORT,'synthetic catalog fault'); END");
    expect(() => store.publish(next, revision)).toThrow();
    expect(state.storage.sql.exec("SELECT * FROM catalog_snapshots_v1 ORDER BY rowid").toArray()).toEqual(before);
    expect(store.readHead("docs")?.revision).toBe(revision);
    state.storage.sql.exec("DROP TRIGGER reject_pruned_head");
    expect(store.publish(next, revision).state).toBe("written");
  });
});

it("W04 global snapshot pressure preserves current references across all profiles", async () => {
  const snapshots = [];
  for (let profile = 0; profile < CATALOG_LIMITS.snapshots / CATALOG_LIMITS.versions_per_profile; profile++) {
    const versions = [];
    for (let version = 0; version < CATALOG_LIMITS.versions_per_profile; version++) versions.push(await catalogSnapshot(`profile-${profile}`, [catalogDefinition("search", `Version ${version}`)]));
    snapshots.push(versions);
  }
  const incoming = await catalogSnapshot("new-profile");
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage);
    for (const versions of snapshots) {
      expect(store.publish(versions[0]!, 0).state).toBe("written");
      for (let i = 1; i < versions.length; i++) expect(store.stage(versions[i]!, i).state).toBe("written");
    }
    expect(store.publish(incoming, 0).state).toBe("written");
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM catalog_snapshots_v1").one().n).toBe(CATALOG_LIMITS.snapshots);
    for (const versions of snapshots) {
      const first = versions[0]!, latest = versions.at(-1)!;
      expect(store.readSnapshot(first.profile_id, first.digest)).toEqual(first);
      expect(store.readSnapshot(latest.profile_id, latest.digest)).toEqual(latest);
    }
    expect(store.readSnapshot("profile-0", snapshots[0]![1]!.digest)).toBeUndefined();
    expect(store.readSnapshot("profile-1", snapshots[1]![1]!.digest)).toEqual(snapshots[1]![1]);
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
  const first = await catalogSnapshot(), history = await catalogSnapshot("docs", [catalogDefinition("search", "history")]),
    observed = await catalogSnapshot("docs", [catalogDefinition("search", "observed")]), next = await catalogSnapshot("docs", [catalogDefinition("search", "new")]);
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage); store.publish(first, 0); store.stage(history, 1); store.stage(observed, 2);
    // The synthetic second row exercises the accounting limit without allocating
    // a large body. It is never selected, read, approved or presented as a snapshot.
    state.storage.sql.exec("INSERT INTO catalog_snapshots_v1 VALUES (?,?,?,?)", "budget-fixture", "b".repeat(64), CATALOG_LIMITS.storage_bytes, "{}");
    const exec = state.storage.sql.exec.bind(state.storage.sql); let written = 0;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query, ...args) => { const cursor = exec(query, ...args); written += cursor.rowsWritten; return cursor; });
    try { expect(store.stage(next, 3)).toEqual({ state: "capacity" }); expect(written).toBe(0); }
    finally { spy.mockRestore(); }
    expect(store.readHead("docs")?.revision).toBe(3);
    expect(store.readSnapshot("docs", history.digest)).toEqual(history);
    expect(store.disable("docs", 3).state).toBe("written");
    expect(store.readSnapshot("docs", first.digest)).toEqual(first);
  });
});

it("W04 byte pressure reclaims unreferenced history while keeping active snapshots on other profiles", async () => {
  const first = await catalogSnapshot(), history = await catalogSnapshot("docs", [catalogDefinition("search", "history ".repeat(700))]),
    observed = await catalogSnapshot("docs", [catalogDefinition("search", "observed")]), other = await catalogSnapshot("other"), incoming = await catalogSnapshot("incoming");
  await runInDurableObject(owner(), (_instance, state) => {
    const store = repository(state.storage); store.publish(first, 0); store.stage(history, 1); store.stage(observed, 2); store.publish(other, 0);
    const used = state.storage.sql.exec<{ bytes: number }>("SELECT SUM(bytes) AS bytes FROM catalog_snapshots_v1").one().bytes;
    // Account for occupied capacity without allocating a 16 MiB test body. This
    // orphan is never read as content or selected as reclaimable history.
    state.storage.sql.exec("INSERT INTO catalog_snapshots_v1 VALUES (?,?,?,?)", "budget-fixture", "b".repeat(64), CATALOG_LIMITS.storage_bytes - used, "{}");
    expect(store.publish(incoming, 0).state).toBe("written");
    expect(store.readSnapshot("docs", history.digest)).toBeUndefined();
    for (const protectedSnapshot of [first, observed, other, incoming]) expect(store.readSnapshot(protectedSnapshot.profile_id, protectedSnapshot.digest)).toEqual(protectedSnapshot);
    expect(store.readHead("docs")?.revision).toBe(3);
    expect(state.storage.sql.exec<{ bytes: number }>("SELECT SUM(bytes) AS bytes FROM catalog_snapshots_v1").one().bytes).toBeLessThanOrEqual(CATALOG_LIMITS.storage_bytes);
  });
});

it("W04 cursor MACs bind the owner and reject tampering without a shared credential", async () => {
  const key = newCatalogCursorKey(), codec = createCatalogCursor("owner-a", () => key), other = createCatalogCursor("owner-b", () => key);
  const value: CatalogCursor = { schema_version: 2, client_id: "client-test", secret_version: 1, profile_id: "docs", profile_revision: 2,
    catalog_revision: 4, offset: 1, limit: 1, expires_at_ms: Date.now() + 1000 };
  await expect(codec.seal({ ...value, schema_version: 1 } as unknown as CatalogCursor)).rejects.toThrow("catalog_cursor_invalid");
  const cursor = await codec.seal(value);
  expect(await codec.open(cursor)).toEqual(value);
  expect(await other.open(cursor)).toBeUndefined();
  const tampered = (cursor[0] === "A" ? "B" : "A") + cursor.slice(1);
  expect(await codec.open(tampered)).toBeUndefined();
  expect(await codec.open("a".repeat(CATALOG_LIMITS.cursor_bytes + 1))).toBeUndefined();
});
