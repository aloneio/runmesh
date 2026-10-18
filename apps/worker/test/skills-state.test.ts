import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { SkillState } from "../src/platform/skills/store.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { makeSkillBundle } from "../src/domain/skills/bundle.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { createSkillAdministration } from "../src/application/skills/admin.js";
import { createSkillReader } from "../src/application/skills/reader.js";
import { readSkillCapacity } from "../src/platform/skills/capacity.js";
import { deleteSkillContent } from "../src/platform/skills/content.js";
import { SKILL_SQL_CHUNK_BYTES } from "../src/platform/skills/text-chunks.js";
import type { CapabilityTarget } from "../src/contracts/capabilities.js";
import { SKILL_LIMITS, SKILL_STORED_BUNDLE_BYTES, type SkillBundle, type SkillReadPorts } from "../src/contracts/skills.js";

const owner = () => (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES.get((env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES.idFromName(crypto.randomUUID()));
const principal = { client_id: "client-skills", secret_version: 1 };
const bundle = (text = "first") => makeSkillBundle({ skill_id: "research", source: "reviewed", license: "MIT", files: [
  { path: "SKILL.md", text: ['---', 'name: research', 'description: Read documentation', '---', text].join(String.fromCharCode(10)) },
  { path: "references/check.md", text } ] }, catalogSha256);
it("Skill dependencies report shared publication status and never hide revoked reads", async () => {
  const target: CapabilityTarget = { kind: 'remote_tool', resource_id: 'search', version: 'a'.repeat(64), connection_profile_id: 'docs' };
  const base = (await bundle())!, a = (await makeSkillBundle({ ...base, files: [...base.files,
    { path: 'runmesh.json', text: JSON.stringify({ schema_version: 1, requiredCapabilities: [target] }) }] }, catalogSha256))!;
  await runInDurableObject(owner(), async (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
    store.stage(a, 0); store.activate(a.skill_id, a.digest, 1);
    let probes = 0, revokeDuringRead = false, revoked = false;
    const service = createSkillReader({ repository: store, digest: catalogSha256,
      identity: async p => revoked ? { state: 'denied' } : ({ state: 'allowed', identity: { schema_version: 2, ...p, label: 'fixture', native_scopes: [] } }),
      remoteDependency: async () => { probes++; if (revokeDuringRead) revoked = true; return 'not_configured'; } });
    const query = { skill_id: a.skill_id, digest: a.digest, path: 'SKILL.md' }, signal = new AbortController().signal;
    expect(await service.read(principal, query, signal)).toMatchObject({ state: 'read', dependencies: [{ target, state: 'not_configured' }] });
    expect(probes).toBe(1); revokeDuringRead = true;
    expect(await service.read(principal, query, signal)).toEqual({ state: 'denied' });
  });
});
it("Skill repository is lazy and preserves approved old bodies across updates, rollback and disable", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='skill_meta'").toArray()).toEqual([]);
    expect(store.stage(a, 0)).toMatchObject({ state: "written", head: { revision: 1, enabled: false } });
    expect(store.approved(a.skill_id, a.digest)).toBe(false);
    expect(store.activate(a.skill_id, a.digest, 1)).toMatchObject({ state: "written", head: { revision: 2, enabled: true } });
    expect(store.stage(b, 2)).toMatchObject({ state: "written", head: { active_digest: a.digest, revision: 3 } });
    expect(store.activate(b.skill_id, b.digest, 3)).toMatchObject({ state: "written" });
    expect(store.bundle(a.skill_id, a.digest)).toEqual(a); expect(store.approved(a.skill_id, a.digest)).toBe(true);
    expect(store.disable(a.skill_id, 4)).toMatchObject({ state: "written", head: { enabled: false, revision: 5 } });
    expect(store.activate(a.skill_id, a.digest, 5)).toMatchObject({ state: "written", head: { active_digest: a.digest, revision: 6 } });
    expect(store.stage(b, 2)).toEqual({ state: "conflict", current_revision: 6 });
    expect(store.bundle(b.skill_id, b.digest)).toEqual(b);
    expect(readSkillCapacity(state.storage.sql, a.skill_id)).toMatchObject({ skill_versions: 2, library_skills: 1 });
  });
});
it("Skill display aliases and deletion tombstones preserve revision checks and prevent resurrection", async () => {
  const value = (await bundle())!;
  await runInDurableObject(owner(), (_instance, state) => {
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    expect(store.install(value, 0)).toMatchObject({ state: "written", head: { revision: 1 } });
    expect(store.rename(value.skill_id, "Research notes", 1))
      .toMatchObject({ state: "written", head: { revision: 2, display_name: "Research notes" } });
    expect(store.remove(value.skill_id, 1)).toEqual({ state: "conflict", current_revision: 2 });
    expect(store.remove(value.skill_id, 2)).toEqual({ state: "deleted", skill_id: value.skill_id });
    expect(store.head(value.skill_id)).toBeUndefined();
    expect(store.heads("", 10)).toEqual([]);
    expect(store.stage(value, 0)).toEqual({ state: "invalid" });
    expect(store.bundle(value.skill_id, value.digest)).toBeUndefined();
  });
});
it("Skill head pages use one bounded read and preserve ordering, cursors and enabled state", async () => {
  const values = await Promise.all(Array.from({ length: 7 }, (_, index) => makeSkillBundle({
    skill_id: `skill-${String(index).padStart(2, "0")}`, source: "reviewed", license: "MIT", files: [
      { path: "SKILL.md", text: `---\nname: skill-${String(index).padStart(2, "0")}\ndescription: Read documentation\n---\nInstructions` },
    ],
  }, catalogSha256)));
  await runInDurableObject(owner(), (_instance, state) => {
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    for (const [index, value] of values.entries()) {
      expect(value).toBeDefined();
      expect(index % 2 === 0 ? store.install(value!, 0) : store.stage(value!, 0)).toMatchObject({ state: "written" });
    }
    const expected = values.map(value => store.head(value!.skill_id)!);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const measurements: Array<{ after: string; limit: number; queries: number; read: number; written: number }> = [];
    for (const [after, limit] of [["", 3], ["skill-02", 2], ["skill-06", 3], ["skill-01", 0]] as const) {
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const exec = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
        const cursor = original(query, ...args); cursors.push(cursor); return cursor;
      });
      try {
        const page = store.heads(after, limit);
        expect(page).toEqual(expected.filter(head => head.skill_id > after).slice(0, limit));
        measurements.push({ after, limit, queries: cursors.length,
          read: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
          written: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) });
      } finally { exec.mockRestore(); }
    }
    console.info("skill-head-page-sql", JSON.stringify(measurements));
    for (const measurement of measurements) {
      expect(measurement.read).toBeLessThanOrEqual(Math.max(1, measurement.limit));
      expect(measurement.queries).toBe(1);
      expect(measurement.written).toBe(0);
    }
  });
});
it.each([["enabled", 2], ["enabled", -1], ["revision", 0], ["revision", 1.5]] as const)(
  "Skill single and paged heads reject invalid %s=%s", async (column, value) => {
    const item = (await bundle())!;
    await runInDurableObject(owner(), (_instance, state) => {
      const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
      expect(store.install(item, 0)).toMatchObject({ state: "written" });
      state.storage.sql.exec(`UPDATE skill_heads_v1 SET ${column}=? WHERE skill_id=?`, value, item.skill_id);
      expect(() => store.head(item.skill_id)).toThrow("skill_record_invalid");
      expect(() => store.heads("", 1)).toThrow("skill_record_invalid");
      expect(store.heads(item.skill_id, 1)).toEqual([]);
    });
  },
);
it.each(["install", "activate"] as const)("Skill %s advances publication without rewriting an already approved version", async action => {
  const value = (await bundle())!;
  await runInDurableObject(owner(), (_instance, state) => {
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    expect(store.install(value, 0)).toMatchObject({ state: "written" });
    const metadata = state.storage.sql.exec("SELECT * FROM skill_version_metadata_v1").toArray();
    const capacity = readSkillCapacity(state.storage.sql, value.skill_id);
    const original = state.storage.sql.exec.bind(state.storage.sql); let written = 0;
    const exec = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); written += cursor.rowsWritten; return cursor;
    });
    try {
      const result = action === "install" ? store.install(value, 1) : store.activate(value.skill_id, value.digest, 1);
      expect(result).toMatchObject({ state: "written", head: { revision: 2, active_digest: value.digest, enabled: true } });
      expect(written).toBe(1);
      written = 0;
      expect(action === "install" ? store.install(value, 1) : store.activate(value.skill_id, value.digest, 1))
        .toEqual({ state: "conflict", current_revision: 2 });
      expect(written).toBe(0);
      expect(store.approved(value.skill_id, value.digest)).toBe(true);
      expect(state.storage.sql.exec("SELECT * FROM skill_version_metadata_v1").toArray()).toEqual(metadata);
      expect(readSkillCapacity(state.storage.sql, value.skill_id)).toEqual(capacity);
    } finally { exec.mockRestore(); }
  });
});
it("accepted Skill metadata remains readable after JSON escaping and storage recreation", async () => {
  const dependencies: CapabilityTarget[] = Array.from({ length: SKILL_LIMITS.dependencies }, (_, index) => ({
    kind: "remote_tool", resource_id: String(index) + "r".repeat(127), version: "a".repeat(64), connection_profile_id: "p".repeat(128),
  }));
  const value = await makeSkillBundle({ skill_id: "long-metadata", source: 's' + '"'.repeat(2047), license: '"'.repeat(256), files: [
    { path: "SKILL.md", text: "---\nname: long-metadata\ndescription: A " + '"'.repeat(1022) + "\n---\nInstructions" },
    { path: "runmesh.json", text: JSON.stringify({ schema_version: 1, requiredCapabilities: dependencies }) },
  ] }, catalogSha256);
  expect(value).toBeDefined();
  const { files: _files, schema_version: _schema, ...summary } = value!;
  expect(JSON.stringify(summary).length).toBeGreaterThan(8192);
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(SKILL_STORED_BUNDLE_BYTES);
  await runInDurableObject(owner(), async (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
    expect(store.install(value!, 0)).toMatchObject({ state: "written", head: { enabled: true } });
    const reopened = new SkillState(state.storage, () => schema.initialize());
    expect(reopened.bundle(value!.skill_id, value!.digest)).toEqual(value);
    expect(reopened.summary(value!.skill_id, value!.digest)).toEqual(summary);
    const administration = createSkillAdministration({ repository: reopened, digest: catalogSha256, admin: async () => "allowed" });
    const reader = createSkillReader({ repository: reopened, digest: catalogSha256,
      identity: async p => ({ state: "allowed", identity: { schema_version: 2, ...p, label: "fixture", native_scopes: [] } }) });
    const signal = new AbortController().signal;
    expect(await administration.library("session", undefined, signal)).toMatchObject({ state: "listed", skills: [{ summary }] });
    expect(await reader.list(principal, {}, signal)).toMatchObject({ state: "listed", skills: [{ ...summary, revision: 1 }] });
  });
});
it("Skill stage rolls back content if head publication fails and rejects unknown schema versions", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize()); store.stage(a, 0);
    const capacity = readSkillCapacity(state.storage.sql, a.skill_id);
    state.storage.sql.exec("CREATE TRIGGER reject_skill_head BEFORE UPDATE ON skill_heads_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(() => store.stage(b, 1)).toThrow(); expect(store.bundle(b.skill_id, b.digest)).toBeUndefined();
    expect(readSkillCapacity(state.storage.sql, a.skill_id)).toEqual(capacity);
    state.storage.sql.exec("UPDATE skill_meta SET schema_version=99");
    expect(() => new SkillState(state.storage, () => schema.initialize()).head(a.skill_id)).toThrow("skill_schema_unsupported");
    expect(store.bundle(a.skill_id, a.digest)).toEqual(a);
  });
});
it("large Skill folders survive storage recreation and roll back every file on publication failure", async () => {
  const base = (await bundle())!;
  const large = (await makeSkillBundle({ ...base, files: [base.files[0]!, ...Array.from({ length: 255 }, (_, n) => ({
    path: 'references/' + String(n).padStart(3, '0') + '.txt', text: n < 3 ? (n === 0 ? '"' : 'x').repeat(1_048_576) : 'reference'
  }))] }, catalogSha256))!;
  expect(large).toBeDefined();
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
    expect(store.install(large, 0)).toMatchObject({ state: 'written', head: { enabled: true } });
    const reopened = new SkillState(state.storage, () => schema.initialize());
    expect(reopened.bundle(large.skill_id, large.digest)).toEqual(large);
    expect(reopened.approved(large.skill_id, large.digest)).toBe(true);
    state.storage.sql.exec("CREATE TRIGGER reject_skill_head BEFORE UPDATE ON skill_heads_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(() => reopened.stage(base, 1)).toThrow();
    expect(reopened.bundle(base.skill_id, base.digest)).toBeUndefined();
    expect(state.storage.sql.exec("SELECT * FROM skill_files_v2 WHERE digest=?", base.digest).toArray()).toEqual([]);
    expect(reopened.head(base.skill_id)?.active_digest).toBe(large.digest);
  });
});
function seedLegacy(storage: DurableObjectStorage, bundles: readonly SkillBundle[]): void {
  new CentralSchema(storage).initialize();
  storage.sql.exec("CREATE TABLE skill_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL)");
  storage.sql.exec("INSERT INTO skill_meta VALUES (1,1)");
  storage.sql.exec("CREATE TABLE skill_heads_v1 (skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, staged_digest TEXT NOT NULL, active_digest TEXT, enabled INTEGER NOT NULL)");
  storage.sql.exec("CREATE TABLE skill_bundles_v1 (skill_id TEXT NOT NULL, digest TEXT NOT NULL, summary_json TEXT NOT NULL, content_json TEXT NOT NULL, bytes INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(skill_id,digest))");
  for (const [index, item] of bundles.entries()) {
    const { files: _files, schema_version: _schema, ...summary } = item, content = JSON.stringify(item);
    storage.sql.exec("INSERT INTO skill_bundles_v1 VALUES (?,?,?,?,?,?)", item.skill_id, item.digest, JSON.stringify(summary), content, new TextEncoder().encode(content).byteLength, index === 0 ? 1 : 0);
  }
  storage.sql.exec("INSERT INTO skill_heads_v1 VALUES (?,?,?,?,?)", bundles[0]!.skill_id, 3, bundles.at(-1)!.digest, bundles[0]!.digest, 0);
}
it("Skill schema upgrades preserve files, digests, approval, revisions and paused state", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    seedLegacy(state.storage, [a, b]);
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    expect(store.head(a.skill_id)).toEqual({ skill_id: a.skill_id, revision: 3, staged_digest: b.digest, active_digest: a.digest, enabled: false });
    for (const item of [a, b]) expect(store.bundle(item.skill_id, item.digest)).toEqual(item);
    expect(store.approved(a.skill_id, a.digest)).toBe(true);
    expect(store.approved(b.skill_id, b.digest)).toBe(false);
    expect(readSkillCapacity(state.storage.sql, a.skill_id)).toMatchObject({ skill_versions: 2, library_skills: 1,
      library_bytes: new TextEncoder().encode(JSON.stringify(a) + JSON.stringify(b)).byteLength });
    expect(state.storage.sql.exec("SELECT schema_version FROM skill_meta").toArray()).toEqual([{ schema_version: 2 }]);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='skill_bundles_v1'").toArray()).toEqual([]);
    expect(store.install(b, 3)).toMatchObject({ state: 'written', head: { revision: 4, enabled: true } });
    expect(new SkillState(state.storage, () => undefined).bundle(b.skill_id, b.digest)).toEqual(b);
  });
});

