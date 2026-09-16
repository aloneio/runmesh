import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, basename, join } from "node:path";
import { bundleRunner } from "../build-runner-bundle.mjs";
import { buildDevelopmentManifest, releaseArtifactName } from "../release-manifest.mjs";
import { assertSource, command, readPlan, root } from "./io.mjs";

assert.equal(process.argv.length, 3, "Pass the frozen dev plan");
const plan = await readPlan(process.argv[2]); await assertSource(plan);
const npm = process.env.npm_execpath;
assert.ok(npm && isAbsolute(npm) && basename(npm) === "npm-cli.js", "Invoke through npm run build:dev-release");
// Build existing declarations and default bundles first. The shared bundler
// then overrides only the ignored distribution files for this planned version.
// A separate Actions job starts from a fresh checkout: generate Worker build
// inputs too, rather than relying on files left behind by source verification.
await command(process.execPath, [npm, "run", "build"]);
await command(process.execPath, [npm, "run", "prepack", "--workspace=@aloneio/runmesh-runner"]);
for (const [entry, output] of [["runmesh-entry.ts", "runmesh.cjs"], ["config.ts", "config.cjs"], ["index.ts", "index.bundle.cjs"]]) {
  await bundleRunner(join(root, "apps/runner/src", entry), join(root, "apps/runner/dist", output), "cjs", plan.version);
}
const stage = join(root, ".dev-release/package"), assets = join(root, ".dev-release/assets");
await mkdir(stage); await mkdir(assets);
await cp(join(root, "apps/runner/dist"), join(stage, "dist"), { recursive: true, errorOnExist: true, force: false });
for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await cp(join(root, "apps/runner", name), join(stage, name));
const sourceManifest = JSON.parse(await readFile(join(root, "apps/runner/package.json"), "utf8"));
assert.equal(Object.keys(sourceManifest.dependencies ?? {}).length, 0, "portable Runner must remain self-contained");
const { scripts: _scripts, devDependencies: _dev, ...metadata } = sourceManifest;
await writeFile(join(stage, "package.json"), JSON.stringify({ ...metadata, version: plan.version, files: [...metadata.files, "build-inputs.json"] }, null, 2) + "\n");
await writeFile(join(stage, "build-inputs.json"), JSON.stringify(plan, null, 2) + "\n");
await command(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", assets], { cwd: stage });
const archives = (await readdir(assets)).filter(name => name.endsWith(".tgz")); assert.equal(archives.length, 1);
await rename(join(assets, archives[0]), join(assets, releaseArtifactName(plan.version)));
const manifest = await buildDevelopmentManifest({ releaseDirectory: assets, plan });
await writeFile(join(assets, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await assertSource(plan);
console.log(JSON.stringify({ version: plan.version, source_sha: plan.source_sha, artifact: manifest.artifacts[0], signed: false, published: false }));
