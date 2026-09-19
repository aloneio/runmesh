import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { DEV_RELEASE_INTERVAL, releaseCadence, nextDevVersion, createDevPlan, validateDevPlan, assertPlanContext } from "../scripts/dev-release/policy.mjs";
import { devAssetNames, planMessage, publishDevelopmentRelease } from "../scripts/dev-release/publisher.mjs";
import { githubJson } from "../scripts/dev-release/github.mjs";
import { buildManifest, buildDevelopmentManifest } from "../scripts/release-manifest.mjs";
import { bundleRunner } from "../scripts/build-runner-bundle.mjs";
import { publicationPreflight } from "../scripts/dev-release/preflight.mjs";
import { readPlan } from "../scripts/dev-release/io.mjs";

const plan = () => createDevPlan({ source_sha: "a".repeat(40), source_tree: "b".repeat(40), stable_sha: "c".repeat(40), stable_version: "0.1.3", stable_release: { release_id: 9, commit_sha: "c".repeat(40), manifest_sha256: "f".repeat(64) }, push_number: 5, run_id: 123, published_at: "2026-09-16T00:00:00Z" });
const env = () => ({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_REPOSITORY: "aloneio/runmesh", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_NUMBER: "5", GITHUB_RUN_ID: "123" });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), "runmesh-dev-release-test-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("only every fifth dedicated push is due; attempts and commit counts are irrelevant", () => {
  assert.equal(DEV_RELEASE_INTERVAL, 5);
  assert.deepEqual(Array.from({ length: 21 }, (_, i) => i + 1).filter(n => releaseCadence(n).due), [5, 10, 15, 20]);
  assert.equal(releaseCadence(1).remaining, 4); assert.equal(releaseCadence(4).remaining, 1);
  for (const attempt of [1, 2, 20]) assert.doesNotThrow(() => assertPlanContext(plan(), { ...env(), GITHUB_RUN_ATTEMPT: String(attempt) }));
});
test("versions use next patch of main and deterministic batch sequence", () => {
  assert.equal(nextDevVersion("0.1.1", 5), "0.1.2-dev.0");
  assert.equal(nextDevVersion("0.1.3", 5), "0.1.4-dev.0");
  assert.equal(nextDevVersion("0.1.3", 10), "0.1.4-dev.1");
  assert.equal(nextDevVersion("1.9.99", 15), "1.9.100-dev.2");
  assert.equal(nextDevVersion("0.1.4", 20), "0.1.5-dev.3");
});
test("rejects nonstable bases and invalid counts instead of coercing a release", () => {
  for (const v of ["0.1.3-dev.1", "v0.1.3", "01.1.3", "0.1.3+build", "0.1.3\n", "0.1.999999999"]) assert.throws(() => nextDevVersion(v, 5));
  for (const n of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "5"]) assert.throws(() => releaseCadence(n));
  assert.throws(() => nextDevVersion("0.1.3", 4));
});
test("plan is closed and bound to source, branch, repository and run", () => {
  const p = plan(); assert.deepEqual(validateDevPlan(JSON.parse(JSON.stringify(p))), p);
  for (const change of [{ version: "0.1.4" }, { tag: "v0.1.3" }, { channel: "stable" }, { run_id: 0 }, { source_sha: "bad" }, { secret: "not-allowed" }, { published_at: "2026-02-30T00:00:00Z" }]) assert.throws(() => validateDevPlan({ ...p, ...change }));
  for (const change of [{ GITHUB_REF: "refs/heads/main" }, { GITHUB_EVENT_NAME: "workflow_dispatch" }, { GITHUB_SHA: "d".repeat(40) }, { GITHUB_RUN_NUMBER: "10" }, { GITHUB_RUN_ID: "124" }, { GITHUB_REPOSITORY: "fork/runmesh" }]) assert.throws(() => assertPlanContext(p, { ...env(), ...change }));
});

