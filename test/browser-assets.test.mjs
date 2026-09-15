import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { browserModule } from "../scripts/generate-browser-assets.mjs";
import { adminScript } from "../apps/worker/dist/admin/client-script.js";

test("standalone browser source preserves original rendered script hashes", async () => {
  const baseline = JSON.parse(await readFile(new URL("fixtures/admin-client-baseline.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../apps/worker/browser/admin-client.js", import.meta.url), "utf8");
  const generated = browserModule(source);
  assert.ok(generated.includes(JSON.stringify(source)));
  for (const { nonce, sha256 } of baseline.cases) {
    assert.equal(createHash("sha256").update(adminScript(nonce ?? undefined)).digest("hex"), sha256);
  }
});
test("browser syntax checking never executes the source", () => {
  assert.doesNotThrow(() => browserModule('throw new Error("must not execute");'));
  assert.throws(() => browserModule("function {"));
  assert.throws(() => browserModule("x".repeat(128 * 1024 + 1)));
  assert.throws(() => browserModule("</" + "script>"));
});
