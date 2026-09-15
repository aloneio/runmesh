import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const folder of ["apps/worker/src", "apps/runner/src", "packages/protocol/src", "scripts"])
    await mkdir(join(root, folder), { recursive: true });
  for (const file of ["check-architecture.mjs", "architecture-graph.mjs", "architecture-policy.mjs"]) {
    try { await cp(join(project, "scripts", file), join(root, "scripts", file)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await symlink(join(project, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const [file, text] of Object.entries(sources)) {
    await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), text);
  }
  return { root, run: () => spawnSync(process.execPath, [join(root, "scripts/check-architecture.mjs")], { cwd: root, encoding: "utf8", timeout: 15000 }) };
}

const bad = [
  ["Worker to Runner", { "apps/worker/src/a.ts": 'import "../../runner/src/b.js";', "apps/runner/src/b.ts": "export {};" }],
  ["Runner to Worker", { "apps/runner/src/a.ts": 'export * from "../../worker/src/b.js";', "apps/worker/src/b.ts": "export {};" }],
  ["protocol reverse import", { "packages/protocol/src/a.ts": 'import "../../../apps/runner/src/b.js";', "apps/runner/src/b.ts": "export {};" }],
  ["dynamic reverse import", { "packages/protocol/src/a.ts": 'void import("../../../apps/worker/src/b.js");', "apps/worker/src/b.ts": "export {};" }],
  ["protocol Node import", { "packages/protocol/src/a.ts": 'import { readFile } from "node:fs/promises";' }],
  ["bare Node built-in", { "packages/protocol/src/a.ts": 'export * from "fs";' }],
  ["Worker Node side effect", { "apps/worker/src/a.ts": 'require("node:child_process");' }],
  ["runtime cycle", { "apps/runner/src/a.ts": 'import "./b.js";', "apps/runner/src/b.ts": 'import "./a.js";' }],
  ["computed dynamic import", { "apps/runner/src/a.ts": 'const path = "./other.js"; void import(path);' }],
  ["template dynamic import", { "apps/runner/src/a.ts": 'void import(`./${name}.js`);' }],
  ["type reverse import", { "packages/protocol/src/a.ts": 'type A = import("../../../apps/worker/src/b.js").B;', "apps/worker/src/b.ts": "export type B = string;" }],
  ["package cross-app import", { "apps/worker/src/a.ts": 'import "@aloneio/runmesh-runner";', "apps/runner/src/index.ts": "export {};" }],
  ["unresolved source", { "apps/runner/src/a.ts": 'import "./missing.js";' }],
  ["syntax failure", { "apps/runner/src/a.ts": 'import {' }],
  ["configuration to installer", { "apps/worker/src/runtime-config.ts": 'import "./installer.js";', "apps/worker/src/installer.ts": "export {};" }],
  ["contract to implementation", { "apps/worker/src/contracts/selection.ts": 'import type { X } from "../registry.js";', "apps/worker/src/registry.ts": "export type X = string;" }],
  ["MCP concrete transport type", { "apps/worker/src/mcp/server.ts": 'import type { Env } from "../runner-do.js";', "apps/worker/src/runner-do.ts": "export type Env = {};" }],
  ["MCP concrete Registry type", { "apps/worker/src/mcp/server.ts": 'import type { State } from "../registry.js";', "apps/worker/src/registry.ts": "export type State = {};" }],
  ["retired runtime setting", { "apps/runner/src/a.ts": 'export const x = "RUNMESH_SCHEMA_READY";' }],
];
for (const [name, sources] of bad) test(`AR01 rejects ${name}`, async t => {
  const f = await fixture(t, sources), result = f.run();
  assert.notEqual(result.status, 0, `${name} incorrectly passed: ${result.stdout}`);
  assert.match(result.stderr, /Architecture check failed/);
});

test("AR01 accepts same-layer imports and reports type cycles independently", async t => {
  const f = await fixture(t, {
    "packages/protocol/src/index.ts": 'export type { A } from "./a.js";',
    "packages/protocol/src/a.ts": 'import type { B } from "./b.js"; export type A = {b?: B};',
    "packages/protocol/src/b.ts": 'import { type A } from "./a.js"; export type B = {a?: A};',
    "apps/worker/src/a.ts": 'import type { A } from "@aloneio/runmesh-protocol"; export type C = A; type D = import("@aloneio/runmesh-protocol").A;',
    "apps/runner/src/a.ts": 'import { readFile } from "node:fs/promises"; void import("./b.js");',
    "apps/runner/src/b.ts": 'export const message = "import(unknownPath)"; // import "../../worker/src/a.js"',
  });
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"runtime_cycles":0/); assert.match(result.stdout, /"type_cycles":1/);
});

test("AR01 side-effect imports are runtime edges, not type-only edges", async t => {
  const f = await fixture(t, { "apps/runner/src/a.ts": 'import {} from "./b.js";', "apps/runner/src/b.ts": 'export * from "./a.js";' });
  assert.notEqual(f.run().status, 0);
});

test("AR01 build gates are required in both hosted CI definitions and parity checking", async () => {
  for (const path of [".github/workflows/ci.yml", ".gitlab-ci.yml", "scripts/check-ci-parity.mjs"])
    assert.match(await readFile(join(project, path), "utf8"), /npm run check:architecture/, `${path} omits the architecture gate`);
});

test("AR01 source symlinks cannot silently bypass module discovery", async t => {
  const f = await fixture(t, { "outside.ts": "export {};" });
  try { await symlink(join(f.root, "outside.ts"), join(f.root, "packages/protocol/src/alias.ts")); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") return t.skip("Host does not grant file symlink creation"); throw error; }
  assert.notEqual(f.run().status, 0);
});

test("AR03 narrow contracts and platform types need no concrete adapter dependency", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/selection.ts": "export type Selection = {id: string};",
    "apps/worker/src/platform/env.ts": "export interface Env { readonly name: string }",
    "apps/worker/src/public-origin.ts": "export const canonical = (value: string) => new URL(value).origin;",
    "apps/worker/src/runtime-config.ts": 'import { canonical } from "./public-origin.js"; export const value=canonical;',
    "apps/worker/src/mcp/server.ts": 'import type { Selection } from "../contracts/selection.js"; import type { Env } from "../platform/env.js"; export type Input = [Selection, Env];',
  });
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
});
