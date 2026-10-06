import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sourceCatalog } from "../scripts/check-mcp-connector.mjs";
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const digest = value => createHash("sha256").update(value).digest("hex");
const baseline = JSON.parse(await readFile(new URL("fixtures/public-contract-baseline.json", import.meta.url), "utf8"));
test("public MCP inputs, outputs, descriptions and annotations match the reviewed contract baseline", async () => {
  const catalog = await sourceCatalog(); catalog.tools.sort((a,b) => a.name.localeCompare(b.name));
  assert.deepEqual(catalog.tools.map(tool => tool.name), baseline.tools);
  assert.equal(digest(JSON.stringify(ordered(catalog))), baseline.mcp_catalog_sha256);
});
test("architecture refactoring preserves the checked-in wire schema byte for byte", async () => {
  const schema = await readFile(new URL("../packages/protocol/schema/wire-message.schema.json", import.meta.url));
  assert.equal(digest(schema), baseline.wire_schema_sha256);
});

test("published maintenance v1 client stays frozen while current protocol code evolves", async () => {
  // Preserve the reviewed client derived from the published dev.45 contract.
  // A new protocol gets its own fixture and baseline; changing this fixture
  // together with current schemas would erase the installed-client regression.
  const fixture = await readFile(new URL("../apps/worker/test/fixtures/maintenance-v1-client.ts", import.meta.url), "utf8");
  assert.equal(digest(fixture.replaceAll("\r\n", "\n")), baseline.maintenance_v1.fixture_sha256,
    `Preserve the ${baseline.maintenance_v1.runner_release} maintenance client from ${baseline.maintenance_v1.source_commit}; add a separate fixture for a new protocol`);
});
