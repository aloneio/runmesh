import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile("docs/runbooks/catalog.json", "utf8"));
assert.equal(catalog.schema_version, 1, "unsupported runbook catalog schema");
assert.ok(Array.isArray(catalog.runbooks) && catalog.runbooks.length > 0 && catalog.runbooks.length <= 64, "runbook catalog size is invalid");
const ids = new Set();
for (const entry of catalog.runbooks) {
  assert.match(entry.id, /^[a-z0-9][a-z0-9-]{0,63}$/u, "runbook id is invalid");
  assert.ok(!ids.has(entry.id), `duplicate runbook id: ${entry.id}`);
  ids.add(entry.id);
  assert.ok(Number.isSafeInteger(entry.version) && entry.version >= 1, `${entry.id}: version is invalid`);
  assert.match(entry.component, /^[a-z0-9][a-z0-9-]{0,63}$/u, `${entry.id}: component is invalid`);
  assert.match(entry.file, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/u, `${entry.id}: file is invalid`);
  assert.equal(typeof entry.summary, "string");
  assert.ok(entry.summary.length >= 1 && entry.summary.length <= 512, `${entry.id}: summary is invalid`);
  assert.ok(Array.isArray(entry.required_permissions) && entry.required_permissions.length <= 16, `${entry.id}: permissions are invalid`);
  const text = await readFile(`docs/runbooks/${entry.file}`, "utf8");
  assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024, `${entry.id}: runbook exceeds 64 KiB`);
  assert.ok(text.startsWith("# "), `${entry.id}: runbook needs a title`);
  assert.ok(text.includes(`Version: ${entry.version}`), `${entry.id}: document version does not match catalog`);
  assert.ok(text.includes("Applies to:"), `${entry.id}: missing applicability`);
  assert.ok(text.includes("Required permissions:"), `${entry.id}: missing permission declaration`);
  assert.ok(text.includes("## Exit conditions"), `${entry.id}: missing explicit exit conditions`);
}
console.log(`runbook catalog verified: ${catalog.runbooks.length} entries`);
