import { test } from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { validateCollectedFiles, checkTestCollection } from "../scripts/check-test-collection.mjs";
const root = join(tmpdir(), "runmesh-collection-fixture");
test("collection validates exact ownership, rejecting missing/duplicate/archived files", () => {
  const path = "apps/runner/test/test.test.ts", file = { file: join(root, path) };
  assert.equal(validateCollectedFiles(root, [path], [file]), 1);
  for (const invalid of [[], [file, file], [{ file: join(root, ".audit/test.test.ts") }], [{ file: join(root, "../external.test.ts") }], [{ file: path }], [{ file: join(root, "other.test.ts") }]]) {
    assert.throws(() => validateCollectedFiles(root, [path], invalid));
  }
});
test("collection checks root and owning workspace with the same absolute config", () => {
  const groups = ["protocol", "runner", "worker", "domain", "contracts", "transport"].map(id => ({ id, files: [id + "/x.test.ts"] }));
  const calls = [];
  const invoke = (_node, args, options) => {
    const config = args.at(-1).split(sep).join("/");
    const key = config.includes("/runner/") ? "runner" : config.includes("/worker/") ? "worker" : config.includes("/protocol/") ? "protocol"
      : config.includes("domain") ? "domain" : config.includes("contracts") ? "contracts" : "transport";
    calls.push({ key, cwd: options.cwd, config });
    return { status: 0, stdout: JSON.stringify([{ file: join(root, key + "/x.test.ts") }]) };
  };
  const report = checkTestCollection(root, { groups }, invoke);
  assert.equal(report.test_execution, false); assert.equal(calls.length, 9);
  assert.equal(report.lanes.worker.working_directories, 2);
  const runner = calls.filter(c => c.key === "runner");
  assert.equal(runner[0].config, runner[1].config); assert.notEqual(runner[0].cwd, runner[1].cwd);
  assert.throws(() => checkTestCollection(root, { groups }, () => ({ status: 1, stdout: "[]" })));
});
