import { readFile, readdir } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { reviewedReleaseSource } from "../scripts/runtime-config-tools.mjs";
import { checkCommand } from "../scripts/ci-contract.mjs";

test("release candidate ships central capabilities in both production entrypoints", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"));
  const entrypoint = await readFile(new URL("../apps/worker/src/production.ts", import.meta.url), "utf8");
  for (const section of [config, config.env.production]) {
    assert.deepEqual(section.durable_objects.bindings.filter(binding => binding.name === "CAPABILITIES"), [{ name: "CAPABILITIES", class_name: "CapabilitiesDOv1" }]);
    assert.deepEqual(section.exports.CapabilitiesDOv1, { type: "durable-object", storage: "sqlite" });
    for (const name of ["CENTRAL_SKILLS_ENABLED", "CENTRAL_DIRECT_TOOLS_ENABLED", "CENTRAL_GOVERNANCE_ENABLED"]) assert.equal(section.vars[name], "1");
  }
  assert.match(entrypoint, /export \{[^}]*CapabilitiesDOv1[^}]*\} from "[.]\/index[.]js"/u);
});

test("top-level and named Worker environments enable the reviewed central capabilities", async () => {
  const source = await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(config.name, "runmesh");
  assert.deepEqual(config.vars, { CENTRAL_SKILLS_ENABLED: "1", CENTRAL_DIRECT_TOOLS_ENABLED: "1", CENTRAL_GOVERNANCE_ENABLED: "1" });
  const releaseState=JSON.parse(await readFile(new URL("../release/release-state.json",import.meta.url),"utf8"));
  assert.equal(releaseState.version,root.version);
  assert.ok(["candidate","released"].includes(releaseState.state));
  assert.equal(await readFile(new URL("../apps/worker/src/generated-release.ts",import.meta.url),"utf8"), reviewedReleaseSource(root.version,releaseState));
  assert.equal(config.env.production.name, config.name);
  assert.deepEqual(config.env.production.vars, config.vars);
  assert.equal(config.env.development.name, "runmeshdev");
  assert.deepEqual(config.env.development.vars, { RUNMESH_ENVIRONMENT: "development",
    CENTRAL_SKILLS_ENABLED: "1", CENTRAL_DIRECT_TOOLS_ENABLED: "1", CENTRAL_GOVERNANCE_ENABLED: "1" });
  assert.equal(config.env.test.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, "");
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
  assert.equal(runner.engines.node, ">=22.23.2 <23 || >=24.21.0 <25");
});

test("reviewed release identity, independent production gate and precise CI toolchain remain aligned", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const releaseConfig = await readFile(new URL("../apps/worker/src/domain/release-config.ts", import.meta.url), "utf8");
  assert.notEqual(root.version, "0.1.0-dev.3");
  assert.ok(releaseConfig.includes(`FIXED_RELEASE_VERSION = "${root.version}"`));
  for (const file of ["ci.yml", "release.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    if (file === "ci.yml") {
      assert.ok(workflow.includes(checkCommand("worker_prod")));
      assert.ok(workflow.includes(checkCommand("release_contract")));
    } else {
      assert.ok(workflow.includes("--dry-run --env production"));
      assert.ok(workflow.includes("check-release-contract.mjs"));
    }
    assert.ok(workflow.includes("node-version-file: .node-version"));
    assert.ok(workflow.includes("npm@10.9.3"));
  }
});

test("first setup has no extra token contract, while documentation preserves restricted defaults", async () => {
  async function sources(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      assert.ok(!entry.isSymbolicLink(), "Worker source must not be hidden behind symlinks");
      if (entry.isDirectory()) files.push(...await sources(path));
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(await readFile(path, "utf8"));
    }
    return files;
  }
  const worker = (await sources(new URL("../apps/worker/src/", import.meta.url))).join("\n");
  const environment = await readFile(new URL("../apps/worker/src/runner-do.ts", import.meta.url), "utf8");
  assert.ok(!worker.includes("ADMIN_SETUP_TOKEN") && !environment.includes("ADMIN_SETUP_TOKEN"));
  assert.ok(!worker.includes('name="setup_token"'));
  // User entry points describe the selected permission using the UI label;
  // technical references retain the corresponding protocol scope identifier.
  const defaults = [
    ["README.md", /computer permissions start with Read selected/u],
    ["README.zh-CN.md", /计算机权限初始勾选读取/u],
    ...["docs/architecture.md", "docs/runner-transport.md", "docs/adr-0001-architecture.md"].map(file => [file, /coding:read/u]),
  ];
  for (const [file, readDefault] of defaults) {
    const document = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(document.includes("dedicated_user"), file);
    assert.match(document, readDefault, file);
  }
});

