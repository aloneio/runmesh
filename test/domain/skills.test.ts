import { expect, it, vi } from "vitest";
import { makeSkillBundle, parseSkillBundle, verifySkillBundle } from "../../apps/worker/src/domain/skills/bundle.js";
import { skillPath } from "../../apps/worker/src/contracts/skill-values.js";
import { skillFrontmatter } from "../../apps/worker/src/domain/skills/frontmatter.js";
import { skillFileManifest } from "../../apps/worker/src/domain/skills/manifest.js";
import { fixtureDigest, catalogProfile, catalogSnapshot } from "./catalog-fixtures.js";
import { createDependencyReader } from "../../apps/worker/src/application/capabilities/dependencies.js";
import type { CatalogHead, CatalogSnapshotPorts } from "../../apps/worker/src/contracts/catalog.js";
import { SKILL_LIMITS } from "../../apps/worker/src/contracts/skills.js";
import type { SkillHead, SkillAdminPorts, SkillReadPorts } from "../../apps/worker/src/contracts/skills.js";
import { createSkillAdministration } from "../../apps/worker/src/application/skills/admin.js";
import { createSkillReader } from "../../apps/worker/src/application/skills/reader.js";

const input = () => ({ skill_id: "research", source: "Local reviewed document", license: "MIT",
  files: [{ path: "SKILL.md", text: ['---', 'name: research', 'description: Read documentation safely', 'allowed-tools: shell', '---', 'Read first.'].join(String.fromCharCode(10)) },
    { path: "references/check.md", text: "Verify the result." }] });
it("Skill commands reject coerced actions before authorization or any write", async () => {
  const blocked = () => { throw new Error("invalid commands must not reach storage"); };
  const repository: SkillAdminPorts["repository"] = { heads: blocked, head: blocked, bundle: blocked, summary: blocked,
    install: vi.fn(blocked), stage: vi.fn(blocked), activate: vi.fn(blocked), disable: vi.fn(blocked) };
  const admin = vi.fn(async () => "allowed" as const);
  const service = createSkillAdministration({ repository, digest: fixtureDigest, admin });
  for (const action of [["preview"], ["stage"], ["activate"], ["disable"], [], {}, null, true, 1, "unexpected", undefined]) {
    expect(await service.mutate("session", { ...input(), action, digest: "a".repeat(64), expected_revision: 1 }, new AbortController().signal)).toEqual({ state: "invalid" });
  }
  expect(admin).not.toHaveBeenCalled();
  for (const method of [repository.install, repository.stage, repository.activate, repository.disable]) expect(method).not.toHaveBeenCalled();
});
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
it("Skill imports support 256 files and one MiB UTF-8 files within an eight MiB package", () => {
  const a = input(), files = [a.files[0]!, ...Array.from({ length: 255 }, (_, n) => ({ path: 'references/' + n + '.txt', text: n === 0 ? 'x'.repeat(1_048_576) : 'reference' }))];
  expect(parseSkillBundle({ ...a, files })?.files).toHaveLength(256);
  files[1]!.text += 'x';
  expect(parseSkillBundle({ ...a, files })).toBeUndefined();
  const large = [a.files[0]!, ...Array.from({ length: 8 }, (_, n) => ({ path: 'references/' + n + '.txt', text: 'x'.repeat(1_048_576) }))];
  expect(parseSkillBundle({ ...a, files: large })).toBeUndefined();
  large.pop();
  expect(parseSkillBundle({ ...a, files: large })).toBeDefined();
});
it("Skill instructions remain content and cannot add executable policy fields", () => {
  const a = input(), bundle = parseSkillBundle({ ...a, allowed_tools: ["shell"], credentials: "secret" });
  expect(bundle).toBeDefined(); expect(bundle).not.toHaveProperty("credentials"); expect(bundle).not.toHaveProperty("allowed_tools");
  expect(bundle?.files.find(f => f.path === "SKILL.md")?.text).toContain("allowed-tools: shell");
});
it("Skill import requires unique bounded frontmatter", () => {
  const a = input();
  for (const body of ['plain body', '---|name: research|name: another|description: test|---|body']) {
    expect(parseSkillBundle({ ...a, files: [{ path: 'SKILL.md', text: body.split('|').join(String.fromCharCode(10)) }] })).toBeUndefined();
  }
});
it("Skill frontmatter accepts YAML block strings and metadata while preserving exact file bytes", async () => {
  const text = '---\r\nname: research\r\ndescription: >-\r\n  Read documentation\r\n  and verify examples.\r\nlicense: MIT\r\nmetadata:\r\n  author: team\r\ncompatibility: Uses a shell\r\nallowed-tools: shell\r\n---\r\n正文\r\n';
  const metadata = skillFrontmatter(text);
  expect(metadata).toMatchObject({ description: "Read documentation and verify examples.", metadata: { author: "team" }, "allowed-tools": "shell" });
  const result = await makeSkillBundle({ ...input(), files: [{ path: "SKILL.md", text }] }, fixtureDigest);
  expect(result?.description).toBe("Read documentation and verify examples.");
  expect(result?.files[0]?.text).toBe(text);
  expect(result).not.toHaveProperty("allowed_tools");
  expect(await skillFileManifest(result!, fixtureDigest)).toEqual([{ path: "SKILL.md", bytes: Buffer.byteLength(text), sha256: await fixtureDigest(text) }]);
});
it.each([
  "description: &label text\nmetadata: *label", "description: !!str text", "description: !run text",
  "description: text\nmetadata:\n  key: a\n  key: b", "description: text\nmetadata: { <<: value }",
  "description: text\nmetadata: { constructor: value }", "description: text\nmetadata: " + "[".repeat(10) + "x" + "]".repeat(10),
  "description: text\nmetadata: [" + Array(520).fill("x").join(",") + "]",
  "description: text\nmetadata: " + "中".repeat(3000), "description: text\nmetadata: .inf"
])("Skill frontmatter rejects ambiguous or excessive YAML: %s", fields => {
  expect(skillFrontmatter("---\nname: research\n" + fields + "\n---\nbody")).toBeUndefined();
});
it("stored Skill metadata and digest survive newer YAML interpretation", async () => {
  // The previous scalar parser treated a trailing comment as description text.
  const parsed = parseSkillBundle(input())!;
  const original = { ...parsed, description: "Read docs # original", files: [{ path: "SKILL.md", text: "---\nname: research\ndescription: Read docs # original\n---\nBody" }] };
  const stored = { ...original, digest: await fixtureDigest(JSON.stringify(original)) };
  expect(await verifySkillBundle(stored, fixtureDigest)).toEqual(stored);
  expect((await makeSkillBundle(stored, fixtureDigest))?.description).toBe("Read docs");
  expect(await verifySkillBundle({ ...stored, description: "changed" }, fixtureDigest)).toBeUndefined();
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
  const repository: CatalogSnapshotPorts["repository"] = { readHead: () => head, readSnapshot: () => snapshot };
  const read = createDependencyReader({ repository, profile: () => profile, digest: fixtureDigest });
  const target = { kind: 'remote_tool' as const, resource_id: tool.tool_id, version: tool.version, connection_profile_id: 'docs' }, signal = new AbortController().signal;
  expect(await read(target, signal)).toBe('configured');
  expect(await read({ ...target, version: 'f'.repeat(64) }, signal)).toBe('incompatible');
  head = { ...head, approved_names: [] }; expect(await read(target, signal)).toBe('incompatible');
  profile = { ...profile!, enabled: false }; expect(await read(target, signal)).toBe('disabled');
  profile = undefined; expect(await read(target, signal)).toBe('not_configured');
  const aborted = new AbortController(); aborted.abort(); expect(await read(target, aborted.signal)).toBe('unavailable');
});

