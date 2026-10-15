import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Inspect the Git index, not ignored local evidence that may legitimately exist.
const tracked = execFileSync("git", ["-c", `safe.directory=${process.cwd()}`, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  .split("\0").filter(Boolean);
const forbiddenPaths = [
  /^reports\//u, /^\.audit\//u, /^ci-results\//u, /^\.verification\//u,
  /^plans?\//u, /^artifacts\//u, /^tmp\//u,
  /^docs\/runmesh-project-audit-/u,
  /^docs\/(?:.*\/)?[^/]*(?:audit|remediation|roadmap|implementation-plan)[^/]*\.md$/iu,
  /^docs\/maintainers\/release-(?:history|evidence)\.md$/u,
  /^docs\/current-facts\.md$/u,
  /^scripts\/ci-remediation-layout\.mjs$/u,
  /^test\/fixtures\/ci-before-remediation\.json$/u,
];
const forbiddenNames = /(?:^|\/)(?:npm-debug\.log|.*\.(?:log|trace)|.*\.test-results\.json)$/iu;
const pathViolations = tracked.filter(path => forbiddenPaths.some(rule => rule.test(path)) || forbiddenNames.test(path));
assert.deepEqual(pathViolations, [], `Non-source artifacts tracked in Git:\n${pathViolations.join("\n")}`);

const privateSourceViolations = [];
const privateHome = /(?:\/home\/xwzy(?:\/|\b)|[A-Z]:\\Users\\xwzy\b)/iu;
const personalMailbox = /[A-Za-z0-9._%+-]+@(?:hotmail|gmail|outlook|yahoo|qq|163|126)\.com/iu;
const credentialPrefixes = /(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{25,}|glpat-[A-Za-z0-9_-]{15,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{25,}|(?:AKIA|ASIA)[0-9A-Z]{16})/u;
for (const path of tracked) {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (privateHome.test(text) || credentialPrefixes.test(text)
    || (!/^(?:apps\/runner\/THIRD_PARTY_NOTICES\.md|LICENSE(?:_HISTORY)?(?:\.zh-CN)?\.md)$/u.test(path) && personalMailbox.test(text)))
    privateSourceViolations.push(path);
}
assert.deepEqual(privateSourceViolations, [], `Private identifiers or high-confidence credentials in source files: \n${privateSourceViolations.join("\n")}`);

const contentViolations = [];
for (const path of tracked) {
  if (path.startsWith("docs/") && path.endsWith(".md")) {
    const text = readFileSync(path, "utf8");
    if (/^#{1,6}\s+(?:implementation\s+plan|action\s+plan|roadmap|remediation\s+plan|audit\s+report|review\s+plan)\b/imu.test(text)
      || /^\s*-\s*\[\s\]\s+/mu.test(text)) contentViolations.push(path);
  }
  if ((path.startsWith("test/fixtures/") || path.startsWith("apps/worker/test/fixtures/")) && path.endsWith(".json")) {
    const text = readFileSync(path, "utf8");
    if (/"(?:reviewed_change|prior_manifest)"\s*:/u.test(text)) contentViolations.push(path);
  }
}
assert.deepEqual([...new Set(contentViolations)], [], `Plan/audit metadata tracked in source files:\n${[...new Set(contentViolations)].join("\n")}`);
console.log(`repository_hygiene: passed (${tracked.length} tracked files)`);