test("audit transport cannot regain generic tool arguments or response payloads", async () => {
  const source = await readFile(new URL("../apps/worker/src/mcp/audit.ts", import.meta.url), "utf8");
  const auditFunction = source.slice(source.indexOf("async function recordRunnerToolCall"));
  assert.ok(auditFunction.length > 0);
  assert.ok(!auditFunction.includes("params: redactAndBound"));
  assert.ok(!auditFunction.includes("result: redactAndBound"));
  const registry = await readFile(new URL("../apps/worker/src/registry.ts", import.meta.url), "utf8");
  assert.ok(!registry.includes("params: call.params"));
  assert.ok(!registry.includes("result: call.result"));
});

test("hosted installer commands retain the convenience credential handoff", async () => {
  const source = await readFile(new URL("../apps/worker/src/admin/enrollment-view.ts", import.meta.url), "utf8");
  assert.ok(source.includes('downloadedShellCommand(new URL(`/runner/install.sh${installerQuery}`, publicBase).toString(), [code])'));
  assert.ok(source.includes(".Content)) ${powerShellCode}"));
  const entrypoint = await readFile(new URL("../apps/worker/src/http/admin-presentation.ts", import.meta.url), "utf8");
  assert.ok(entrypoint.includes('from "../admin/enrollment-view.js"'));
  assert.ok(entrypoint.includes("return html(enrollmentDocument("));
  const document = await readFile(new URL("../docs/security-remediation.md", import.meta.url), "utf8");
  assert.ok(document.includes("--code"));
  assert.ok(document.includes("command history"));
});


test("central outbound transport retains public-only routing and requires explicit endpoint and key provisioning", async () => {
  const config=JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc",import.meta.url),"utf8"));
  for (const environment of [config, ...Object.values(config.env)]) {
    const flags=environment.compatibility_flags ?? config.compatibility_flags;
    assert.ok(flags.includes("global_fetch_strictly_public"));
    assert.ok(!flags.includes("global_fetch_private_origin"));
  }
  for (const environment of [config, config.env.production, config.env.development]) {
    assert.equal(environment.vars.CENTRAL_MCP_EGRESS,undefined);
    assert.equal(environment.vars.CENTRAL_VAULT_KEYRING,undefined);
  }
  for (const environment of [config, config.env.production])
    assert.deepEqual(environment.durable_objects.bindings.filter(binding=>binding.name==="CAPABILITIES"), [{name:"CAPABILITIES",class_name:"CapabilitiesDOv1"}]);
  assert.deepEqual(config.env.development.durable_objects.bindings.filter(binding=>binding.name==="CAPABILITIES"),
    [{name:"CAPABILITIES",class_name:"CapabilitiesDOv1"}]);
});

test("OAuth credentials and provider policies are never plaintext deployed Worker settings", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"));
  for (const section of [config, config.env.development, config.env.production]) {
    assert.equal(section.vars?.CENTRAL_OAUTH_POLICIES, undefined);
    assert.equal(section.vars?.CENTRAL_VAULT_KEYRING, undefined);
    assert.equal(section.durable_objects.bindings.some(binding => binding.name === "CAPABILITIES"), true);
  }
});

test("retirement cannot target v2, other environments, or a replacement production namespace", async () => {
  const config=JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc",import.meta.url),"utf8"));
  const expected={RegistryDOv2:{type:"durable-object",storage:"sqlite"},RunnerDOv2:{type:"durable-object",storage:"sqlite"},CapabilitiesDOv1:{type:"durable-object",storage:"sqlite"},RegistryDO:{type:"durable-object",state:"deleted"},RunnerDO:{type:"durable-object",state:"deleted"}};
  for(const c of [config,config.env.production]) {
    assert.equal(c.name,"runmesh");assert.equal(c.main,"src/production.ts");
    assert.deepEqual(c.exports,expected);assert.equal(c.migrations,undefined);
    assert.deepEqual(c.durable_objects.bindings,[{name:"REGISTRY",class_name:"RegistryDOv2"},{name:"RUNNER",class_name:"RunnerDOv2"},{name:"CAPABILITIES",class_name:"CapabilitiesDOv1"}]);
    assert.deepEqual(c.d1_databases,[{binding:"HISTORY_DB",database_name:"runmesh-audit-history"}]);
  }
  const originalMigrations=[{tag:"v1",new_sqlite_classes:["RegistryDO","RunnerDO"]},{tag:"v2",new_sqlite_classes:["RegistryDOv2","RunnerDOv2"]}];
  const originalBindings=[{name:"REGISTRY",class_name:"RegistryDOv2"},{name:"RUNNER",class_name:"RunnerDOv2"}];
  for(const [name,c] of [["development",config.env.development],["test",config.env.test]]) {
    assert.equal(c.main,"src/index.ts");assert.deepEqual(c.exports,{});
    // Append the environment-specific owner without retiring or renaming any native state.
    const centralTag = name === "test" ? "central-test-v1" : "central-dev-v1";
    assert.deepEqual(c.migrations,[...originalMigrations,{tag:centralTag,new_sqlite_classes:["CapabilitiesDOv1"]}]);
    assert.deepEqual(c.durable_objects.bindings,[...originalBindings,{name:"CAPABILITIES",class_name:"CapabilitiesDOv1"}]);
  }
});
