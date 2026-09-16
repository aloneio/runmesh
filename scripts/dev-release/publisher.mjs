import assert from "node:assert/strict";
import { validateDevPlan } from "./policy.mjs";

export function devAssetNames(version) {
  assert.match(version, /^\d+\.\d+\.\d+-dev\.\d+$/u);
  return [`runmesh-runner-${version}.tgz`, "manifest.json", "manifest.sig", "manifest.signature.json", "SHA256SUMS", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "trust-keyring.json"].sort();
}
export function planMessage(plan) { return `Runmesh development prerelease\n${JSON.stringify(validateDevPlan(plan))}\n`; }
export function assertReleaseIdentity(release, plan, complete = false) {
  assert.ok(release && Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.tag_name, plan.tag); assert.equal(release.prerelease, true);
  assert.equal(release.body, planMessage(plan), "release belongs to a different plan");
  assert.equal(typeof release.draft, "boolean");
  assert.ok(Array.isArray(release.assets) && release.assets.length <= 9);
  const expected = devAssetNames(plan.version), names = release.assets.map(asset => asset.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(name => expected.includes(name)), "unexpected remote asset");
  for (const asset of release.assets) {
    assert.equal(asset.state, "uploaded");
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 8 * 1024 * 1024);
  }
  if (complete) assert.deepEqual([...names].sort(), expected, "incomplete remote assets");
  if (!release.draft) { assert.equal(release.immutable, true, "published prerelease is not immutable"); assertReleaseIdentity({ ...release, draft: true }, plan, true); }
}

/** No ambient filesystem, credentials or network: publication sequencing is
 * tested through these narrow adapters. Never overwrites tags or assets. */
export async function publishDevelopmentRelease(planInput, io) {
  const plan = validateDevPlan(planInput), tagPath = `git/ref/tags/${encodeURIComponent(plan.tag)}`;
  const releasePath = `releases/tags/${encodeURIComponent(plan.tag)}`;
  await io.verifyLocal(); await io.assertCurrentSource();
  const checkTag = async ref => {
    assert.equal(ref?.object?.type, "tag", "expected an annotated tag");
    assert.match(ref.object.sha, /^[a-f0-9]{40}$/u);
    const object = await io.api(`git/tags/${ref.object.sha}`);
    assert.equal(object.object?.type, "commit"); assert.equal(object.object?.sha, plan.source_sha);
    assert.equal(object.tag, plan.tag); assert.equal(object.message, planMessage(plan));
  };
  let ref = await io.api(tagPath, { missing: true });
  let release = await io.api(releasePath, { missing: true });
  if (release !== null) { assertReleaseIdentity(release, plan); assert.ok(ref, "release has no expected tag"); }
  if (ref !== null) await checkTag(ref);
  else {
    const object = await io.api("git/tags", { method: "POST", body: {
      tag: plan.tag, message: planMessage(plan), object: plan.source_sha, type: "commit",
      tagger: { name: "aloneio", email: "git@aloneio.aleeas.com", date: plan.published_at },
    } });
    assert.match(object.sha, /^[a-f0-9]{40}$/u);
    ref = await io.api("git/refs", { method: "POST", body: { ref: `refs/tags/${plan.tag}`, sha: object.sha } });
    await checkTag(ref);
  }
  if (release === null) {
    release = await io.api("releases", { method: "POST", body: { tag_name: plan.tag, target_commitish: plan.source_sha,
      name: `Runmesh ${plan.tag} (development)`, body: planMessage(plan), draft: true, prerelease: true, make_latest: "false" } });
    assertReleaseIdentity(release, plan);
  }
  // An interrupted draft may contain a subset of the assets. Existing bytes
  // must match before missing ones are uploaded; there is no --clobber path.
  await io.verifyRemote(release.assets.map(asset => asset.name), false);
  if (release.draft) {
    const existing = new Set(release.assets.map(asset => asset.name));
    const missing = devAssetNames(plan.version).filter(name => !existing.has(name));
    if (missing.length > 0) await io.uploadMissing(missing);
    release = await io.api(releasePath); assertReleaseIdentity(release, plan, true);
    await io.verifyRemote(devAssetNames(plan.version), true);
    await io.assertCurrentSource(); await checkTag(await io.api(tagPath));
    if (release.draft) await io.api(`releases/${release.id}`, { method: "PATCH", body: { draft: false, prerelease: true, make_latest: "false" } });
  }
  const published = await io.api(releasePath); assertReleaseIdentity(published, plan, true);
  assert.equal(published.draft, false); assert.equal(published.immutable, true);
  await checkTag(await io.api(tagPath)); await io.verifyRemote(devAssetNames(plan.version), true);
  return { tag: plan.tag, source_sha: plan.source_sha, release_id: published.id, prerelease: true, immutable: true };
}
