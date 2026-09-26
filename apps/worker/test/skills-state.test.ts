import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { SkillState } from "../src/platform/skills/store.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { makeSkillBundle } from "../src/domain/skills/bundle.js";
import { catalogSha256 } from "../src/platform/capabilities/catalog-crypto.js";
import { createSkillService } from "../src/application/skills/service.js";
import type { CapabilityTarget } from "../src/contracts/capabilities.js";
import type { SkillPorts } from "../src/contracts/skills.js";

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
it("Skill stage rolls back content if head publication fails and rejects unknown schema versions", async () => {
  const a = (await bundle())!, b = (await bundle('second'))!;
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), store = new SkillState(state.storage, () => schema.initialize()); store.stage(a, 0);
    state.storage.sql.exec("CREATE TRIGGER reject_skill_head BEFORE UPDATE ON skill_heads_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(() => store.stage(b, 1)).toThrow(); expect(store.bundle(b.skill_id, b.digest)).toBeUndefined();
    state.storage.sql.exec("UPDATE skill_meta SET schema_version=2");
    expect(() => new SkillState(state.storage, () => schema.initialize()).head(a.skill_id)).toThrow("skill_schema_unsupported");
    expect(store.bundle(a.skill_id, a.digest)).toEqual(a);
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
