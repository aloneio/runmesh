import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceCatalog } from "../scripts/check-mcp-connector.mjs";
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const digest = value => createHash("sha256").update(value).digest("hex");
const baseline = JSON.parse(await readFile(new URL("fixtures/public-contract-baseline.json", import.meta.url), "utf8"));
test("architecture refactoring preserves all public MCP inputs, outputs, descriptions and annotations", async () => {
  const catalog = await sourceCatalog(); catalog.tools.sort((a,b) => a.name.localeCompare(b.name));
  assert.deepEqual(catalog.tools.map(tool => tool.name), baseline.tools);
  assert.equal(digest(JSON.stringify(ordered(catalog))), baseline.mcp_catalog_sha256);
});
test("architecture refactoring preserves the checked-in wire schema byte for byte", async () => {
  const schema = await readFile(new URL("../packages/protocol/schema/wire-message.schema.json", import.meta.url));
  assert.equal(digest(schema), baseline.wire_schema_sha256);
});