test("development plan reads reject oversized, nonregular and redirected inputs", async t => {
  const dir = await temp(t), path = join(dir, "plan.json"), p = plan();
  await writeFile(path, JSON.stringify(p));
  assert.deepEqual(await readPlan(path), p);
  await assert.rejects(readPlan(dir));
  await writeFile(path, JSON.stringify(p).padEnd(4097, " "));
  await assert.rejects(readPlan(path));
  await writeFile(path, JSON.stringify(p));
  // Symlink creation on Windows can require a privilege unrelated to this
  // boundary; Linux CI exercises the redirected-file rejection unconditionally.
  const alias = join(dir, "plan-link.json");
  try { await symlink(path, alias, "file"); }
  catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) { t.diagnostic("Windows symlink privilege unavailable"); return; } throw error; }
  await assert.rejects(readPlan(alias));
});
test("development manifests require a validated plan; stable manifest binding is unchanged", async t => {
  const dir = await temp(t), p = plan(); await writeFile(join(dir, `runmesh-runner-${p.version}.tgz`), "synthetic archive");
  await assert.rejects(buildManifest({ releaseDirectory: dir, version: p.version, commitSha: p.source_sha, publishedAt: p.published_at }), /root package.json/u);
  const manifest = await buildDevelopmentManifest({ releaseDirectory: dir, plan: p });
  assert.equal(manifest.channel, "dev"); assert.equal(manifest.prerelease, true); assert.equal(manifest.commit_sha, p.source_sha); assert.equal(manifest.version, p.version);
  await assert.rejects(buildDevelopmentManifest({ releaseDirectory: dir, plan: { ...p, version: "0.1.4" } }));
});
test("shared bundler overrides the installed dev identity without accepting another stable version", async t => {
  const dir = await temp(t), source = join(dir, "entry.ts"), output = join(dir, "output.cjs");
  await writeFile(source, "console.log(process.env.RUNMESH_RUNNER_VERSION);");
  await bundleRunner(source, output, "cjs", "0.1.4-dev.0");
  assert.equal(execFileSync(process.execPath, [output], { encoding: "utf8" }).trim(), "0.1.4-dev.0");
  await assert.rejects(bundleRunner(source, output, "cjs", "99.0.0"), /prerelease/u);
});

test("GitHub adapter treats only a real 404 as absent and never echoes tokens", async () => {
  for (const status of [401, 403, 429, 500, 503]) await assert.rejects(githubJson("releases/tags/v0.1.4-dev.0", { token: "PRIVATE", missing: true, fetchImpl: async () => new Response("PRIVATE", { status }) }), error => !error.message.includes("PRIVATE") && error.message.includes(String(status)));
  assert.equal(await githubJson("releases/tags/x", { token: "private", missing: true, fetchImpl: async () => new Response(null, { status: 404 }) }), null);
  await assert.rejects(githubJson("releases/tags/x", { token: "private", fetchImpl: async () => new Response(null, { status: 404 }) }));
  await assert.rejects(githubJson("https://evil.invalid", { token: "private", fetchImpl: async () => { throw new Error("must not fetch"); } }));
});
test("GitHub adapter fixes origin, disallows redirects and caps responses", async () => {
  await githubJson("git/refs", { token: "private", method: "POST", body: { ref: "safe" }, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/aloneio/runmesh/git/refs"); assert.equal(options.redirect, "error"); assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { ref: "safe" }); return Response.json({ id: 1 });
  } });
  await assert.rejects(githubJson("releases", { token: "private", fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)) }), /byte limit/u);
});

