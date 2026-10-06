import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { SkillState } from "../src/platform/skills/store.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { makeSkillBundle } from "../src/domain/skills/bundle.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { createSkillService } from "../src/application/skills/service.js";
import type { CapabilityTarget } from "../src/contracts/capabilities.js";
import { SKILL_LIMITS, SKILL_STORED_BUNDLE_BYTES, type SkillBundle, type SkillPorts } from "../src/contracts/skills.js";

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
    const service = createSkillService({ repository: store, digest: catalogSha256, admin: async () => 'allowed',
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
    const service = createSkillService({ repository: reopened, digest: catalogSha256, admin: async () => "allowed",
      identity: async p => ({ state: "allowed", identity: { schema_version: 2, ...p, label: "fixture", native_scopes: [] } }) });
    const signal = new AbortController().signal;
    expect(await service.library("session", undefined, signal)).toMatchObject({ state: "listed", skills: [{ summary }] });
    expect(await service.list(principal, {}, signal)).toMatchObject({ state: "listed", skills: [{ ...summary, revision: 1 }] });
  });
});
it("Skill stage rolls back content if head publication fails and rejects unknown schema versions", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize()); store.stage(a, 0);
    state.storage.sql.exec("CREATE TRIGGER reject_skill_head BEFORE UPDATE ON skill_heads_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(() => store.stage(b, 1)).toThrow(); expect(store.bundle(b.skill_id, b.digest)).toBeUndefined();
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
    expect(state.storage.sql.exec("SELECT schema_version FROM skill_meta").toArray()).toEqual([{ schema_version: 2 }]);
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='skill_bundles_v1'").toArray()).toEqual([]);
    expect(store.install(b, 3)).toMatchObject({ state: 'written', head: { revision: 4, enabled: true } });
    expect(new SkillState(state.storage, () => undefined).bundle(b.skill_id, b.digest)).toEqual(b);
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
    const ports: SkillPorts = { repository: store, digest: catalogSha256, admin: async () => 'allowed',
      identity: async p => { onIdentity(); return revoked ? { state: 'denied' } : { state: 'allowed', identity: { schema_version: 2, ...p, label: 'test', native_scopes: [] } }; } };
    const service = createSkillService(ports), signal = new AbortController().signal;
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
