import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedReleaseFile } from "../release-io.mjs";
import { verifyReleaseAssets } from "../release-verify.mjs";
import { assertPlanContext } from "./policy.mjs";
import { assertSource, command, mainModule, readPlan, root } from "./io.mjs";
import { githubJson } from "./github.mjs";
import { assertCurrentBaseline } from "./baseline.mjs";
import { assertReleaseIdentity, devAssetNames, findDevelopmentRelease, verifyDevTag } from "./publisher.mjs";

/** Completed releases are immutable history, not candidates against today's
 * main. Missing/draft releases must pass current-baseline checks before signing. */
export async function publicationPreflight(plan, io) {
  const release = await findDevelopmentRelease(plan, io.api);
  if (release !== null) assertReleaseIdentity(release, plan);
  if (release !== null && !release.draft) {
    await verifyDevTag(plan, await io.api(`git/ref/tags/${encodeURIComponent(plan.tag)}`), io.api);
    await io.verifyPublished(release);
    return { already_published: true };
  }
  await io.assertCurrentBaseline(); return { already_published: false };
}

export async function verifyPublishedDevelopment(plan) {
  const names = devAssetNames(plan.version), directory = await mkdtemp(join(tmpdir(), "runmesh-dev-completed-"));
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  try {
    await command("gh", ["release", "download", plan.tag, "--repo", plan.repository, "--dir", directory, ...names.flatMap(name => ["--pattern", name])]);
    assert.deepEqual((await readdir(directory)).sort(), names);
    const bytes = new Map(); for (const name of names) bytes.set(name, await readBoundedReleaseFile(join(directory, name), name));
    const manifest = await verifyReleaseAssets({ manifestPath: join(directory, "manifest.json"), signaturePath: join(directory, "manifest.sig"), descriptorPath: join(directory, "manifest.signature.json"), keyringPath: join(root, "release/trust-keyring.json"), expectedVersion: plan.version });
    assert.equal(manifest.commit_sha, plan.source_sha); assert.equal(manifest.published_at, plan.published_at);
    // The build job validated the exact package and its embedded plan; compare
    // those two unsigned inputs without needing today's private signing key.
    for (const name of ["manifest.json", `runmesh-runner-${plan.version}.tgz`]) assert.equal(digest(bytes.get(name)), digest(await readBoundedReleaseFile(join(root, ".dev-release/assets", name), name)));
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "trust-keyring.json"]) {
      const path = name === "trust-keyring.json" ? join(root, "release", name) : join(root, name);
      assert.equal(digest(bytes.get(name)), digest(await readBoundedReleaseFile(path, name)));
    }
    const checksumNames = [];
    for (const line of bytes.get("SHA256SUMS").toString("utf8").trimEnd().split("\n")) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(line); assert.ok(match && names.includes(match[2]) && match[2] !== "SHA256SUMS");
      checksumNames.push(match[2]); assert.equal(match[1], digest(bytes.get(match[2])));
    }
    assert.deepEqual(checksumNames.sort(), names.filter(name => name !== "SHA256SUMS"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (mainModule(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const plan = await readPlan(process.argv[2]); assertPlanContext(plan, process.env); await assertSource(plan);
  const result = await publicationPreflight(plan, { api: githubJson, verifyPublished: () => verifyPublishedDevelopment(plan), assertCurrentBaseline: () => assertCurrentBaseline(plan) });
  assert.ok(process.env.GITHUB_OUTPUT);
  await appendFile(process.env.GITHUB_OUTPUT, `already_published=${result.already_published}\n`);
  console.log(JSON.stringify({ ...result, tag: plan.tag, signing: result.already_published ? "not_needed" : "eligible" }));
}