function publisherFixture({ published = false, draft = false, wrongTag = false, badBytes = false, immutable = true, tagLookupMissing = false } = {}) {
  const p = plan(), objectSha = "d".repeat(40), writes = [], verifications = [];
  let object = published || draft || wrongTag ? { sha: objectSha, object: { type: "commit", sha: wrongTag ? "e".repeat(40) : p.source_sha }, tag: p.tag, message: planMessage(p) } : null;
  let ref = object ? { object: { type: "tag", sha: objectSha } } : null;
  const asset = name => ({ name, size: 50, state: "uploaded" });
  let release = published || draft ? { id: 1, tag_name: p.tag, body: planMessage(p), draft: !published, prerelease: true, immutable: published && immutable, assets: (published ? devAssetNames(p.version) : ["manifest.json"]).map(asset) } : null;
  const io = {
    verifyLocal: async () => {}, assertCurrentSource: async () => {}, assertCurrentBaseline: async () => {},
    verifyRemote: async (names, complete) => { verifications.push({ names, complete }); if (badBytes && names.length) throw new Error("remote bytes differ"); },
    uploadMissing: async names => { writes.push({ upload: names }); release.assets.push(...names.map(asset)); },
    api: async (path, options = {}) => {
      if (options.method) writes.push({ path, ...options });
      if (path.startsWith("git/ref/tags/")) return ref;
      if (path === "git/tags") { object = { sha: objectSha, object: { type: "commit", sha: options.body.object }, tag: options.body.tag, message: options.body.message }; return object; }
      if (path.startsWith("git/tags/")) return object;
      if (path === "git/refs") { ref = { object: { type: "tag", sha: objectSha } }; return ref; }
      if (path.startsWith("releases/tags/")) return tagLookupMissing ? null : release && structuredClone(release);
      if (path === "releases?per_page=30") return release === null ? [] : [structuredClone(release)];
      if (path === "releases") { release = { ...options.body, id: 1, assets: [], immutable: false }; return structuredClone(release); }
      if (path === "releases/1" && options.method === "PATCH") { release = { ...release, ...options.body, immutable }; return structuredClone(release); }
      if (path === "releases/1") return release && structuredClone(release);
      throw new Error(`unexpected endpoint: ${path}`);
    },
  };
  return { plan: p, io, writes, verifications };
}
test("publishes draft -> exact download verification -> immutable prerelease, never Latest", async () => {
  const f = publisherFixture(); const result = await publishDevelopmentRelease(f.plan, f.io);
  assert.equal(result.immutable, true);
  const created = f.writes.find(w => w.path === "releases"); assert.equal(created.body.draft, true); assert.equal(created.body.prerelease, true); assert.equal(created.body.make_latest, "false");
  const publish = f.writes.find(w => w.path === "releases/1"); assert.deepEqual(publish.body, { draft: false, prerelease: true, make_latest: "false" });
  assert.equal(f.verifications.filter(v => v.complete).length, 2);
});
test("retries of a verified published batch perform no writes", async () => {
  const f = publisherFixture({ published: true }); await publishDevelopmentRelease(f.plan, f.io); assert.deepEqual(f.writes, []);
});
test("interrupted drafts upload only missing assets", async () => {
  const f = publisherFixture({ draft: true }); await publishDevelopmentRelease(f.plan, f.io);
  assert.equal(f.writes.filter(w => w.path === "git/tags" || w.path === "releases").length, 0);
  const uploaded = f.writes.find(w => w.upload).upload; assert.equal(uploaded.length, 8); assert.ok(!uploaded.includes("manifest.json"));
});
test("recovers an existing draft when GitHub release-by-tag returns 404", async () => {
  const f = publisherFixture({ draft: true, tagLookupMissing: true }); await publishDevelopmentRelease(f.plan, f.io);
  assert.equal(f.writes.filter(w => w.path === "releases" && w.method === "POST").length, 0);
  assert.ok(f.writes.some(w => w.upload));
  assert.ok(f.writes.some(w => w.path === "releases/1" && w.method === "PATCH"));
});
test("conflicting tag identity or draft bytes stops without clobbering", async () => {
  for (const options of [{ wrongTag: true }, { draft: true, badBytes: true }]) {
    const f = publisherFixture(options); await assert.rejects(publishDevelopmentRelease(f.plan, f.io)); assert.deepEqual(f.writes, []);
  }
});
test("unavailable remote evidence and revoked source stop all publication", async () => {
  const f = publisherFixture(); f.io.api = async () => { throw new Error("unavailable"); };
  await assert.rejects(publishDevelopmentRelease(f.plan, f.io)); assert.deepEqual(f.writes, []);
  const g = publisherFixture(); g.io.assertCurrentSource = async () => { throw new Error("source no longer reachable"); };
  await assert.rejects(publishDevelopmentRelease(g.plan, g.io)); assert.deepEqual(g.writes, []);
});
test("a public but unlocked release is not reported as successful", async () => {
  const f = publisherFixture({ published: true, immutable: false }); await assert.rejects(publishDevelopmentRelease(f.plan, f.io), /immutable/u);
});

