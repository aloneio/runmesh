import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { reviewedReleaseSource } from "./runtime-config-tools.mjs";
import { fileURLToPath } from "node:url";
import { checkStablePublication } from "./stable-publication.mjs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../apps/worker/src/installer.ts", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const fixed = /FIXED_RELEASE_VERSION = "([^"]+)"/.exec(source)?.[1];
const state=JSON.parse(readFileSync(new URL("../release/release-state.json",import.meta.url),"utf8"));
assert.equal(state.version,root.version);
assert.ok(["candidate","released"].includes(state.state),"explicit release lifecycle is required");
const expectedGate=state.state === "released" ? root.version : "";
if(state.state === "released") {
  assert.match(state.release_commit,/^[a-f0-9]{40}$/);
  assert.match(state.manifest_sha256,/^[a-f0-9]{64}$/);
}

assert.equal(fixed, root.version, "installer must match source version");
await checkStablePublication(fileURLToPath(new URL("../", import.meta.url)), root.version, undefined, false);
assert.notEqual(root.version, "0.1.0-dev.3", "security fixes cannot reuse the immutable dev.3 identity");
assert.equal(config.name, "runmesh", "top-level Wrangler config is the canonical production Worker");
assert.deepEqual(config.vars, {}, "ordinary production deployment must not require plaintext runtime settings");
assert.equal(readFileSync(new URL("../apps/worker/src/generated-release.ts", import.meta.url), "utf8"), reviewedReleaseSource(root.version, state), "compiled activation must match reviewed publication evidence");
assert.equal(config.env.production.name, config.name, "named production alias must target the same Worker");
assert.deepEqual(config.env.production.vars, config.vars, "named production alias must mirror top-level production vars");
assert.equal(config.env.development.name, "runmeshdev");
assert.deepEqual(config.env.development.vars, { RUNMESH_ENVIRONMENT: "development" });
for (const environment of [config, config.env.production, config.env.development]) {
  assert.deepEqual(environment.durable_objects.bindings.map((binding) => binding.class_name).sort(), ["RegistryDOv2", "RunnerDOv2"]);
  if (environment.name === "runmesh") {
    assert.equal(environment.main,"src/production.ts");
    assert.equal(environment.migrations,undefined,"production must retain declarative lifecycle after cutover");
    assert.deepEqual(environment.exports,{
      RegistryDOv2:{type:"durable-object",storage:"sqlite"},RunnerDOv2:{type:"durable-object",storage:"sqlite"},
      RegistryDO:{type:"durable-object",state:"deleted"},RunnerDO:{type:"durable-object",state:"deleted"},
    },"retirement is limited to the two approved old production classes");
  } else {
    assert.equal(environment.main,"src/index.ts");assert.deepEqual(environment.exports,{});
    assert.ok(environment.migrations.some((migration) => migration.new_sqlite_classes?.includes("RegistryDOv2")));
  }
}
if (process.argv.includes("--require-distributable")) assert.equal(expectedGate, root.version, "activation requires separate signed-asset verification");
console.log(`release contract verified: ${root.version}; state=${state.state}; distribution=${expectedGate ? "enabled" : "disabled"}; development disabled`);
