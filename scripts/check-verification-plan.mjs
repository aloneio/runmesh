import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkDomainImports, inventoryTests, validateTestPlan, validateTestWiring } from "./verification-plan.mjs";

try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const plan = JSON.parse(await readFile(new URL("../test/verification-plan.json", import.meta.url), "utf8"));
  const summary = validateTestPlan(plan, await inventoryTests(root));
  const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  validateTestWiring(plan, JSON.parse(await read("package.json")), await read(".github/workflows/ci.yml"), await read(".gitlab-ci.yml"));
  const domainModules = await checkDomainImports(root, plan.groups.find(group => group.id === "domain").files);
  console.log(JSON.stringify({ verification_inventory: 1, ...summary, domain_modules: domainModules, execution_evidence: false }));
} catch (error) {
  console.error(`Verification inventory failed: ${error instanceof Error ? error.message : "invalid manifest"}`);
  process.exitCode = 1;
}
