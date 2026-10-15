import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Check the Git index, not the filesystem: ignored artifacts may legitimately exist.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
const forbiddenPaths = [
  /^reports\//u, /^\.audit\//u, /^ci-results\//u, /^\.verification\//u,
  /^plans?\//u, /^artifacts\//u, /^tmp\//u,
  /^docs\/runmesh-project-audit-/u,
];
const forbiddenNames = /(?:^|\/)(?:npm-debug\.log|.*\.(?:log|trace)|.*\.test-results\.json)$/iu;
const violations = tracked.filter(path => forbiddenPaths.some(rule => rule.test(path)) || forbiddenNames.test(path));
assert.deepEqual(violations, [], `Non-source artifacts tracked in Git:\n${violations.join('\n')}`);
console.log(`repository_hygiene: passed (${tracked.length} tracked files)`);
