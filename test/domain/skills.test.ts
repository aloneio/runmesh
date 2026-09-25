import { expect, it } from "vitest";
import { makeSkillBundle, parseSkillBundle, skillPath } from "../../apps/worker/src/domain/skills/bundle.js";
import { fixtureDigest, catalogProfile, catalogSnapshot } from "./catalog-fixtures.js";
import { createDependencyReader } from "../../apps/worker/src/application/capabilities/dependencies.js";
import type { CatalogHead, CatalogRepository } from "../../apps/worker/src/contracts/catalog.js";
import { SKILL_LIMITS } from "../../apps/worker/src/contracts/skills.js";

const input = () => ({ skill_id: "research", source: "Local reviewed document", license: "MIT",
  files: [{ path: "SKILL.md", text: ['---', 'name: research', 'description: Read documentation safely', 'allowed-tools: shell', '---', 'Read first.'].join(String.fromCharCode(10)) },
    { path: "references/check.md", text: "Verify the result." }] });
it("Skill bundles have deterministic content digests independent of file order", async () => {
  const a = input(), b = input(); b.files.reverse();
  expect(await makeSkillBundle(a, fixtureDigest)).toEqual(await makeSkillBundle(b, fixtureDigest));
  b.files[0]!.text += " Changed";
  expect((await makeSkillBundle(a, fixtureDigest))?.digest).not.toBe((await makeSkillBundle(b, fixtureDigest))?.digest);
});
it.each(["../secret", "/root/key", "references/../key", "a//b", "./SKILL.md", "a/", "a./file", "con.txt", "refs/NUL", "%2e%2e/secret", "C:/key", "refs/key:stream"])("Skill paths reject %s", path => expect(skillPath(path)).toBe(false));
it("Skill import rejects links, ambiguous case collisions and non-text collections", () => {
  const a = input();
  expect(parseSkillBundle({ ...a, files: [...a.files, { path: "skill.md", text: "different" }] })).toBeUndefined();
  expect(parseSkillBundle({ ...a, files: [{ ...a.files[0], symlink: "/etc/passwd" }] })).toBeUndefined();
  expect(parseSkillBundle({ ...a, files: [{ path: "SKILL.md", text: 123 }] })).toBeUndefined();
  expect(skillPath('a' + String.fromCharCode(92) + 'b')).toBe(false);
});
it("Skill import bounds encoded bytes, file counts and metadata", () => {
  const a = input();
  expect(parseSkillBundle({ ...a, files: [...a.files, { path: "huge.txt", text: "中".repeat(SKILL_LIMITS.file_bytes / 2) }] })).toBeUndefined();
  expect(parseSkillBundle({ ...a, files: Array.from({ length: SKILL_LIMITS.files + 1 }, (_, n) => ({ path: 'f' + n, text: '' })) })).toBeUndefined();
  expect(parseSkillBundle({ ...a, license: 'x'.repeat(257) })).toBeUndefined();
});
it("Skill instructions remain content and cannot add executable policy fields", () => {
  const a = input(), bundle = parseSkillBundle({ ...a, allowed_tools: ["shell"], credentials: "secret" });
  expect(bundle).toBeDefined(); expect(bundle).not.toHaveProperty("credentials"); expect(bundle).not.toHaveProperty("allowed_tools");
  expect(bundle?.files.find(f => f.path === "SKILL.md")?.text).toContain("allowed-tools: shell");
});
it("Skill import requires unique bounded scalar frontmatter", () => {
  const a = input();
  for (const body of ['plain body', '---|name: research|name: another|description: test|---|body', '---|name: research|description: >|  text|---|body']) {
    expect(parseSkillBundle({ ...a, files: [{ path: 'SKILL.md', text: body.split('|').join(String.fromCharCode(10)) }] })).toBeUndefined();
  }
});
it("Skill dependency sidecars are bounded immutable metadata, never executable permissions", async () => {
  const a = input(), target = { kind: 'skill', resource_id: 'reference', version: 'a'.repeat(64) };
  const withManifest = (manifest: unknown) => ({ ...a, files: [...a.files, { path: 'runmesh.json', text: JSON.stringify(manifest) }] });
  const manifest = { schema_version: 1, requiredCapabilities: [target] };
  const result = await makeSkillBundle(withManifest(manifest), fixtureDigest);
  expect(result?.required_capabilities).toEqual([target]);
  expect(result?.digest).not.toBe((await makeSkillBundle(a, fixtureDigest))?.digest);
  for (const invalid of [{ ...manifest, schema_version: 2 }, { ...manifest, install: 'shell' },
    { ...manifest, requiredCapabilities: [target, target] }, { ...manifest, requiredCapabilities: Array(SKILL_LIMITS.dependencies + 1).fill(target) },
    { ...manifest, requiredCapabilities: [{ ...target, token: 'secret' }] }, { ...manifest, requiredCapabilities: [{ kind: 'shell' }] }]) {
    expect(parseSkillBundle(withManifest(invalid))).toBeUndefined();
  }
});
it("Skill remote dependencies report stored readiness, disabled state and incompatible versions without connecting", async () => {
  const snapshot = await catalogSnapshot(), tool = snapshot.tools[0]!;
  let profile: ReturnType<typeof catalogProfile> | undefined = catalogProfile();
  let head: CatalogHead = { schema_version: 1, profile_id: 'docs', revision: 1, observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: ['search'] };
  const repository: CatalogRepository = { readHead: () => head, readSnapshot: () => snapshot,
    stage: () => { throw new Error('write forbidden'); }, approve: () => { throw new Error('write forbidden'); }, disable: () => { throw new Error('write forbidden'); } };
  const read = createDependencyReader({ repository, profile: () => profile, digest: fixtureDigest });
  const target = { kind: 'remote_tool' as const, resource_id: tool.tool_id, version: tool.version, connection_profile_id: 'docs' }, signal = new AbortController().signal;
  expect(await read(target, signal)).toBe('configured');
  expect(await read({ ...target, version: 'f'.repeat(64) }, signal)).toBe('incompatible');
  head = { ...head, approved_names: [] }; expect(await read(target, signal)).toBe('incompatible');
  profile = { ...profile!, enabled: false }; expect(await read(target, signal)).toBe('disabled');
  profile = undefined; expect(await read(target, signal)).toBe('not_configured');
  const aborted = new AbortController(); aborted.abort(); expect(await read(target, aborted.signal)).toBe('unavailable');
});
