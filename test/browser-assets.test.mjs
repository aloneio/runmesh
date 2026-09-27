import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserSource, browserModule, writeBrowserAssets } from "../scripts/generate-browser-assets.mjs";
import { adminScript } from "../apps/worker/dist/admin/client-script.js";

test("local browser modules preserve the reviewed rendered script hashes", async () => {
  const baseline = JSON.parse(await readFile(new URL("fixtures/admin-client-baseline.json", import.meta.url), "utf8"));
  const source = await buildBrowserSource(fileURLToPath(new URL("../", import.meta.url)));
  const generated = browserModule(source);
  assert.equal(generated, await readFile(new URL("../apps/worker/src/generated-admin-client.ts", import.meta.url), "utf8"));
  for (const { nonce, sha256 } of baseline.cases) {
    assert.equal(createHash("sha256").update(adminScript(nonce ?? undefined)).digest("hex"), sha256);
  }
});

async function browserFixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/worker/src"), { recursive: true });
  const directory = join(root, "apps/worker/browser");
  for (const [name, source] of Object.entries(sources)) {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

test("browser bundling is deterministic across roots and does not execute DOM code", async t => {
  const sources = {
    "admin-client.js": 'import { bind } from "./central/controller.js"; bind(document);',
    "central/controller.js": 'export function bind(root) { throw new Error(root.title); }',
  };
  const first = await browserFixture(t, sources), second = await browserFixture(t, sources);
  const source = await buildBrowserSource(first);
  assert.equal(source, await buildBrowserSource(second));
  assert.equal(source, await buildBrowserSource(first));
  assert.doesNotThrow(() => browserModule(source));
  await writeBrowserAssets(first);
  assert.equal(await readFile(join(first, "apps/worker/src/generated-admin-client.ts"), "utf8"), browserModule(source));
});

for (const [name, entry, dependency] of [
  ["external packages", 'import "third-party";', {}],
  ["parent source escape", 'import "../outside.js";', { "../outside.js": "console.log('outside');" }],
  ["dynamic imports", 'import("./lazy.js");', { "lazy.js": "console.log('lazy');" }],
  ["computed dynamic imports", 'const path = location.hash; import(path);', {}],
  ["CommonJS imports", 'require("./lazy.js");', { "lazy.js": "console.log('lazy');" }],
  ["computed CommonJS imports", 'const path = location.hash; require(path);', {}],
]) {
  test("browser bundler rejects " + name, async t => {
    const root = await browserFixture(t, { "admin-client.js": entry, ...dependency });
    await assert.rejects(buildBrowserSource(root), /invalid_browser_dependency/u);
  });
}

test("browser bundler rejects oversized dependency graphs before writing output", async t => {
  const root = await browserFixture(t, {
    "admin-client.js": 'import "./large.js";\n/*' + "a".repeat(70 * 1024) + '*/',
    "large.js": '/*' + "b".repeat(70 * 1024) + '*/',
  });
  await assert.rejects(writeBrowserAssets(root), /invalid_browser_source/u);
  await assert.rejects(readFile(join(root, "apps/worker/src/generated-admin-client.ts")), { code: "ENOENT" });
});

test("browser bundler rejects symlink dependencies", async t => {
  const root = await browserFixture(t, {
    "admin-client.js": 'import "./alias/module.js";',
    "real/module.js": "console.log('linked');",
  });
  const directory = join(root, "apps/worker/browser");
  await symlink(join(directory, "real"), join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildBrowserSource(root), /invalid_browser_dependency/u);
});
test("browser syntax checking never executes the source", () => {
  assert.doesNotThrow(() => browserModule('throw new Error("must not execute");'));
  assert.throws(() => browserModule("function {"));
  assert.throws(() => browserModule("x".repeat(128 * 1024 + 1)));
  assert.throws(() => browserModule("</" + "script>"));
});
