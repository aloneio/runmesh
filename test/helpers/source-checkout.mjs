import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceGitEnvironment } from "../../scripts/source-git.mjs";
import { sourceObservation } from "../../scripts/ci-report.mjs";

/** Give subprocess gate fixtures a real, initially clean source identity. */
export async function initializeSourceCheckout(root, ignored = []) {
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Runmesh Test", "-c", "user.email=runmesh-test@example.test",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(root, "no-hooks"), ...args],
    { cwd: root, env: sourceGitEnvironment(), encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  await writeFile(join(root, ".gitignore"), ["ci-results/", ...ignored, ""].join("\n"));
  await writeFile(join(root, "source.txt"), "initial source\n");
  git("init", "--quiet"); git("add", "."); git("commit", "--quiet", "-m", "fixture");
  const source = sourceObservation(root); assert.equal(source.state, "clean");
  return { git, source };
}
