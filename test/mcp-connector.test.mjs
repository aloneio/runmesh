import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogTools, compareCatalogs, compareLayers, readCatalog } from "../scripts/check-mcp-connector.mjs";

const job = () => ({ name: "job", description: "Job operations", annotations: { readOnlyHint: false },
  inputSchema: { type: "object", oneOf: ["get", "logs", "cancel", "input"].map(action => ({ type: "object",
    properties: { action: { const: action }, job_id: { type: "string" }, workspace_id: { type: "string" } },
    required: ["action", "job_id"], additionalProperties: false })) }, outputSchema: { type: "object" } });
const catalog = () => ({ tools: [job(), { name: "context", inputSchema: { type: "object" } }] });

test("detects the observed legacy Job schema without workspace_id", () => {
  const source = catalog(), host = structuredClone(source);
  for (const branch of host.tools[0].inputSchema.oneOf) delete branch.properties.workspace_id;
  const result = compareLayers(source, { server: source, host });
  assert.equal(result.source_to_server.state, "match");
  assert.equal(result.server_to_host.state, "mismatch");
  assert.equal(result.server_to_host.changed[0].tool, "job");
  assert.equal(result.catalog_layers_match, false);
});

test("detects a missing tool even when the remaining tool metadata hash is copied", () => {
  const source = catalog(), host = { tools: [{ ...job(), _meta: { "io.runmesh/catalog": { sha256: "a".repeat(64) } } }] };
  assert.deepEqual(compareCatalogs(source, host, "host").missing, ["context"]);
});

test("keeps missing server and host observations explicitly unknown", () => {
  const source = catalog();
  for (const options of [{}, { server: source }, { host: source }]) {
    const report = compareLayers(source, options);
    assert.equal(report.catalog_layers_match, false);
    assert.equal(report.server_to_host.state, "not_observed");
  }
  assert.equal(compareLayers(source, { server: source, host: source }).catalog_layers_match, true);
});

test("separates old deployment from host-only drift", () => {
  const source = catalog(), old = { tools: [job()] };
  const report = compareLayers(source, { server: old, host: old });
  assert.equal(report.source_to_server.state, "mismatch");
  assert.equal(report.server_to_host.state, "match");
  assert.equal(report.catalog_layers_match, false);
});

test("normalizes property ordering and root dialect but still compares bounds", () => {
  const source = catalog(), observed = structuredClone(source);
  observed.tools.reverse();
  observed.tools[1].inputSchema.$schema = "https://json-schema.org/draft/2020-12/schema";
  assert.equal(compareCatalogs(source, observed).state, "match");
  observed.tools[1].inputSchema.oneOf[0].properties.job_id.maxLength = 2;
  assert.equal(compareCatalogs(source, observed).state, "mismatch");
});

test("host input-only checks do not confuse omitted output/annotations with changed inputs", () => {
  const source = catalog(), host = structuredClone(source);
  delete host.tools[0].description; delete host.tools[0].annotations; delete host.tools[0].outputSchema;
  assert.equal(compareCatalogs(source, host, "host").state, "match");
  assert.equal(compareCatalogs(source, host, "server").state, "mismatch");
});

test("refuses partial, duplicate and malformed captures", () => {
  for (const document of [{ tools: [] }, { tools: [job(), job()] }, { tools: [{ name: "job" }] },
    { result: { tools: [job()], nextCursor: "more" } }, { tools: [job()], nextCursor: "more" }]) {
    assert.throws(() => catalogTools(document));
  }
});

test("does not reflect untrusted descriptions, URLs or schema values in mismatch diagnostics", () => {
  const source = catalog(), server = structuredClone(source);
  server.tools[0].description = "https://private.example/secret-credential/mcp";
  server.tools[0].inputSchema.properties = { secret: { const: "never-print-this" } };
  const serialized = JSON.stringify(compareLayers(source, { server }));
  assert.equal(serialized.includes("private.example"), false);
  assert.equal(serialized.includes("never-print-this"), false);
  assert.equal(serialized.includes("secret-credential"), false);
});

test("matching snapshots do not claim fresh captures or successful live Job execution", () => {
  const source = catalog();
  const report = compareLayers(source, { server: source, host: source });
  assert.equal(report.catalog_layers_match, true);
  assert.equal(report.capture_freshness, "not_verified");
  assert.equal(report.live_job_verified, false);
});

test("bounds file reads and rejects malformed JSON without reflecting its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh-catalog-test-"));
  try {
    const path = join(directory, "catalog.json");
    await writeFile(path, JSON.stringify(catalog()));
    assert.deepEqual(await readCatalog(path), catalog());
    await writeFile(path, "secret-not-json");
    await assert.rejects(readCatalog(path), { message: "invalid_catalog_json" });
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(readCatalog(path), { message: "catalog_too_large" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