it.each(["normal completion", "midway write failure"] as const)("streaming Skill migration preserves content and capacity after %s", async scenario => {
  const values = (await Promise.all(Array.from({ length: 24 }, (_, index) => bundle(`Version ${index}\n${"reference ".repeat(4096)}`)))) as SkillBundle[];
  await runInDurableObject(owner(), (_instance, state) => {
    seedLegacy(state.storage, values);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    let fetched = 0, inserted = 0, interrupt = scenario === "midway write failure";
    const exec = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith("INSERT INTO skill_bundles_v2")) {
        expect(fetched - inserted).toBe(1);
        if (interrupt && inserted === 12) throw new Error("synthetic migration write failure");
        const cursor = original(query, ...args); inserted++; return cursor;
      }
      const cursor = original(query, ...args);
      if (!query.includes("content_json,bytes,approved FROM skill_bundles_v1")) return cursor;
      return new Proxy(cursor, { get(target, key) {
        if (key === "toArray") return () => {
          const rows = target.toArray();
          // Each bounded body reaches the new tables before another is read.
          expect(rows.length).toBeLessThanOrEqual(1);
          expect(fetched).toBe(inserted); fetched += rows.length;
          return rows;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    try {
      if (interrupt) {
        expect(() => store.head(values[0]!.skill_id)).toThrow("synthetic migration write failure");
        expect(inserted).toBe(12);
        expect(original("SELECT schema_version FROM skill_meta").toArray()).toEqual([{ schema_version: 1 }]);
        expect(original("SELECT name FROM sqlite_master WHERE name IN ('skill_bundles_v2','skill_files_v2','skill_capacity_v1','skill_library_capacity_v1')").toArray()).toEqual([]);
        expect(original("SELECT COUNT(*) AS n FROM skill_bundles_v1").one().n).toBe(values.length);
        interrupt = false; fetched = 0; inserted = 0;
      }
      expect(store.head(values[0]!.skill_id)).toMatchObject({ revision: 3, enabled: false,
        staged_digest: values.at(-1)!.digest, active_digest: values[0]!.digest });
      expect(fetched).toBe(values.length); expect(inserted).toBe(values.length);
    } finally { exec.mockRestore(); }
    const reopened = new SkillState(state.storage, () => undefined);
    for (const [index, value] of values.entries()) {
      expect(reopened.bundle(value.skill_id, value.digest)).toEqual(value);
      expect(reopened.approved(value.skill_id, value.digest)).toBe(index === 0);
    }
    const bytes = values.reduce((total, value) => total + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0);
    expect(readSkillCapacity(state.storage.sql, values[0]!.skill_id)).toMatchObject({ skill_versions: values.length,
      skill_bytes: bytes, library_bytes: bytes, library_skills: 1 });
    expect(original("SELECT name FROM sqlite_master WHERE name='skill_bundles_v1'").toArray()).toEqual([]);
  });
});

it("existing schema-2 content receives one atomic capacity backfill and reconstruction never recounts it", async () => {
  const first = (await bundle())!, second = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    const create = () => new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    const store = create(); store.install(first, 0); store.install(second, 1);
    const expected = readSkillCapacity(state.storage.sql, first.skill_id);
    state.storage.sql.exec("DROP TABLE skill_capacity_v1");
    state.storage.sql.exec("DROP TABLE skill_library_capacity_v1");
    const restored = create(); expect(restored.head(first.skill_id)?.revision).toBe(2);
    expect(readSkillCapacity(state.storage.sql, first.skill_id)).toEqual(expected);
    // A migrated projection is authoritative; it is not silently rebuilt on every open.
    state.storage.sql.exec("UPDATE skill_library_capacity_v1 SET bytes=-1 WHERE id=1");
    expect(create().head(first.skill_id)?.revision).toBe(2);
    expect(() => readSkillCapacity(state.storage.sql, first.skill_id)).toThrow('skill_capacity_record_invalid');
  });
});

it("a failed capacity backfill rolls back both projections and retries without duplicating content", async () => {
  const first = (await bundle())!;
  await runInDurableObject(owner(), (_instance, state) => {
    const create = () => new SkillState(state.storage, () => undefined), store = create(); store.install(first, 0);
    const expected = readSkillCapacity(state.storage.sql, first.skill_id);
    state.storage.sql.exec("DROP TABLE skill_capacity_v1"); state.storage.sql.exec("DROP TABLE skill_library_capacity_v1");
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, 'exec').mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith('INSERT INTO skill_library_capacity_v1')) throw new Error('synthetic projection failure');
      return original(query, ...args);
    });
    const restored = create();
    try { expect(() => restored.head(first.skill_id)).toThrow('synthetic projection failure'); }
    finally { spy.mockRestore(); }
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('skill_capacity_v1','skill_library_capacity_v1')").toArray()).toEqual([]);
    expect(restored.bundle(first.skill_id, first.digest)).toEqual(first);
    expect(readSkillCapacity(state.storage.sql, first.skill_id)).toEqual(expected);
  });
});
it("failed Skill schema upgrades roll back all new tables and can retry", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    seedLegacy(state.storage, [a, b]);
    state.storage.sql.exec("UPDATE skill_bundles_v1 SET content_json='invalid' WHERE digest=?", b.digest);
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    expect(() => store.head(a.skill_id)).toThrow();
    expect(state.storage.sql.exec("SELECT schema_version FROM skill_meta").toArray()).toEqual([{ schema_version: 1 }]);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('skill_bundles_v2','skill_files_v2')").toArray()).toEqual([]);
    state.storage.sql.exec("UPDATE skill_bundles_v1 SET content_json=? WHERE digest=?", JSON.stringify(b), b.digest);
    expect(store.bundle(a.skill_id, a.digest)).toEqual(a);
    expect(store.bundle(b.skill_id, b.digest)).toEqual(b);
  });
});
it("Skill storage rejects incomplete file sets after recreation", async () => {
  const a = (await bundle())!;
  await runInDurableObject(owner(), (_instance, state) => {
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    store.install(a, 0);
    state.storage.sql.exec("DELETE FROM skill_files_v2 WHERE position=1");
    expect(() => new SkillState(state.storage, () => undefined).bundle(a.skill_id, a.digest)).toThrow('skill_record_invalid');
  });
});
it("Skill reads follow active publications, do not load bodies during listing, and reject revoked or mismatched clients", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), async (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
    store.stage(a, 0); store.activate(a.skill_id, a.digest, 1); store.stage(b, 2); store.activate(b.skill_id, b.digest, 3);
    let revoked = false, onIdentity = () => undefined;
    const ports: SkillReadPorts = { repository: store, digest: catalogSha256,
      identity: async p => { onIdentity(); return revoked ? { state: 'denied' } : { state: 'allowed', identity: { schema_version: 2, ...p, label: 'test', native_scopes: [] } }; } };
    const service = createSkillReader(ports), signal = new AbortController().signal;
    const original = store.bundle.bind(store); store.bundle = () => { throw new Error('list must not read bodies'); };
    expect(await service.list(principal, {}, signal)).toMatchObject({ state: 'listed', skills: [{ digest: b.digest }] });
    store.bundle = original;
    expect(await service.read(principal, { skill_id: a.skill_id, digest: a.digest, path: 'references/check.md' }, signal)).toMatchObject({ state: 'denied' });
    expect(await service.read(principal, { skill_id: b.skill_id, digest: b.digest, path: 'SKILL.md' }, signal)).toMatchObject({ state: 'read' });
    expect(await service.list({ ...principal, client_id: 'other' }, {}, signal)).toMatchObject({ state: 'listed', skills: [{ digest: b.digest }] });
    expect(await service.list(principal, { cursor: 'another-client' }, signal)).toEqual({ state: 'invalid' });
    let reads = 0; onIdentity = () => { if (++reads === 2) revoked = true; };
    expect(await service.read(principal, { skill_id: a.skill_id, digest: b.digest, path: 'SKILL.md' }, signal)).toEqual({ state: 'denied' });
    revoked = true; expect(await service.list(principal, {}, signal)).toEqual({ state: 'denied' });
  });
});

