import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, readFile, writeFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { parse } from "yaml";
import { DEV_RELEASE_INTERVAL, releaseCadence, nextDevVersion, createDevPlan, validateDevPlan, assertPlanContext, validateDevDeferral } from "../scripts/dev-release/policy.mjs";
import { baselineError } from "../scripts/dev-release/baseline-policy.mjs";
import { prepareDevelopmentPlan } from "../scripts/dev-release/plan.mjs";
import { devAssetNames, planMessage, publishDevelopmentRelease } from "../scripts/dev-release/publisher.mjs";
import { githubJson } from "../scripts/dev-release/github.mjs";
import { buildManifest, buildDevelopmentManifest } from "../scripts/release-manifest.mjs";
import { bundleRunner } from "../scripts/build-runner-bundle.mjs";
import { publicationPreflight } from "../scripts/dev-release/preflight.mjs";
import { readPlan } from "../scripts/dev-release/io.mjs";

const plan = () => createDevPlan({ source_sha: "a".repeat(40), source_tree: "b".repeat(40), stable_sha: "c".repeat(40), stable_version: "0.1.3", stable_release: { release_id: 9, commit_sha: "c".repeat(40), manifest_sha256: "f".repeat(64) }, push_number: 5, run_id: 123, published_at: "2026-09-16T00:00:00Z" });
const env = () => ({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_REPOSITORY: "aloneio/runmesh", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_NUMBER: "5", GITHUB_RUN_ID: "123" });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), "runmesh-dev-release-test-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

