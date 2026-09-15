import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { githubPolicyWorkflow, gitlabPolicyEntrypoint, gitlabPolicyJob, GITLAB_POLICY_MARKER } from "./promotion-configuration.mjs";

const root = new URL("../", import.meta.url);
try {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--write", "unsupported arguments");
  const write = process.argv[2] === "--write";
  const source = await readFile(new URL(".gitlab-ci.yml", root), "utf8");
  const original = source.split(GITLAB_POLICY_MARKER)[0].trimEnd();
  const files = {
    ".github/workflows/main-source-policy.yml": githubPolicyWorkflow(),
    ".gitlab/main-policy.yml": gitlabPolicyEntrypoint(),
    ".gitlab-ci.yml": original + "\n\n" + GITLAB_POLICY_MARKER + "\n" + gitlabPolicyJob(),
  };
  for (const [name, expected] of Object.entries(files)) {
    const path = fileURLToPath(new URL(name, root));
    if (write) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, expected); }
    else assert.equal(await readFile(path, "utf8"), expected, `${name} differs from the reviewed promotion policy`);
  }
  console.log("Main promotion workflow metadata checks verified; remote enforcement must be verified separately.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "main promotion policy validation failed");
  process.exitCode = 1;
}
