import { parse } from "@babel/parser";
import { checkArchitecture } from "../scripts/architecture-graph.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkCommand } from "../scripts/ci-contract.mjs";

const project = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  for (const folder of ["apps/worker/src", "apps/worker/browser", "apps/runner/src", "packages/protocol/src", "scripts"])
    await mkdir(join(root, folder), { recursive: true });
  for (const file of ["check-architecture.mjs", "architecture-graph.mjs", "architecture-policy.mjs", "central-architecture-policy.mjs"]) {
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
  ["managed OAuth contracts to SDK", { "apps/worker/src/contracts/managed-oauth.ts": 'import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";' }],
  ["managed connection contracts to platform globals", { "apps/worker/src/contracts/managed-connections.ts": 'export const request = globalThis.fetch;' }],
  ["managed OAuth use case to protocol adapter", { "apps/worker/src/application/connectors/managed-oauth.ts": 'import "../../platform/connectors/managed-oauth.js";', "apps/worker/src/platform/connectors/managed-oauth.ts": 'export {};' }],
  ["managed OAuth protocol to storage", { "apps/worker/src/platform/connectors/managed-oauth.ts": 'import type { State } from "./managed-store.js";', "apps/worker/src/platform/connectors/managed-store.ts": 'export type State = {};' }],
  ["managed OAuth protocol to cipher", { "apps/worker/src/platform/connectors/managed-oauth.ts": 'import "./oauth-crypto.js";', "apps/worker/src/platform/connectors/oauth-crypto.ts": 'export {};' }],
  ["managed OAuth storage to SDK", { "apps/worker/src/platform/connectors/managed-store.ts": 'import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";' }],
  ["managed OAuth storage to SDK intermediary", { "apps/worker/src/platform/connectors/managed-store.ts": 'import type { Metadata } from "./provider-types.js";', "apps/worker/src/platform/connectors/provider-types.ts": 'export type Metadata = {};' }],
  ["OAuth contracts to SDK", { "apps/worker/src/contracts/oauth.ts": 'import { Client } from "@modelcontextprotocol/client";' }],
  ["OAuth rules to native Runner state", { "apps/worker/src/application/connectors/oauth.ts": 'import "../../runner-do.js";', "apps/worker/src/runner-do.ts": "export {};" }],
  ["remote capability to OAuth persistence", { "apps/worker/src/application/capabilities/remote-call.ts": 'import "../../platform/connectors/managed-store.js";', "apps/worker/src/platform/connectors/managed-store.ts": "export {};" }],
  ["remote contract to client SDK", { "apps/worker/src/contracts/remote.ts": 'import type { Client } from "@modelcontextprotocol/client";' }],
  ["remote invocation to concrete credential adapter", { "apps/worker/src/application/capabilities/remote-call.ts": 'import "../../platform/connectors/cipher.js";', "apps/worker/src/platform/connectors/cipher.ts": "export {};" }],
  ["remote provider to state owner", { "apps/worker/src/mcp/providers/remote.ts": 'import "../../capabilities-do.js";', "apps/worker/src/capabilities-do.ts": "export {};" }],
  ["remote request parser to network", { "apps/worker/src/contracts/remote-values.ts": 'export const connect = globalThis.fetch;' }],
  ["catalog schema contract to SDK", { "apps/worker/src/contracts/catalog-schema.ts": 'import "@modelcontextprotocol/client";' }],
  ["catalog reader to credential implementation", { "apps/worker/src/application/capabilities/catalog-read.ts": 'import "../../platform/connectors/cipher.js";', "apps/worker/src/platform/connectors/cipher.ts": "export {};" }],
  ["catalog rules to live HTTP", { "apps/worker/src/domain/capabilities/catalog.ts": 'export const discover = () => fetch("https://example.invalid");' }],
  ["catalog storage to native Runner state", { "apps/worker/src/platform/capabilities/catalog-store.ts": 'import "../../runner-do.js";', "apps/worker/src/runner-do.ts": "export {};" }],
  ["central owner to native application", { "apps/worker/src/capabilities-do.ts": 'import "./application/delete-runner.js";', "apps/worker/src/application/delete-runner.ts": "export {};" }],
  ["central application direct network", { "apps/worker/src/application/connectors/profiles.ts": 'export const request = () => fetch("https://example.invalid");' }],
  ["central contract helper platform global", { "apps/worker/src/contracts/connector-values.ts": 'export const request = globalThis.fetch;' }],
  ["central pure global fetch", { "apps/worker/src/domain/skills/import.ts": 'export const load = () => fetch("https://example.invalid");' }],
  ["central pure global alias", { "apps/worker/src/domain/connectors/check.ts": 'const root = globalThis; export const load = root["fetch"];' }],
  ["central contract to Runner wire", { "apps/worker/src/contracts/capabilities.ts": 'import type { Wire } from "@aloneio/runmesh-protocol";', "packages/protocol/src/index.ts": "export type Wire = {};" }],
  ["native code to central internals", { "apps/worker/src/mcp/server.ts": 'import "../platform/capabilities/owner.js";', "apps/worker/src/platform/capabilities/owner.ts": "export {};" }],
  ["unreviewed central directory without imports", { "apps/worker/src/skills/read.ts": 'export const read = () => "unchecked";' }],
  ["central dynamic code evaluation", { "apps/worker/src/platform/skills/load.ts": 'export const load = (source: string) => new Function(source);' }],
  ["central Skill to Runner shell", { "apps/worker/src/application/skills/read.ts": 'import "../../../../runner/src/jobs.js";', "apps/runner/src/jobs.ts": "export {};" }],
  ["central connector to RunnerDO", { "apps/worker/src/platform/connectors/client.ts": 'import "../../runner-do.js";', "apps/worker/src/runner-do.ts": "export {};" }],
  ["central feature peer internals", { "apps/worker/src/application/connectors/invoke.ts": 'import "../skills/read.js";', "apps/worker/src/application/skills/read.ts": "export {};" }],
  ["unreviewed central directories", { "apps/worker/src/connectors/client.ts": 'import "../skills/read.js";', "apps/worker/src/skills/read.ts": "export {};" }],
  ["central pure rule to SDK type", { "apps/worker/src/domain/connectors/validate.ts": 'import type { Client } from "@modelcontextprotocol/client";' }],
  ["central rule to environment type", { "apps/worker/src/domain/capabilities/grants.ts": 'import type { WorkerEnv } from "../../platform/env.js";', "apps/worker/src/platform/env.ts": "export type WorkerEnv = {};" }],
  ["central use case to concrete storage", { "apps/worker/src/application/skills/read.ts": 'import "../../platform/skills/store.js";', "apps/worker/src/platform/skills/store.ts": "export {};" }],
  ["central Skill process execution", { "apps/worker/src/platform/skills/import.ts": 'import { spawn } from "node:child_process";' }],
  ["central MCP provider to application", { "apps/worker/src/mcp/providers/remote.ts": 'import "../../application/connectors/invoke.js";', "apps/worker/src/application/connectors/invoke.ts": "export {};" }],
  ["central connector to Runner wire contract", { "apps/worker/src/domain/connectors/state.ts": 'import type { Wire } from "@aloneio/runmesh-protocol";', "packages/protocol/src/index.ts": "export type Wire = {};" }],
  ["stdin delivery to filesystem", { "apps/runner/src/jobs/input.ts": 'import { readFile } from "node:fs/promises";' }],
  ["stdin delivery to process adapter", { "apps/runner/src/jobs/input.ts": 'import "./process.js";', "apps/runner/src/jobs/process.ts": "export {};" }],
  ["stdin delivery to storage adapter", { "apps/runner/src/jobs/input.ts": 'import "./storage.js";', "apps/runner/src/jobs/storage.ts": "export {};" }],
  ["stdin delivery loads stream implementation", { "apps/runner/src/jobs/input.ts": 'import { Writable } from "node:stream";' }],
  ["service adapter to service facade", { "apps/runner/src/services/systemd.ts": 'import "../service.js";', "apps/runner/src/service.ts": "export {};" }],
  ["command to CLI facade", { "apps/runner/src/cli/doctor.ts": 'import "../cli.js";', "apps/runner/src/cli.ts": "export {};" }],
  ["patch planner to file mutator", { "apps/runner/src/patch/parse.ts": 'import "./files.js";', "apps/runner/src/patch/files.ts": "export {};" }],
  ["browser to Worker application", { "apps/worker/browser/main.js": 'import "../src/application/delete-runner.js";', "apps/worker/src/application/delete-runner.ts": "export {};" }],

  ["Registry to admin view", { "apps/worker/src/registry/auth.ts": 'import "../admin/client-views.js";', "apps/worker/src/admin/client-views.ts": "export {};" }],
  ["Registry to HTTP", { "apps/worker/src/registry/auth.ts": 'import "../http/html-response.js";', "apps/worker/src/http/html-response.ts": "export {};" }],
  ["view to Registry facade type", { "apps/worker/src/admin/view-models.ts": 'import type { X } from "../registry.js";', "apps/worker/src/registry.ts": "export type X = string;" }],
  ["view to Registry records", { "apps/worker/src/admin/view-models.ts": 'export type { X } from "../registry/records.js";', "apps/worker/src/registry/records.ts": "export type X = string;" }],
  ["use case to HTTP", { "apps/worker/src/application/example.ts": 'void import("../http/input.js");', "apps/worker/src/http/input.ts": "export {};" }],
  ["projection to dispatch", { "apps/worker/src/mcp/results/files.ts": 'import "../dispatch.js";', "apps/worker/src/mcp/dispatch.ts": "export {};" }],
  ["renamed wrapper cannot bypass domain boundary", { "apps/worker/src/registry/auth.ts": 'import "../renamed.js";', "apps/worker/src/renamed.ts": 'export * from "./admin/format.js";', "apps/worker/src/admin/format.ts": "export {};" }],
  ["Job adapter to manager", { "apps/runner/src/jobs/storage.ts": 'import "../jobs.js";', "apps/runner/src/jobs.ts": "export {};" }],
  ["Context adapter to facade", { "apps/runner/src/context/repository.ts": 'import "../context-store.js";', "apps/runner/src/context-store.ts": "export {};" }],
  ["log reader to process executor", { "apps/runner/src/jobs/logs.ts": 'import "./process.js";', "apps/runner/src/jobs/process.ts": "export {};" }],
  ["Context model to file adapter", { "apps/runner/src/context/model.ts": 'import "./files.js";', "apps/runner/src/context/files.ts": "export {};" }],
  ["pure planner to inventory adapter", { "apps/runner/src/context/retention-plan.ts": 'import type { Inventory } from "../context-storage.js";', "apps/runner/src/context-storage.ts": "export type Inventory = {};" }],
  ["pure planner filesystem access", { "apps/runner/src/context/retention-plan.ts": 'import { readFile } from "node:fs/promises";' }],
  ["pure Job model process access", { "apps/runner/src/jobs/records.ts": 'import { spawn } from "node:child_process";' }],
  ["Runner ports to concrete adapter", { "apps/runner/src/jobs/ports.ts": 'import type { State } from "./storage.js";', "apps/runner/src/jobs/storage.ts": "export type State = {};" }],
  ["Registry domain to facade", { "apps/worker/src/registry/auth.ts": 'import { RegistryDO } from "../registry.js";', "apps/worker/src/registry.ts": "export class RegistryDO {}" }],
  ["Registry domain to concrete peer", { "apps/worker/src/registry/auth.ts": 'import { RegistryPolicy } from "./policy.js";', "apps/worker/src/registry/policy.ts": "export class RegistryPolicy {}" }],
  ["Registry contract to implementation", { "apps/worker/src/registry/ports.ts": 'import type { RegistryAuth } from "./auth.js";', "apps/worker/src/registry/auth.ts": "export class RegistryAuth {}" }],
  ["Registry domain to remote history adapter", { "apps/worker/src/registry/history.ts": 'import { PackedJobHistory } from "../job-history-store.js";', "apps/worker/src/job-history-store.ts": "export class PackedJobHistory {}" }],
  ["Registry domain to MCP handler", { "apps/worker/src/registry/policy.ts": 'import "../mcp/server.js";', "apps/worker/src/mcp/server.ts": "export {};" }],
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

test("architecture rejects type-only cycles without confusing them with runtime cycles", async t => {
  const f = await fixture(t, {
    "packages/protocol/src/index.ts": 'export type { A } from "./a.js";',
    "packages/protocol/src/a.ts": 'import type { B } from "./b.js"; export type A = {b?: B};',
    "packages/protocol/src/b.ts": 'import { type A } from "./a.js"; export type B = {a?: A};',
    "apps/worker/src/a.ts": 'import type { A } from "@aloneio/runmesh-protocol"; export type C = A; type D = import("@aloneio/runmesh-protocol").A;',
    "apps/runner/src/a.ts": 'import { readFile } from "node:fs/promises"; void import("./b.js");',
    "apps/runner/src/b.ts": 'export const message = "import(unknownPath)"; // import "../../worker/src/a.js"',
  });
  const report = await checkArchitecture(f.root);
  assert.equal(report.runtimeCycles.length, 0); assert.equal(report.typeCycles.length, 1);
  assert.ok(report.failures.some(value => value.includes("type-inclusive dependency cycle")));
  assert.notEqual(f.run().status, 0);
});

test("W01 composition injects central public ports without widening native dependencies", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/capabilities.ts": 'export type Port = { read(id: string): Promise<string> };',
    "apps/worker/src/domain/capabilities/grants.ts": 'export const enabled = (value: boolean) => value;',
    "apps/worker/src/application/capabilities/access.ts": 'import type { Port } from "../../contracts/capabilities.js"; import { enabled } from "../../domain/capabilities/grants.js"; export const create = (port: Port) => port;',
    "apps/worker/src/platform/capabilities/owner.ts": 'import "cloudflare:workers"; import type { Port } from "../../contracts/capabilities.js"; export type Adapter = Port;',
    "apps/worker/src/http/central.ts": 'import { create } from "../application/capabilities/access.js"; import "../platform/capabilities/owner.js";',
    "apps/worker/src/mcp/providers/remote.ts": 'import type { Port } from "../../contracts/capabilities.js"; export const bind = (port: Port) => port;',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

test("AR01 side-effect imports are runtime edges, not type-only edges", async t => {
  const f = await fixture(t, { "apps/runner/src/a.ts": 'import {} from "./b.js";', "apps/runner/src/b.ts": 'export * from "./a.js";' });
  assert.notEqual(f.run().status, 0);
});

test("AR01 build gates are required in both hosted CI definitions and parity checking", async () => {
  for (const path of [".github/workflows/ci.yml", ".gitlab-ci.yml"])
    assert.ok((await readFile(join(project, path), "utf8")).includes(checkCommand("architecture")), `${path} omits the architecture gate`);
  assert.ok((await readFile(join(project, "scripts/check-ci-parity.mjs"), "utf8")).includes("validateCiWiring"), "parity checker must validate the parsed CI contract");
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

for (const extension of ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"]) {
  test(`AR09 platform boundaries include ${extension} modules and type imports`, async t => {
    const f = await fixture(t, {
      [`apps/worker/src/domain/new-rule.${extension}`]: 'import "cloudflare:workers";',
      [`apps/runner/src/jobs/new-planner.${extension}`]: 'import "dgram";',
    });
    const report = await checkArchitecture(f.root);
    assert.ok(report.failures.some(value => value.includes("Cloudflare platform")));
    assert.ok(report.failures.some(value => value.includes("record and planning")));
  });
}
for (const specifier of ["fs/promises", "node:fs/promises", "dgram", "dns/promises", "node:test", "timers/promises", "ws"]) {
  test(`AR09 newly named planners reject ${specifier}`, async t => {
    const f = await fixture(t, { "apps/runner/src/context/pure/renamed.ts": `import "${specifier}";` });
    assert.notEqual((await checkArchitecture(f.root)).failures.length, 0);
  });
}
test("AR09 pure Worker roles reject external platform types and renamed barrels", async t => {
  const f = await fixture(t, {
    "apps/worker/src/contracts/renamed.mts": 'import type { DurableObject } from "cloudflare:workers";',
    "apps/worker/src/domain/rules.ts": 'export * from "./new-wrapper.js";',
    "apps/worker/src/domain/new-wrapper.ts": 'export * from "@cloudflare/workers-types";',
    "apps/worker/browser/view.js": 'import "@modelcontextprotocol/server";',
    "apps/runner/src/jobs/ports.ts": 'import "fs";',
  });
  const report = await checkArchitecture(f.root);
  for (const name of ["renamed.mts", "new-wrapper.ts", "view.js", "ports.ts"]) assert.ok(report.failures.some(value => value.includes(name)), name);
});
test("AR09 reviewed adapters, pure hashing and platform type ports remain legal", async t => {
  const f = await fixture(t, {
    "apps/worker/src/platform/native.ts": 'import "cloudflare:workers";',
    "apps/worker/src/mcp/sdk.ts": 'import "@modelcontextprotocol/server";',
    "apps/runner/src/jobs/pure/fingerprint.mts": 'import { createHash } from "node:crypto";',
    "apps/runner/src/jobs/ports.ts": 'import type { FileHandle } from "fs/promises";',
    "apps/runner/src/jobs/storage.ts": 'import "node:fs/promises";',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});

for (const [from,to] of [
  ["connection/ports.ts","runtime.ts"], ["connection/policy-candidate.ts","connection.ts"],
  ["connection/job-events.ts","jobs.ts"], ["jobs/retention-plan.ts","jobs/storage.ts"],
]) test(`AR10/AR13 rejects ${from} importing ${to}`,async t=>{
  const prefix="apps/runner/src/", parts=from.split("/").length-1;
  const f=await fixture(t,{[prefix+from]:`import type { State } from "${"../".repeat(parts)}${to.replace(/\.ts$/u,".js")}";`,[prefix+to]:"export type State = {};"});
  assert.notEqual((await checkArchitecture(f.root)).failures.length,0);
});

test("AR10 connection ports may reference WebSocket types but cannot load ws",async t=>{
  const legal=await fixture(t,{"apps/runner/src/connection/ports.ts":'import type WebSocket from "ws";'});
  assert.deepEqual((await checkArchitecture(legal.root)).failures,[]);
  const illegal=await fixture(t,{"apps/runner/src/connection/ports.ts":'import WebSocket from "ws";'});
  assert.ok((await checkArchitecture(illegal.root)).failures.some(value=>value.includes("Connection ports")));
});


for (const [name, sources] of [
  ["Patch parser filesystem", { "apps/runner/src/patch/parse.ts": 'import "node:fs/promises";' }],
  ["Patch renderer bare filesystem", { "apps/runner/src/patch/preview.ts": 'import "fs/promises";' }],
  ["renamed Patch TypeScript module", { "apps/runner/src/patch/new-planner.mts": 'export * from "node:child_process";' }],
  ["nested Patch JSX module", { "apps/runner/src/patch/nested/view.tsx": 'import type { Stats } from "node:fs";' }],
  ["Connection failure network", { "apps/runner/src/connection/failures.ts": 'import "node:net";' }],
  ["Connection Job projection SDK", { "apps/runner/src/connection/job-events.ts": 'import "ws";' }],
  ["new Connection module", { "apps/runner/src/connection/new.cjs": 'require("node:fs");' }],
  ["Patch type through concrete resolver", { "apps/runner/src/patch/contracts.ts": 'import type { T } from "../path-policy.js";', "apps/runner/src/path-policy.ts": 'export type T = string;' }],
  ["Patch intermediary", { "apps/runner/src/patch/parse.ts": 'export * from "./renamed.js";', "apps/runner/src/patch/renamed.ts": 'import "node:fs";' }],
  ["Patch barrel to adapter", { "apps/runner/src/patch/parse.ts": 'export * from "./barrel.js";', "apps/runner/src/patch/barrel.ts": 'export * from "./files.js";', "apps/runner/src/patch/files.ts": 'export {};' }],
  ["release core to installer", { "apps/worker/src/distribution/release.ts": 'import "../installer.js";', "apps/worker/src/installer.ts": 'export {};' }],
  ["release model to network adapter", { "apps/worker/src/domain/release-selection.ts": 'import "../distribution/release-io.js";', "apps/worker/src/distribution/release-io.ts": 'export {};' }],
]) test(`AR15/AR17 rejects ${name}`, async t => {
  const f = await fixture(t, sources);
  const result = await checkArchitecture(f.root);
  assert.ok(result.failures.length > 0, `${name} incorrectly passed`);
});

test("AR17 preserves reviewed Patch adapters, pure hash/path helpers and data contracts", async t => {
  const f = await fixture(t, {
    "apps/runner/src/patch/files.ts": 'import "node:fs/promises"; import "./contracts.js";',
    "apps/runner/src/patch/preview.ts": 'import "node:crypto"; import "node:path"; import type { P } from "./contracts.js";',
    "apps/runner/src/patch/contracts.ts": 'export type { P } from "../path-contracts.js";',
    "apps/runner/src/path-contracts.ts": 'export type P = { readonly path: string };',
    "apps/runner/src/connection/policy-candidate.ts": 'import "node:fs/promises";',
    "apps/runner/src/connection/ports.ts": 'import type WebSocket from "ws";',
    "apps/runner/src/connection/failures.ts": 'export const classify = (code: number) => code === 401;',
  });
  assert.deepEqual((await checkArchitecture(f.root)).failures, []);
});


test("AR18 prevents retired private I/O mocks from returning", async () => {
  function visit(node, callback) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child, callback); return; }
    callback(node);
    for (const [key, child] of Object.entries(node)) if (!["loc", "start", "end", "extra", "comments"].includes(key)) visit(child, callback);
  }
  const parseTest = source => parse(source, { sourceType: "module", plugins: ["typescript"] });
  const property = node => node?.computed ? node.property?.value : node?.property?.name;
  for (const name of ["concurrency", "enrollment-fence-recovery", "job-reporting-bridge"]) {
    const source = await readFile(join(project, `apps/worker/test/${name}.test.ts`), "utf8");
    visit(parseTest(source), node => {
      if (node.type === "AssignmentExpression") assert.notEqual(property(node.left), "registryRequest", `${name}: use the injected RegistryRequestPort`);
    });
  }
  // These exact pre-enqueue/post-coordinator races are not equivalent to a
  // file fault. Keep them explicit rather than weakening their assertions.
  const remaining = new Set([
    "waits for fast-exit terminal metadata before returning from start",
    "does not let a late running metadata write overwrite terminal state",
    "does not overwrite a queued cancellation after a spawn setup failure races",
    "does not signal a local PID after the child exits during cancellation persistence",
  ]);
  const found = new Set();
  const runtime = parseTest(await readFile(join(project, "apps/runner/test/runtime.test.ts"), "utf8"));
  visit(runtime, node => {
    if (node.type !== "CallExpression" || node.callee?.name !== "it" || node.arguments[0]?.type !== "StringLiteral") return;
    const name = node.arguments[0].value;
    visit(node.arguments[1], child => {
      if (child.type !== "AssignmentExpression" || property(child.left) !== "persist") return;
      assert.ok(remaining.has(name), `${name}: inject JobFilePort rather than replacing persistence coordination`);
      found.add(name);
    });
  });
  assert.deepEqual([...found].sort(), [...remaining].sort(), "review the documented exceptions when retiring a coordinator-only race");
});

test("stdin delivery accepts stream types without broadening planner permissions", async () => {
  const { specifierProblem } = await import("../scripts/architecture-policy.mjs");
  assert.equal(specifierProblem("apps/runner/src/jobs/input.ts", "node:stream", true), undefined);
  assert.ok(specifierProblem("apps/runner/src/jobs/records.ts", "node:stream", true));
});