it.each(["active", "paused", "draft"] as const)("Skill library describes the selected %s version using metadata only", async state => {
  const first = await makeSkillBundle(input(), fixtureDigest);
  const nextInput = input(); nextInput.files[0]!.text = nextInput.files[0]!.text.replace("Read documentation safely", "Updated instructions");
  const latest = await makeSkillBundle(nextInput, fixtureDigest);
  if (!first || !latest) throw new Error("invalid fixture");
  const head: SkillHead = { skill_id: first.skill_id, revision: 3, staged_digest: latest.digest,
    active_digest: state === "draft" ? null : first.digest, enabled: state === "active" };
  const requested: string[] = [];
  const blocked = () => { throw new Error("metadata reads must not load bodies or mutate storage"); };
  const repository: SkillAdminPorts["repository"] = { heads: () => [head], head: () => head, bundle: blocked,
    stage: blocked, install: blocked, activate: blocked, disable: blocked,
    summary: (_id, digest) => {
      requested.push(digest);
      const selected = [first, latest].find(bundle => bundle.digest === digest);
      if (!selected) return undefined;
      const { files: _files, schema_version: _schema, ...summary } = selected;
      return summary;
    } };
  const service = createSkillAdministration({ repository, digest: fixtureDigest, admin: async () => "allowed" });
  const result = await service.library("session", undefined, new AbortController().signal);
  const selected = state === "draft" ? latest : first;
  expect(result).toMatchObject({ state: "listed", skills: [{ head, summary: { digest: selected.digest, description: selected.description } }] });
  expect(requested).toEqual([selected.digest]);
});

it("Skill clients list and read through a repository with no publication methods or admin session port", async () => {
  const bundle = await makeSkillBundle(input(), fixtureDigest);
  if (!bundle) throw new Error("invalid fixture");
  const head: SkillHead = { skill_id: bundle.skill_id, revision: 1, staged_digest: bundle.digest, active_digest: bundle.digest, enabled: true };
  const { files: _files, schema_version: _schema, ...summary } = bundle;
  const repository: SkillReadPorts["repository"] = { heads: () => [head], head: () => head,
    approved: () => true, summary: () => summary, bundle: () => bundle };
  let identityReads = 0;
  const service = createSkillReader({ repository, digest: fixtureDigest,
    identity: async principal => { identityReads++; return { state: "allowed", identity: { schema_version: 2, ...principal, label: "fixture", native_scopes: [] } }; } });
  const principal = { client_id: "reader-client", secret_version: 1 }, signal = new AbortController().signal;
  expect(await service.list(principal, {}, signal)).toMatchObject({ state: "listed", skills: [{ digest: bundle.digest }] });
  expect(await service.read(principal, { skill_id: bundle.skill_id, digest: bundle.digest, path: "SKILL.md" }, signal)).toMatchObject({ state: "read", files: [{ path: "SKILL.md" }, { path: "references/check.md" }] });
  expect(identityReads).toBe(4);
});
