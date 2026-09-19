import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { REQUIRED_SECRET_NAMES } from "./runtime-config-tools.mjs";

export function validateExampleCoverage(examples, contract) {
  assert.ok(Array.isArray(examples) && examples.length > 0 && examples.length <= 128, "invalid example catalog");
  const ids = new Set();
  for (const example of examples) {
    assert.ok(/^[a-z0-9-]{1,80}$/u.test(example.id) && !ids.has(example.id), "duplicate/invalid example ID"); ids.add(example.id);
    assert.equal(typeof example.accepts, "boolean");
    assert.equal(contract.exampleProblem(example), undefined, example.id);
  }
  for (const tool of contract.contractFacts.tools) assert.ok(examples.some(e => e.tool === tool && e.accepts), "tool has no valid documentation example");
  for (const { tool, action } of contract.contractFacts.actions) assert.ok(examples.some(e => e.tool === tool && e.action === action && e.accepts), "action has no valid documentation example");
}

export function renderFacts(facts) {
  return "# Current checkout facts / 当前源码事实\n\n" +
    "Generated from the checked-out source by `npm run generate:facts` and validated by `check:docs`. To identify running components, follow [build provenance](build-provenance.md) and the [upgrade guide](upgrading.md).\n\n" +
    "此表由当前源码生成，并通过 `check:docs` 校验。核对运行中的组件时，请按[构建来源](build-provenance.zh-CN.md)和[升级指南](upgrading.zh-CN.md)操作。\n\n```json\n" + JSON.stringify(facts, null, 2) + "\n```\n";
}
export async function verifyDocReferences(root, text) {
  const paths = [...text.matchAll(/`((?:apps|packages|scripts|test)\/[A-Za-z0-9._/-]+)`/gu)].map(match => match[1]);
  for (const path of paths) {
    assert.ok(!path.split("/").includes(".."), "unsafe documentation source path");
    const info = await lstat(join(root, path));
    assert.ok((info.isFile() || info.isDirectory()) && !info.isSymbolicLink(), "documentation path must be a regular file/directory");
  }
  return paths.length;
}

export function renderExamples(examples) {
  return "# Schema-checked tool examples / Schema 校验示例\n\n" +
    "Generated from `tool-examples.json` and checked locally against the tool input schemas. Adapt the synthetic IDs, hashes and commands to your authorized workspace, and review write operations before running them. Each actual call checks current permissions.\n\n" +
    "示例来自 `tool-examples.json`，通过工具参数 Schema 的本地校验。使用时请替换为自己有权访问的工作区、任务和内容，并在执行前核对写入操作。实际调用会检查当前权限。\n\n" +
    examples.map(example => `## ${example.id} — ${example.accepts ? "schema accepts / 参数有效" : "schema rejects / 应拒绝"}\n\n\`\`\`json\n${JSON.stringify({ name: example.tool, arguments: example.arguments }, null, 2)}\n\`\`\`\n`).join("\n");
}

export async function projectDocuments(root) {
  const temp = await mkdtemp(join(tmpdir(), "runmesh-doc-facts-"));
  try {
    const bundle = join(temp, "facts.mjs");
    await build({ entryPoints: [join(root, "scripts/project-facts-entry.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      alias: { "@aloneio/runmesh-protocol": join(root, "packages/protocol/src/index.ts") } });
    const contract = await import(pathToFileURL(bundle).href);
    const examples = JSON.parse(await readFile(join(root, "docs/tool-examples.json"), "utf8"));
    validateExampleCoverage(examples, contract);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const config = JSON.parse(await readFile(join(root, "apps/worker/wrangler.jsonc"), "utf8"));
    const release = JSON.parse(await readFile(join(root, "release/release-state.json"), "utf8"));
    const facts = { schema_version: 1, evidence: "source_checkout_only", product_version: pkg.version,
      ...contract.contractFacts, required_secrets: [...REQUIRED_SECRET_NAMES],
      production_plaintext_vars: config.env.production.vars, development_plaintext_vars: config.env.development.vars,
      durable_objects: config.durable_objects.bindings.map(b => ({ binding: b.name, class: b.class_name })),
      history_bindings: config.d1_databases.map(db => db.binding),
      reviewed_release_record: { version: release.version, state: release.state, commit: release.release_commit, manifest_sha256: release.manifest_sha256 },
      observations: { test_execution: "not_run", signed_assets: "not_run", deployed_worker: "not_run", installed_runner: "not_run", account_quotas: "not_run", host_catalog: "not_run" } };
    return { "docs/current-facts.md": renderFacts(facts), "docs/tool-examples.md": renderExamples(examples) };
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

export async function checkProjectDocuments(root, write = false) {
  await verifyDocReferences(root, await readFile(join(root, "docs/architecture.md"), "utf8"));
  const documents = await projectDocuments(root);
  for (const [path, expected] of Object.entries(documents)) {
    if (write) await writeFile(join(root, path), expected);
    else assert.equal(await readFile(join(root, path), "utf8"), expected, `${path} is stale; run generate:facts and review the diff`);
  }
}
