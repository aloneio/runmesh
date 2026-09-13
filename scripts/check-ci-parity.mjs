import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const github = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
const gitlab = await readFile(new URL(".gitlab-ci.yml", root), "utf8");

// These are the release-relevant checks that must run in both hosted CI
// systems for the same source revision. Platform-specific native jobs remain
// GitHub-only until equivalent GitLab runners are intentionally provisioned.
const criticalChecks = [
  "node scripts/check-toolchain.mjs",
  "npm ci",
  "npm audit --audit-level=high",
  "npm audit --omit=dev --audit-level=high",
  "npm run check:docs",
  "npm run check:runbooks",
  "npm run check:versions",
  "npm run check:format",
  "git diff --check",
  "npm run typecheck",
  "npm run test:unit",
  "npm run test:release-tools",
  "npm run check:licenses",
  "npm run build",
  "npm run validate:worker -- --dry-run",
  "npm run validate:worker -- --dry-run --env production",
  "node scripts/check-release-contract.mjs",
  "npm run pack:smoke",
  "npm run test:e2e",
];

for (const check of criticalChecks) {
  assert.ok(github.includes(check), `.github/workflows/ci.yml is missing critical check: ${check}`);
  assert.ok(gitlab.includes(check), `.gitlab-ci.yml is missing critical check: ${check}`);
}

assert.match(github, /pull_request:/u, "GitHub CI must run for pull requests");
assert.match(gitlab, /merge_request_event/u, "GitLab CI must run for merge requests");
assert.match(github, /branches:\s*\[dev\]/u, "GitHub CI must gate dev pushes");
assert.match(gitlab, /CI_COMMIT_BRANCH == "dev"/u, "GitLab CI must gate dev pushes");

console.log(`CI parity verified for ${criticalChecks.length} critical checks`);
