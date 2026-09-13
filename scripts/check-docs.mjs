import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const current = ["README.md", "README.zh-CN.md", "docs/admin-guide.md", "docs/admin-guide.zh-CN.md", "docs/deployment.md", "docs/portable-runner-installation.md", "docs/architecture.md", "docs/adr-0001-architecture.md", "docs/protocol.md", "docs/runner-transport.md", "docs/release-readiness.md"];
for (const file of current) {
  const text = await readFile(new URL(file, root), "utf8");
  for (const match of text.matchAll(/RUNMESH_SIGNED_RELEASE_AVAILABLE=([0-9A-Za-z.+-]+)/g)) assert.equal(match[1], pkg.version, `${file}: stale activation command`);
  assert.ok(!/0\.1\.0-dev\.[1-5]|Node\.js 20 or newer|first-setup authorization secret/.test(text), `${file}: stale operative release or setup contract`);
}
const readiness = await readFile(new URL("docs/release-readiness.md", root), "utf8");
assert.ok(readiness.includes(pkg.version));
assert.ok(readiness.includes("verify-all") && readiness.includes("RELEASED") && readiness.includes("ENABLED"));
const config = JSON.parse((await readFile(new URL("apps/worker/wrangler.jsonc", root), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
assert.equal(config.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, pkg.version, "top-level production checkout must acknowledge the exact current immutable release");
assert.equal(config.env.production.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, pkg.version, "named production alias must acknowledge the exact current immutable release");
assert.equal(config.env.development.vars.RUNMESH_SIGNED_RELEASE_AVAILABLE, "", "development environment must remain fail-closed");
console.log(`operative documentation and enabled published-release contract verified: ${pkg.version}`);