for (const operation of ["read", "fetch"]) test(`development Git ${operation} stays in its source checkout despite inherited routing`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh-dev-git-"));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith("runmesh-dev-git-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const runGit = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Runmesh Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(directory, "no-hooks"), ...args],
  { cwd, env: environment, encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const requested = join(directory, "requested"), other = join(directory, "other");
  for (const cwd of [requested, other]) {
    await mkdir(cwd); runGit(cwd, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(cwd, "source.txt"), basename(cwd)); runGit(cwd, "add", "."); runGit(cwd, "commit", "--quiet", "-m", "fixture");
  }
  await mkdir(join(requested, "scripts/dev-release"), { recursive: true });
  for (const file of ["dev-release/io.mjs", "dev-release/policy.mjs", "dev-release/baseline-policy.mjs", "evidence-io.mjs", "ci-report.mjs", "source-git.mjs"])
    await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(requested, "scripts", file));
  runGit(requested, "remote", "add", "origin", other); runGit(other, "remote", "add", "origin", requested);
  const requestedSha = runGit(requested, "rev-parse", "HEAD"), otherSha = runGit(other, "rev-parse", "HEAD");
  assert.notEqual(requestedSha, otherSha);
  const routed = { ...environment, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git/index") };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { git, command } from ${JSON.stringify(pathToFileURL(join(requested, "scripts/dev-release/io.mjs")).href)};
    const inherited = process.env.GIT_DIR;
    ${operation === "fetch" ? "await git('fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main');" : ""}
    const commit = await git('rev-parse', 'HEAD');
    assert.equal(process.env.GIT_DIR, inherited);
    const child = await command(process.execPath, ['-e', 'process.stdout.write(process.env.GIT_DIR)']);
    assert.equal(child.stdout, inherited, 'Only Git commands isolate Git routing');
    console.log(JSON.stringify({ commit }));
  `], { cwd: other, env: routed, encoding: "utf8", timeout: 20000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  if (operation === "read") assert.equal(JSON.parse(result.stdout).commit, requestedSha);
  else {
    assert.equal(runGit(requested, "rev-parse", "refs/remotes/origin/main"), otherSha);
    assert.equal(runGit(other, "for-each-ref", "--format=%(refname)", "refs/remotes"), "", "foreign checkout must not receive fetched refs");
  }
});

async function planningFixture(t, deferred = false) {
  const directory = await temp(t), p = plan(); let observations = 0;
  const ports = { directory,
    git: async (...args) => {
      if (args.join(" ") === "rev-parse HEAD^{tree}") return p.source_tree;
      assert.deepEqual(args, ["show", "-s", "--format=%ct", p.source_sha]); return String(Date.parse(p.published_at) / 1000);
    },
    observeStableBaseline: async source => {
      assert.equal(source, p.source_sha); observations++;
      if (deferred) throw baselineError("stable_baseline_unpublished", "main awaits publication");
      return { stable_sha: p.stable_sha, stable_version: p.stable_version, stable_release: p.stable_release };
    },
    assertSource: async value => { assert.equal(value.source_sha, p.source_sha); assert.equal(value.source_tree, p.source_tree); },
  };
  return { directory, ports, observations: () => observations,
    run: (attempt = 1, changed = {}) => prepareDevelopmentPlan({ ...env(), GITHUB_RUN_ATTEMPT: String(attempt), ...changed }, ports) };
}

test("ready development planning persists the exact plan and reuses it without a new baseline observation", async t => {
  const f = await planningFixture(t), first = await f.run();
  assert.deepEqual(first, { ready: true, plan: plan() });
  assert.deepEqual(await readdir(f.directory), ["plan.json"]);
  const saved = await readFile(join(f.directory, "plan.json"), "utf8");
  f.ports.observeStableBaseline = async () => { throw new Error("main is now candidate; the frozen plan remains unchanged"); };
  assert.deepEqual(await f.run(2), first);
  assert.equal(await readFile(join(f.directory, "plan.json"), "utf8"), saved);
  assert.equal(f.observations(), 1);
});

test("an unpublished stable window freezes a deferred outcome without reserving a plan or version", async t => {
  const f = await planningFixture(t, true), first = await f.run();
  assert.equal(first.ready, false); assert.deepEqual(await readdir(f.directory), ["deferred.json"]);
  assert.deepEqual(validateDevDeferral(first.deferred), first.deferred);
  assert.equal(first.deferred.reason, "stable_baseline_unpublished");
  assert.equal(Object.hasOwn(first.deferred, "version"), false); assert.equal(Object.hasOwn(first.deferred, "tag"), false);
  const saved = await readFile(join(f.directory, "deferred.json"), "utf8");
  f.ports.observeStableBaseline = async () => { throw new Error("must not reobserve even after main is released"); };
  assert.deepEqual(await f.run(2), first); assert.equal(f.observations(), 1);
  assert.equal(await readFile(join(f.directory, "deferred.json"), "utf8"), saved);
  await assert.rejects(f.run(1), /already exists/u);
});

test("API, signature, ancestry and malformed baseline errors remain failed planning attempts", async t => {
  for (const code of ["stable_baseline_invalid", "stable_baseline_not_in_dev", "http_403", "signature_invalid"]) {
    const f = await planningFixture(t); f.ports.observeStableBaseline = async () => { throw baselineError(code, "failure"); };
    await assert.rejects(f.run(), { code }); assert.deepEqual(await readdir(f.directory), []);
  }
});

test("source validation failure leaves no ready or deferred planning outcome", async t => {
  for (const deferred of [false, true]) {
    const f = await planningFixture(t, deferred);
    f.ports.assertSource = async () => { throw new Error("source checkout is dirty or does not match the recorded tree"); };
    await assert.rejects(f.run(), /source checkout/u);
    assert.deepEqual(await readdir(f.directory), []);
  }
});

test("first planning attempt rejects a mismatched repository, branch or source before saving", async t => {
  for (const deferred of [false, true]) {
    for (const changed of [{ GITHUB_REPOSITORY: "fork/runmesh" }, { GITHUB_REF: "refs/heads/main" }, { GITHUB_SHA: "d".repeat(40) }]) {
      const f = await planningFixture(t, deferred);
      await assert.rejects(f.run(1, changed)); assert.deepEqual(await readdir(f.directory), []);
    }
  }
});

test("deferred retries require one intact outcome bound to the source, branch, repository and run", async t => {
  const empty = await planningFixture(t); await assert.rejects(empty.run(2), /exactly one/u);
  const both = await planningFixture(t, true); await both.run();
  await writeFile(join(both.directory, "plan.json"), JSON.stringify(plan()));
  await assert.rejects(both.run(2), /exactly one/u);
  const f = await planningFixture(t, true), first = await f.run(), file = join(f.directory, "deferred.json");
  for (const changed of [{ repository: "fork/runmesh" }, { ref: "refs/heads/main" }, { source_sha: "d".repeat(40) },
    { source_tree: "e".repeat(40) }, { run_id: 124 }, { push_number: 10 }, { reason: "http_503" }, { version: "0.1.4-dev.0" }]) {
    await writeFile(file, JSON.stringify({ ...first.deferred, ...changed })); await assert.rejects(f.run(2));
  }
  for (const text of ["{invalid", " ".repeat(4097)]) { await writeFile(file, text); await assert.rejects(f.run(2)); }
  await rm(file); await mkdir(file); await assert.rejects(f.run(2));
  assert.equal(f.observations(), 1);
});

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
  assert.equal(workflow.jobs.plan.outputs.ready, "${{ steps.plan.outputs.ready }}");
  for (const job of ["verification", "build", "publish"]) assert.equal(workflow.jobs[job].if, "needs.plan.outputs.ready == 'true'");
  const outcomeArtifact = workflow.jobs.plan.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(outcomeArtifact.if, "github.run_attempt == 1");
  assert.deepEqual(outcomeArtifact.with.path.trim().split(/\r?\n/u), [".dev-release/plan.json", ".dev-release/deferred.json"]);
  assert.equal(outcomeArtifact.with["if-no-files-found"], "error"); assert.equal(outcomeArtifact.with.overwrite, false);
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
