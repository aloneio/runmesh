import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const LANES = Object.freeze({
  protocol: "packages/protocol/vitest.config.ts", runner: "apps/runner/vitest.config.ts", worker: "apps/worker/vitest.config.ts",
  domain: "vitest.domain.config.mjs", contracts: "vitest.contracts.config.mjs", transport: "vitest.e2e.config.ts",
});
/** Validate a complete tool collection, not source text resembling a test glob. */
export function validateCollectedFiles(root, expected, document) {
  assert.ok(Array.isArray(document) && document.length > 0 && document.length <= 10000, "invalid collected file list");
  const files = document.map(item => {
    assert.ok(item && typeof item.file === "string" && isAbsolute(item.file), "invalid collected test path");
    const file = relative(root, item.file).split(sep).join("/");
    assert.ok(!file.startsWith("../") && !isAbsolute(file) && !file.split("/").some(part => [".audit", "node_modules", ".git", "dist"].includes(part)), "archived or external test was collected");
    return file;
  });
  assert.equal(new Set(files).size, files.length, "duplicate collected test");
  assert.deepEqual([...files].sort(), [...expected].sort(), "collected tests differ from the owned test manifest");
  return files.length;
}
export function checkTestCollection(root, plan, invoke = spawnSync) {
  root = resolve(root);
  const summary = {};
  for (const [lane, config] of Object.entries(LANES)) {
    const expected = plan.groups.find(group => group.id === lane)?.files;
    assert.ok(Array.isArray(expected) && expected.length, "missing test collection owner");
    const workingDirectories = [...new Set([root, dirname(join(root, config))])];
    for (const cwd of workingDirectories) {
      const result = invoke(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", "--json", "--config", join(root, config)], {
        cwd, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
        encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      assert.equal(result.status, 0, `test collection failed for ${lane}`);
      validateCollectedFiles(root, expected, JSON.parse(result.stdout));
    }
    summary[lane] = { files: expected.length, working_directories: workingDirectories.length };
  }
  return { collection_contract: 1, lanes: summary, test_execution: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2);
    const root = fileURLToPath(new URL("../", import.meta.url));
    const plan = JSON.parse(await readFile(join(root, "test/verification-plan.json"), "utf8"));
    console.log(JSON.stringify(checkTestCollection(root, plan)));
  } catch (error) {
    console.error("test_collection_failed: " + (error instanceof assert.AssertionError ? error.message.split("\n")[0] : "invalid collection result"));
    process.exitCode = 1;
  }
}
