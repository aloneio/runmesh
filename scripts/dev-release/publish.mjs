import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readBoundedReleaseFile } from "../release-io.mjs";
import { assertPlanContext } from "./policy.mjs";
import { assertSource, command, git, readPlan, root } from "./io.mjs";
import { githubJson } from "./github.mjs";
import { devAssetNames, publishDevelopmentRelease } from "./publisher.mjs";
import { assertCurrentBaseline } from "./baseline.mjs";

assert.equal(process.argv.length, 3); const plan = await readPlan(process.argv[2]);
assertPlanContext(plan, process.env);
const directory = join(root, ".dev-release/assets"), keyring = join(root, "release/trust-keyring.json");
assert.ok(process.env.RELEASE_SIGNING_KEY_ID, "signing key identity is required");
const names = devAssetNames(plan.version); const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const local = new Map();
for (const name of names) local.set(name, digest(await readBoundedReleaseFile(join(directory, name), name)));
async function verify(directory) {
  const manifest = JSON.parse((await readBoundedReleaseFile(join(directory, "manifest.json"))).toString("utf8"));
  assert.equal(manifest.commit_sha, plan.source_sha); assert.equal(manifest.channel, "dev"); assert.equal(manifest.prerelease, true);
  assert.equal(manifest.published_at, plan.published_at);
  assert.equal(digest(await readBoundedReleaseFile(join(directory, "trust-keyring.json"))), digest(await readBoundedReleaseFile(keyring)));
  await command(process.execPath, ["scripts/release-verify.mjs", join(directory, "manifest.json"), join(directory, "manifest.sig"), join(directory, "manifest.signature.json"), keyring, process.env.RELEASE_SIGNING_KEY_ID, plan.version]);
}
const result = await publishDevelopmentRelease(plan, {
  api: githubJson,
  assertCurrentBaseline: () => assertCurrentBaseline(plan),
  verifyLocal: async () => { assert.deepEqual((await readdir(directory)).sort(), names); await verify(directory); },
  assertCurrentSource: async () => {
    await assertSource(plan);
    await git("fetch", "--no-tags", "origin", "dev:refs/remotes/origin/dev");
    // Later normal pushes are allowed; a force-rewritten source is not.
    await git("merge-base", "--is-ancestor", plan.source_sha, "origin/dev");
  },
  uploadMissing: async missing => { await command("gh", ["release", "upload", plan.tag, ...missing.map(name => join(directory, name)), "--repo", plan.repository]); },
  verifyRemote: async (expected, complete) => {
    if (expected.length === 0) return;
    const downloaded = await mkdtemp(join(tmpdir(), "runmesh-dev-release-"));
    try {
      await command("gh", ["release", "download", plan.tag, "--repo", plan.repository, "--dir", downloaded, ...expected.flatMap(name => ["--pattern", name])]);
      assert.deepEqual((await readdir(downloaded)).sort(), [...expected].sort());
      for (const name of expected) assert.equal(digest(await readBoundedReleaseFile(join(downloaded, name), name)), local.get(name), `remote asset differs: ${name}`);
      if (complete) await verify(downloaded);
    } finally { await rm(downloaded, { recursive: true, force: true }); }
  },
});
console.log(JSON.stringify(result));
