import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = name => readFile(new URL(name, root), "utf8");

test("only GitLab development is an authoritative deployment source", async () => {
  const [deployment, ownership, source] = await Promise.all([
    read("docs/deployment.md"), read("docs/module-ownership.md"), read("docs/build-provenance.md"),
  ]);
  for (const content of [deployment, ownership, source]) {
    assert.match(content, /GitLab/u);
    assert.doesNotMatch(content, /sync-gitlab-dev/u);
  }
  for (const file of ["scripts/sync-gitlab-dev.mjs", "ops/systemd/runmesh-dev-sync.service", "ops/systemd/runmesh-dev-sync.timer"]) {
    await assert.rejects(access(new URL(file, root)), { code: "ENOENT" });
  }
});
test("GitLab main requires a same-project dev merge request", async () => {
  const [ci, source] = await Promise.all([read(".gitlab-ci.yml"), read(".gitlab/main-policy.yml")]);
  for (const contents of [ci, source]) {
    assert.match(contents, /main-source-policy:/u);
    assert.match(contents, /main-from-dev-v1/u);
  }
});
