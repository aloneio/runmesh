import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertNoUnapprovedEmail, assertTarballPrivacy, checkReleaseAssets } from "../scripts/check-release-privacy.mjs";
import { validateReleasePrivacyWiring } from "../scripts/check-release-workflow-privacy.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const runnerNotice = join(sourceRoot, "apps/runner/THIRD_PARTY_NOTICES.md");
const rootNotice = join(sourceRoot, "THIRD_PARTY_NOTICES.md");

test("private emails are rejected without displaying their values", () => {
  for (const email of ["person@" + "gmail.com", "person@custom-domain.example", "example@" + "outlook.com", "someone@company.co"]) {
    assert.throws(() => assertNoUnapprovedEmail("secret: " + email, "test_file"), error => {
      assert.match(error.message, /release_privacy_email_rejected/u);
      assert.ok(!error.message.includes(email));
      return true;
    });
  }
  assert.doesNotThrow(() => assertNoUnapprovedEmail("aloneio <git@aloneio.aleeas.com>", "sample"));
});
test("only the exact reviewed third-party license keeps its legal email", async () => {
  const legal = await readFile(runnerNotice);
  assert.ok(legal.toString("utf8").includes("@gmail" + ".com"));
  assert.doesNotThrow(() => assertNoUnapprovedEmail(legal, "package/THIRD_PARTY_NOTICES.md", { legalNotice: true }));
  assert.throws(() => assertNoUnapprovedEmail(Buffer.concat([legal, Buffer.from("changed")]), "package/THIRD_PARTY_NOTICES.md", { legalNotice: true }), /release_privacy_email_rejected/u);
  assert.throws(() => assertNoUnapprovedEmail(legal, "manifest.json", { legalNotice: true }), /release_privacy_email_rejected/u);
});

async function withArchive(callback) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-release-privacy-"));
  const directory = join(root, "package"), dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@aloneio/example", version: "1.2.3" }));
  await writeFile(join(dist, "runner.cjs"), "console.log('ok');\n");
  await copyFile(runnerNotice, join(directory, "THIRD_PARTY_NOTICES.md"));
  const archive = join(root, "archive.tgz");
  async function pack() {
    const result = spawnSync("tar", ["-czf", archive, "-C", root, "package"], { timeout: 10000, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return readFile(archive);
  }
  try { return await callback({ root, directory, dist, archive, pack }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("archive scanner inspects runtime code and metadata without losing legal notices", async () => {
  await withArchive(async ({ dist, directory, pack }) => {
    assert.ok(assertTarballPrivacy(await pack()) >= 3);
    await writeFile(join(dist, "runner.cjs"), "console.log('developer@private.invalid');");
    const brokenArchive0 = await pack();
    assert.throws(() => assertTarballPrivacy(brokenArchive0), /release_privacy_email_rejected/u);
    await writeFile(join(dist, "runner.cjs"), "console.log('ok');");
    await writeFile(join(directory, "package.json"), JSON.stringify({ author: "Jane <jane@example.net>", version: "1.2.3" }));
    const brokenArchive1 = await pack();
    assert.throws(() => assertTarballPrivacy(brokenArchive1), /release_privacy_email_rejected/u);
    await writeFile(join(directory, "package.json"), JSON.stringify({ version: "1.2.3" }));
    await writeFile(join(directory, "THIRD_PARTY_NOTICES.md"), (await readFile(runnerNotice, "utf8")) + "\nextra\n");
    const brokenArchive2 = await pack();
    assert.throws(() => assertTarballPrivacy(brokenArchive2), /release_privacy_email_rejected/u);
  });
});
test("nine-asset distribution scan rejects added notes, manifest and archive email", async () => {
  await withArchive(async ({ root, dist, archive, pack }) => {
    const assets = join(root, "assets");
    await mkdir(assets);
    const version = "1.2.3";
    await pack();
    await copyFile(archive, join(assets, "runmesh-runner-1.2.3.tgz"));
    const names = ["manifest.json", "manifest.sig", "manifest.signature.json", "SHA256SUMS", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "trust-keyring.json"];
    for (const name of names) await writeFile(join(assets, name), name === "manifest.json" ? JSON.stringify({ version }) : "approved");
    await copyFile(rootNotice, join(assets, "THIRD_PARTY_NOTICES.md"));
    assert.deepEqual(await checkReleaseAssets(assets), { assets: 9, archive: "runmesh-runner-1.2.3.tgz" });
    const notes = join(root, "release-notes.md");
    await writeFile(notes, "Release 1.2.3\n");
    await checkReleaseAssets(assets, { notes });
    await writeFile(notes, "Author: private@example.org");
    await assert.rejects(checkReleaseAssets(assets, { notes }), /release_privacy_email_rejected/u);
    await writeFile(notes, "Release 1.2.3\n");
    await writeFile(join(assets, "manifest.json"), JSON.stringify({ version, maintainer: "someone@somewhere.example" }));
    await assert.rejects(checkReleaseAssets(assets), /release_privacy_email_rejected/u);
    await writeFile(join(assets, "manifest.json"), JSON.stringify({ version }));
    await writeFile(join(dist, "runner.cjs"), "console.log('person@example.net');");
    await pack();
    await copyFile(archive, join(assets, "runmesh-runner-1.2.3.tgz"));
    await assert.rejects(checkReleaseAssets(assets), /release_privacy_email_rejected/u);
  });
});
test("stable and prerelease workflows cannot bypass publication privacy scans", async () => {
  const stable = await readFile(join(sourceRoot, ".github/workflows/release.yml"), "utf8");
  const dev = await readFile(join(sourceRoot, ".github/workflows/dev-release.yml"), "utf8");
  assert.deepEqual(validateReleasePrivacyWiring(stable, dev), { stable: true, development: true });
  const drops = [
    [stable.replace(/^.*run: node scripts\/check-release-privacy\.mjs source.*\n/mu, ""), dev],
    [stable.replace(/^.*run: node scripts\/check-release-privacy\.mjs assets.*\n/mu, ""), dev],
    [stable.replace("'tagger[email]=git@aloneio.aleeas.com'", "'tagger[email]=someone@example.net'"), dev],
    [stable, dev.replace(/^.*run: node scripts\/check-release-privacy\.mjs source.*\n/mu, "")],
    [stable, dev.replace(/^.*run: node scripts\/check-release-privacy\.mjs assets.*\n/mu, "")],
    [stable, dev.replace("        if: steps.publication-preflight.outputs.already_published != 'true'\n        run: node scripts/check-release-privacy.mjs assets", "        if: false\n        run: node scripts/check-release-privacy.mjs assets")],
  ];
  for (const [s, d] of drops) assert.throws(() => validateReleasePrivacyWiring(s, d));
});
