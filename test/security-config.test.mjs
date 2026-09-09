import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("default Worker configuration cannot accidentally select production or enable hosted bootstrap", async () => {
  const source = await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  assert.notEqual(config.name, config.env.production.name);
  assert.equal(config.vars.WORKER_ID, "worker-development");
  assert.equal(config.vars.RUNMESH_PUBLIC_ORIGIN, undefined);
  assert.equal(config.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, undefined);
  assert.equal(config.env.production.name, "runmesh");
  assert.equal(config.env.production.vars.WORKER_ID, "worker-production");
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(config.env.production.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, root.version);
});

test("development tooling and the portable Runner have separate Node contracts", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const runner = JSON.parse(await readFile(new URL("../apps/runner/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const version = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();
  assert.equal(root.engines.node, ">=22");
  assert.equal(root.packageManager, "npm@10.9.3");
  assert.deepEqual(lock.packages[""].engines, root.engines);
  assert.match(version, /^22\./);
  assert.equal(runner.engines.node, ">=20");
});

test("reviewed release identity, independent production gate and precise CI toolchain remain aligned", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const installer = await readFile(new URL("../apps/worker/src/installer.ts", import.meta.url), "utf8");
  assert.notEqual(root.version, "0.1.0-dev.3");
  assert.ok(installer.includes(`FIXED_RELEASE_VERSION = "${root.version}"`));
  for (const file of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assert.ok(workflow.includes("--dry-run --env production"));
    assert.ok(workflow.includes("node-version-file: .node-version"));
    assert.ok(workflow.includes("npm@10.9.3"));
    assert.ok(workflow.includes("check-release-contract.mjs"));
  }
});

test("first setup has no extra token contract, while documentation preserves restricted defaults", async () => {
  const worker = await readFile(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
  const environment = await readFile(new URL("../apps/worker/src/runner-do.ts", import.meta.url), "utf8");
  assert.ok(!worker.includes("ADMIN_SETUP_TOKEN") && !environment.includes("ADMIN_SETUP_TOKEN"));
  assert.ok(!worker.includes('name="setup_token"'));
  for (const file of ["README.md", "README.zh-CN.md", "docs/architecture.md", "docs/runner-transport.md", "docs/adr-0001-architecture.md"]) {
    const document = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(document.includes("dedicated_user"), file);
    assert.ok(document.includes("coding:read"), file);
  }
});

test("audit transport cannot regain generic tool arguments or response payloads", async () => {
  const source = await readFile(new URL("../apps/worker/src/mcp/server.ts", import.meta.url), "utf8");
  const auditFunction = source.slice(source.indexOf("async function recordRunnerToolCall"), source.indexOf("function asToolResult"));
  assert.ok(auditFunction.length > 0);
  assert.ok(!auditFunction.includes("params: redactAndBound"));
  assert.ok(!auditFunction.includes("result: redactAndBound"));
  const registry = await readFile(new URL("../apps/worker/src/registry.ts", import.meta.url), "utf8");
  assert.ok(!registry.includes("params: call.params"));
  assert.ok(!registry.includes("result: call.result"));
});

test("hosted installer commands retain the convenience credential handoff", async () => {
  const source = await readFile(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
  assert.ok(source.includes("sudo sh -s -- ${shellCode}"));
  assert.ok(source.includes(".Content)) ${powerShellCode}"));
  const document = await readFile(new URL("../docs/security-remediation.md", import.meta.url), "utf8");
  assert.ok(document.includes("--code"));
  assert.ok(document.includes("command history"));
});