it("Skill capacity shares zero-safe metadata totals with installation admission", async () => {
  const first = (await bundle())!, second = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize());
    expect(store.head(first.skill_id)).toBeUndefined();
    expect(readSkillCapacity(state.storage.sql, first.skill_id)).toMatchObject({ skill_bytes: 0, skill_versions: 0,
      library_bytes: 0, library_skills: 0, max_versions: SKILL_LIMITS.versions, max_library_bytes: SKILL_LIMITS.storage_bytes });
    expect(store.install(first, 0).state).toBe('written');
    const storedBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
    expect(readSkillCapacity(state.storage.sql, first.skill_id)).toMatchObject({ skill_bytes: storedBytes, skill_versions: 1,
      library_bytes: storedBytes, library_skills: 1 });
    expect(readSkillCapacity(state.storage.sql, 'another-skill')).toMatchObject({ skill_bytes: 0, skill_versions: 0,
      library_bytes: storedBytes, library_skills: 1 });
    // Capacity corruption is rejected before the installation can publish a new head or content.
    state.storage.sql.exec("UPDATE skill_capacity_v1 SET bytes=-1 WHERE skill_id=?", first.skill_id);
    expect(() => store.install(second, 1)).toThrow('skill_capacity_record_invalid');
    expect(store.head(first.skill_id)?.active_digest).toBe(first.digest);
    expect(store.bundle(second.skill_id, second.digest)).toBeUndefined();
  });
});


