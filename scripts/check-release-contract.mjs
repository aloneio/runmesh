import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../apps/worker/src/installer.ts", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const fixed = /FIXED_RELEASE_VERSION = "([^"]+)"/.exec(source)?.[1];
assert.equal(fixed, root.version, "installer must match source version");
assert.notEqual(root.version, "0.1.0-dev.3", "security fixes cannot reuse the immutable dev.3 identity");
assert.equal(config.env.production.name, "runmesh");
const origin = new URL(config.env.production.vars.RUNMESH_PUBLIC_ORIGIN);
assert.equal(origin.protocol, "https:");
assert.equal(origin.origin, config.env.production.vars.RUNMESH_PUBLIC_ORIGIN);
assert.equal(config.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, undefined);
assert.notEqual(config.name, config.env.production.name);
for (const environment of [config, config.env.production]) {
  assert.deepEqual(environment.durable_objects.bindings.map((binding) => binding.class_name).sort(), ["RegistryDOv2", "RunnerDOv2"]);
  assert.ok(environment.migrations.some((migration) => migration.new_sqlite_classes?.includes("RegistryDOv2")));
}
const gate = config.env.production.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE;
assert.ok(gate === undefined || gate === "" || gate === root.version, "enabled gate must match release version");
if (process.argv.includes("--require-distributable")) assert.equal(gate, root.version, "activation requires separate signed-asset verification");
console.log(`release contract verified: ${root.version}; hosted distribution ${gate ? "enabled" : "disabled"}`);
