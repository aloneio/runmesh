import { CI_CHECKS } from "../scripts/ci-contract.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDomainImports, inventoryTests, validateTestPlan, validateTestWiring } from "../scripts/verification-plan.mjs";
import { summarizeVitest, packageEvidence } from "../scripts/test-evidence.mjs";
import { renderExamples, renderFacts, validateExampleCoverage, verifyDocReferences } from "../scripts/project-facts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plan = JSON.parse(await readFile(join(root, "test/verification-plan.json"), "utf8"));
const files = plan.groups.flatMap(g => g.files);

test("AR08 architecture references cannot name missing source paths", async () => {
  assert.equal(await verifyDocReferences(root, "See `apps/runner/src/jobs/` and `packages/protocol/src/`."), 2);
  await assert.rejects(verifyDocReferences(root, "See `apps/worker/src/not-a-real-boundary.ts`."));
  await assert.rejects(verifyDocReferences(root, "See `apps/../private`."));
});

test("AR08 a listed Node test omitted from execution cannot silently pass the gate", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const github = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  const gitlab = await readFile(join(root, ".gitlab-ci.yml"), "utf8");
  validateTestWiring(plan, pkg, github, gitlab);
  const changed = structuredClone(pkg);
  changed.scripts["test:release-tools"] = "node --test test/missing.test.mjs";
  assert.throws(() => validateTestWiring(plan, changed, github, gitlab));
  assert.throws(() => validateTestWiring(plan, pkg, github.replaceAll("- run: node scripts/ci-check.mjs installed_transport", "# removed installed transport"), gitlab));
});

test("AR08 every existing test has exactly one declared layer", async () => {
  assert.deepEqual(validateTestPlan(plan, await inventoryTests(root)), { groups: 8, files: files.length });
});
test("AR08 missing, duplicate, unknown and misclassified tests fail the inventory gate", () => {
  for (const mutate of [p => p.groups.pop(), p => p.groups[0].files.pop(), p => p.groups[1].files.push(p.groups[0].files[0]),
    p => p.groups[0].files.push("../../private.test.ts"), p => p.groups[0].id = "imaginary", p => p.external_checks = []]) {
    const value = structuredClone(plan); mutate(value); assert.throws(() => validateTestPlan(value, files));
  }
  assert.throws(() => validateTestPlan(plan, [...files, "test/not-classified.test.mjs"]));
});
test("AR08 domain lane rejects side effects through transitive imports", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runmesh-domain-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "test/domain"), { recursive: true }); await mkdir(join(dir, "apps/runner/src"), { recursive: true });
  const path = join(dir, "test/domain/public.test.ts");
  await writeFile(path, 'import "../../apps/runner/src/effect.js";');
  await writeFile(join(dir, "apps/runner/src/effect.ts"), 'import "node:fs/promises";');
  await assert.rejects(checkDomainImports(dir, ["test/domain/public.test.ts"]), /side effect/);
  await writeFile(path, 'const value = manager as unknown as { secret: string };');
  await assert.rejects(checkDomainImports(dir, ["test/domain/public.test.ts"]), /private casts/);
});
function reporter() {
  return { success: true, numFailedTestSuites: 0, numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
    testResults: [{ status: "passed", name: "/private/fixture", assertionResults: [
      { status: "passed", fullName: "private fixture", failureMessages: ["do not copy"] }, { status: "pending" }, { status: "todo" },
    ] }] };
}
test("AR08 reporter preserves skipped and todo counts without leaking raw fixture text", () => {
  const summary = summarizeVitest(reporter(), 0);
  assert.deepEqual(summary, { state: "passed", total: 3, passed: 1, failed: 0, skipped: 1, todo: 1, files: 1 });
  assert.ok(!JSON.stringify(summary).includes("private"));
});
test("AR08 exit zero, stale counts and success-looking reporters cannot fabricate verification", () => {
  assert.throws(() => summarizeVitest(reporter(), 1));
  for (const mutate of [r => r.success = false, r => r.numFailedTestSuites = 1, r => r.numTotalTests++,
    r => r.testResults = [], r => r.testResults[0].status = "failed", r => r.testResults[0].assertionResults[0].status = "running",
    r => r.testResults[0].assertionResults[0].status = "failed", r => r.testResults[0].assertionResults[0].status = "pending"]) {
    const value = reporter(); mutate(value); assert.throws(() => summarizeVitest(value, 0));
  }
});
test("AR08 package observations never imply signing, production or other native platforms", () => {
  const value = packageEvidence({ tests: summarizeVitest(reporter(), 0), source: { commit: "a".repeat(40), tree: "b".repeat(40), state: "dirty", email: "do-not-export" },
    artifact: { sha256: "c".repeat(64), bytes: 100, path: "/private" }, platform: "linux", arch: "arm64", node: "v22.23.2", elapsedMs: 1000 });
  assert.equal(value.source.state, "dirty"); assert.equal(value.artifact.signed, false); assert.equal(value.artifact.published, false);
  for (const key of ["production", "signed_release", "account_quotas", "host_catalog"]) assert.deepEqual(value[key], { state: "not_run" });
  assert.ok(!JSON.stringify(value).includes("private")); assert.ok(!JSON.stringify(value).includes("email"));
});
test("AR08 documentation must cover each real tool and action without fictional inputs", () => {
  const contract = { contractFacts: { tools: ["read"], actions: [{ tool: "read", action: "read" }] }, exampleProblem: e => e.arguments.bad ? "bad input" : undefined };
  const examples = [{ id: "file", tool: "read", action: "read", accepts: true, arguments: {} }];
  validateExampleCoverage(examples, contract);
  assert.throws(() => validateExampleCoverage([], contract));
  assert.throws(() => validateExampleCoverage([...examples, ...examples], contract));
  assert.throws(() => validateExampleCoverage([{ ...examples[0], arguments: { bad: true } }], contract));
  assert.throws(() => validateExampleCoverage(examples, { ...contract, contractFacts: { tools: ["unknown"], actions: [] } }));
});
test("AR08 generated text changes when source facts or examples change", () => {
  assert.notEqual(renderFacts({ tools: ["read"] }), renderFacts({ tools: ["read", "context"] }));
  const example = { id: "read", tool: "read", accepts: true, arguments: { limit: 12 } };
  assert.notEqual(renderExamples([example]), renderExamples([{ ...example, arguments: { limit: 13 } }]));
});
test("AR08 layered and actual-package commands are required in both CI systems", async () => {
  for (const command of ["npm run check:verification", "npm run test:package:e2e"]) assert.ok(Object.values(CI_CHECKS).includes(command));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const command of ["test:domain", "test:contracts"]) assert.ok(pkg.scripts["test:unit"].includes(`npm run ${command}`));
});