it("oversized UTF-8 Skill files roundtrip through bounded SQLite chunks, detect corruption, and clean up", async () => {
  // No single SQLite TEXT column may exceed Cloudflare's 2 MB row limit.
  const text = "中😀".repeat(500_000);
  expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(2_000_000);
  const value = (await makeSkillBundle({ skill_id: "chunked", source: "verified", license: "MIT", files: [
    { path: "SKILL.md", text: "---\nname: chunked\ndescription: Large references\n---\nRead references/large.md" },
    { path: "references/large.md", text },
    { path: "references/empty.md", text: "" },
  ] }, catalogSha256))!;
  expect(value).toBeDefined();
  await runInDurableObject(owner(), (_instance, state) => {
    const store = new SkillState(state.storage, () => new CentralSchema(state.storage).initialize());
    expect(store.install(value, 0)).toMatchObject({ state: "written", head: { active_digest: value.digest } });
    const files = state.storage.sql.exec<{ position: number; content_text: string }>(
      "SELECT position,content_text FROM skill_files_v2 WHERE skill_id=? AND digest=? ORDER BY position", value.skill_id, value.digest).toArray();
    expect(files).toHaveLength(3);
    expect(files[1]!.content_text).toBe("");
    expect(files[2]!.content_text).toBe("");
    const chunks = state.storage.sql.exec<{ position: number; ordinal: number; bytes: number }>(
      "SELECT position,ordinal,length(CAST(content_text AS BLOB)) AS bytes FROM skill_file_chunks_v1 WHERE skill_id=? AND digest=? ORDER BY position,ordinal",
      value.skill_id, value.digest).toArray();
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every(chunk => chunk.position === 2 && chunk.bytes > 0 && chunk.bytes <= SKILL_SQL_CHUNK_BYTES)).toBe(true);
    expect(chunks.map(chunk => chunk.ordinal)).toEqual(chunks.map((_part, i) => i));
    expect(new SkillState(state.storage, () => undefined).bundle(value.skill_id, value.digest)).toEqual(value);
    const capacity = readSkillCapacity(state.storage.sql, value.skill_id);
    expect(capacity.library_bytes).toBe(new TextEncoder().encode(JSON.stringify(value)).byteLength);

    state.storage.sql.exec("UPDATE skill_file_chunks_v1 SET ordinal=99 WHERE skill_id=? AND digest=? AND position=2 AND ordinal=0", value.skill_id, value.digest);
    expect(() => store.bundle(value.skill_id, value.digest)).toThrow("skill_record_invalid");
    state.storage.sql.exec("UPDATE skill_file_chunks_v1 SET ordinal=0 WHERE skill_id=? AND digest=? AND position=2 AND ordinal=99", value.skill_id, value.digest);
    expect(store.bundle(value.skill_id, value.digest)).toEqual(value);

    state.storage.transactionSync(() => deleteSkillContent(state.storage.sql, value.skill_id, value.digest));
    expect(store.bundle(value.skill_id, value.digest)).toBeUndefined();
    expect(state.storage.sql.exec("SELECT * FROM skill_file_chunks_v1 WHERE skill_id=? AND digest=?", value.skill_id, value.digest).toArray()).toEqual([]);
    expect(readSkillCapacity(state.storage.sql, value.skill_id)).toMatchObject({ library_bytes: 0, skill_versions: 0 });
  });
});

it("large Skill file admission is bounded at 4 MiB without relying on SQLite row limits", async () => {
  const large = "a".repeat(SKILL_LIMITS.file_bytes);
  const make = (content: string) => makeSkillBundle({ skill_id: "edge", source: "", license: "", files: [
    { path: "SKILL.md", text: "---\nname: edge\ndescription: Edge test\n---\n" },
    { path: "reference.md", text: content },
  ] }, catalogSha256);
  expect(await make(large)).toBeDefined();
  expect(await make(large + "x")).toBeUndefined();
});
