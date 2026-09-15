import assert from "node:assert/strict";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { dependencies } from "./architecture-graph.mjs";

export const TEST_ROOTS = ["packages/protocol/test", "apps/runner/test", "apps/worker/test", "test"];
const PREFIXES = { protocol: "packages/protocol/test/", runner: "apps/runner/test/", worker: "apps/worker/test/",
  domain: "test/domain/", contracts: "test/contracts/", tooling: "test/", presentation: "test/", transport: "test/e2e/" };
const testPath = /^[A-Za-z0-9._/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const pureExternal = new Set(["vitest", "zod", "node:crypto"]);

/** Inventory is a test ownership declaration, never execution evidence. */
export async function inventoryTests(root) {
  const out = []; let entries = 0;
  async function walk(path) {
    for (const item of await readdir(join(root, path), { withFileTypes: true })) {
      assert.ok(++entries <= 10000, "test inventory entry budget exceeded");
      const file = `${path}/${item.name}`;
      assert.ok(!item.isSymbolicLink(), "test inventory must not follow symlinks");
      if (item.isDirectory()) await walk(file);
      else if (item.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) out.push(file);
    }
  }
  for (const path of TEST_ROOTS) await walk(path);
  return out.sort();
}

export function validateTestPlan(plan, actual) {
  assert.equal(plan?.schema_version, 1, "unsupported verification plan");
  assert.ok(Array.isArray(plan.groups) && plan.groups.length === Object.keys(PREFIXES).length, "missing test layers");
  const ids = new Set(), declared = [];
  for (const group of plan.groups) {
    assert.ok(Object.hasOwn(PREFIXES, group.id) && !ids.has(group.id), "unknown or duplicate test group"); ids.add(group.id);
    assert.equal(typeof group.description, "string");
    assert.ok(Array.isArray(group.files) && group.files.length > 0, "empty test group");
    for (const file of group.files) {
      assert.ok(typeof file === "string" && testPath.test(file) && !file.split("/").includes(".."), "unsafe test path");
      assert.ok(file.startsWith(PREFIXES[group.id]), "test assigned to a different runtime layer");
      if (["tooling", "presentation"].includes(group.id)) assert.equal(file.split("/").length, 2, "root Node tests must not hide integration tests");
      declared.push(file);
    }
  }
  assert.equal(new Set(declared).size, declared.length, "test file assigned more than once");
  assert.deepEqual([...declared].sort(), [...actual].sort(), "test inventory changed: classify new tests, preserve existing regressions");
  assert.deepEqual(plan.external_checks, ["signed_release", "production", "account_quotas", "host_catalog"], "external verification must remain separate");
  return { groups: ids.size, files: declared.length };
}

/** Owning a test in the manifest is not sufficient if its command omits it. */
export function validateTestWiring(plan, pkg, github, gitlab) {
  for (const group of plan.groups.filter(g => ["tooling", "presentation"].includes(g.id))) {
    const script = pkg.scripts[group.id === "tooling" ? "test:release-tools" : "test:unit"] ?? "";
    const args = script.split(/\s+/u).map(arg => arg.replace(/^\.\//u, ""));
    for (const file of group.files) assert.ok(args.includes(file), "classified Node test missing from its executable command");
  }
  for (const command of ["test:domain", "test:contracts"]) assert.ok(pkg.scripts["test:unit"].includes(`npm run ${command}`), "layer missing from aggregate verification");
  for (const config of [github, gitlab]) {
    for (const command of ["check:verification", "check:docs", "test:unit", "test:release-tools", "test:e2e", "test:package:e2e"]) {
      assert.ok(config.split("\n").some(line => new RegExp(`^\\s*- (?:run: )?npm run ${command}\\s*$`, "u").test(line)), "critical verification command absent from CI execution");
    }
  }
}

/** Source-only guard for the new domain lane. Crypto is computation; disk,
 * subprocess, networking and platform adapters belong in other test layers.
 * Not a sandbox or an audit of third-party dependency implementations.
 */
export async function checkDomainImports(root, files) {
  const visited = new Set(), pending = [...files];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    assert.ok(visited.size < 256, "domain import budget exceeded"); visited.add(file);
    const stat = await lstat(join(root, file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1048576, "invalid domain source");
    const text = await readFile(join(root, file), "utf8");
    if (file.startsWith("test/domain/")) assert.ok(!/\bas\s+(?:any\b|unknown\s+as\b)|\b(?:setTimeout|setInterval|fetch|require)\s*\(/u.test(text), "domain tests must use public seams, not private casts or side effects");
    for (const edge of dependencies(text, file)) {
      if (edge.typeOnly) continue;
      assert.equal(typeof edge.specifier, "string", "computed domain import");
      let target;
      if (edge.specifier === "@aloneio/runmesh-protocol") target = "packages/protocol/src/index.ts";
      else if (edge.specifier.startsWith(".")) {
        target = posix.normalize(posix.join(posix.dirname(file), edge.specifier)).replace(/\.js$/u, ".ts");
        assert.ok(!target.startsWith("../") && /^(?:apps\/(?:worker|runner)\/src|packages\/protocol\/src|test\/domain)\//u.test(target), "domain dependency outside reviewed source");
      } else assert.ok(pureExternal.has(edge.specifier), "domain dependency requires an external side effect/runtime");
      if (target) pending.push(target);
    }
  }
  return visited.size;
}