test("a superseded pending batch makes no tag, upload or publication writes", async () => {
  for (const options of [{}, { draft: true }]) {
    const f = publisherFixture(options);
    f.io.assertCurrentBaseline = async () => { throw new Error("dev_release_superseded"); };
    await assert.rejects(publishDevelopmentRelease(f.plan, f.io), /superseded/u); assert.deepEqual(f.writes, []);
  }
});
test("main advancing during draft upload blocks the final public transition", async () => {
  const f = publisherFixture({ draft: true }); let checks = 0;
  f.io.assertCurrentBaseline = async () => { if (++checks === 2) throw new Error("dev_release_superseded"); };
  await assert.rejects(publishDevelopmentRelease(f.plan, f.io), /superseded/u);
  assert.ok(f.writes.some(w => w.upload)); assert.ok(!f.writes.some(w => w.method === "PATCH"));
});
test("completed batches remain verifiable after main and dev history changes", async () => {
  const f = publisherFixture({ published: true });
  f.io.assertCurrentBaseline = f.io.assertCurrentSource = async () => { throw new Error("must not check today's source"); };
  await publishDevelopmentRelease(f.plan, f.io); assert.deepEqual(f.writes, []);
  let verified = false;
  assert.deepEqual(await publicationPreflight(f.plan, { ...f.io, verifyPublished: async () => { verified = true; } }), { already_published: true });
  assert.equal(verified, true); assert.deepEqual(f.writes, []);
});
test("preflight refuses obsolete drafts before signing and does not trust a success label alone", async () => {
  const f = publisherFixture({ draft: true }); f.io.assertCurrentBaseline = async () => { throw new Error("dev_release_superseded"); };
  await assert.rejects(publicationPreflight(f.plan, f.io), /superseded/u); assert.deepEqual(f.writes, []);
  const recovered = publisherFixture({ draft: true, tagLookupMissing: true }); recovered.io.assertCurrentBaseline = async () => { throw new Error("dev_release_superseded"); };
  await assert.rejects(publicationPreflight(recovered.plan, recovered.io), /superseded/u); assert.deepEqual(recovered.writes, []);
  const g = publisherFixture({ published: true });
  await assert.rejects(publicationPreflight(g.plan, { ...g.io, verifyPublished: async () => { throw new Error("bad signature"); } }), /bad signature/u);
  assert.deepEqual(g.writes, []);
});

test("workflow is dev-push-only, counts independently, isolates signing and retains exact-source verification", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/dev-release.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on, { push: { branches: ["dev"] } });
  assert.equal(workflow.permissions.contents, "read"); assert.ok(workflow.concurrency.group.includes("github.run_id")); assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.plan.if, "needs.cadence.outputs.due == 'true'");
  assert.equal(workflow.jobs.verification.uses, "./.github/workflows/ci.yml"); assert.equal(workflow.jobs.verification.with.release_verification, true);
  assert.deepEqual(workflow.jobs.publish.needs, ["plan", "verification", "build"]); assert.equal(workflow.jobs.publish.environment, "dev-release");
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
  assert.equal(workflow.jobs.publish.env.BUILD_ATTEMPT, "${{ needs.build.outputs.attempt }}");
  const sign = workflow.jobs.publish.steps.findIndex(s => s.env?.RELEASE_SIGNING_KEY);
  const preflight = workflow.jobs.publish.steps.findIndex(s => s.id === "publication-preflight"); assert.ok(preflight >= 0 && sign > preflight);
  assert.equal(JSON.stringify(workflow.jobs.publish).includes("verify-ci.mjs"), false);
  assert.equal(JSON.stringify(workflow.jobs.publish).includes("GITLAB_READ_API_TOKEN"), false);
  for (const [id, job] of Object.entries(workflow.jobs)) for (const step of job.steps ?? []) {
    if (step.uses?.startsWith("actions/checkout@")) { assert.equal(step.with.ref, "${{ github.sha }}"); assert.equal(step.with["persist-credentials"], false); }
    if (id !== "publish") assert.ok(!JSON.stringify(step).includes("secrets.RELEASE_SIGNING_KEY"));
  }
  const ci = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.equal(ci.on.workflow_call.inputs.release_verification.default, false);
  assert.ok(ci.concurrency.group.includes("inputs.release_verification")); assert.ok(ci.concurrency["cancel-in-progress"].includes("!inputs.release_verification"));
});
