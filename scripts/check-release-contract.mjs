import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("../apps/worker/src/installer.ts", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const fixed = /FIXED_RELEASE_VERSION = "([^"]+)"/.exec(source)?.[1];
assert.equal(fixed, root.version, "installer must match source version");
assert.notEqual(root.version, "0.1.0-dev.3", "security fixes cannot reuse the immutable dev.3 identity");
assert.equal(config.name, "runmesh", "top-level Wrangler config is the canonical production Worker");
assert.equal(config.vars.WORKER_ID, "worker-production");
const origin = new URL(config.vars.RUNMESH_PUBLIC_ORIGIN);
assert.equal(origin.protocol, "https:");
assert.equal(origin.origin, config.vars.RUNMESH_PUBLIC_ORIGIN);
assert.equal(config.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, root.version, "top-level production gate must match the published release");
assert.equal(config.env.production.name, config.name, "named production alias must target the same Worker");
assert.deepEqual(config.env.production.vars, config.vars, "named production alias must mirror top-level production vars");
assert.equal(config.env.development.name, "runmesh-development");
assert.equal(config.env.development.vars.WORKER_ID, "worker-development");
assert.equal(config.env.development.vars.RUNMESH_PUBLIC_ORIGIN, "");
assert.equal(config.env.development.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, "");
for (const environment of [config, config.env.production, config.env.development]) {
  assert.deepEqual(environment.durable_objects.bindings.map((binding) => binding.class_name).sort(), ["RegistryDOv2", "RunnerDOv2"]);
  assert.ok(environment.migrations.some((migration) => migration.new_sqlite_classes?.includes("RegistryDOv2")));
}
if (process.argv.includes("--require-distributable")) assert.equal(config.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, root.version, "activation requires separate signed-asset verification");
console.log(`release contract verified: ${root.version}; top-level production distribution enabled; development disabled`);
