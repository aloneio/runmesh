import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const FIELDS = ["description", "inputSchema", "outputSchema", "annotations"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function normalized(value, field) {
  if ((field === "inputSchema" || field === "outputSchema") && value && typeof value === "object") {
    const { $schema: _dialect, ...schema } = value;
    return canonical(schema);
  }
  return canonical(value);
}
function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

/** Accept a complete tools/list result or a complete host export. No tokens,
 * endpoint URLs, tool results or raw schema values are included in diagnostics. */
export function catalogTools(document) {
  const tools = Array.isArray(document) ? document : document?.result?.tools ?? document?.tools;
  if (!Array.isArray(tools) || tools.length === 0 || tools.length > 128) throw new Error("invalid_catalog");
  if (document?.nextCursor !== undefined || document?.result?.nextCursor !== undefined) throw new Error("incomplete_catalog");
  const names = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)
      || names.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw new Error("invalid_catalog");
    }
    names.add(tool.name);
  }
  return tools;
}

export function compareCatalogs(expectedDocument, observedDocument, mode = "server") {
  if (mode !== "server" && mode !== "host") throw new Error("invalid_comparison_mode");
  const expected = catalogTools(expectedDocument);
  const observed = catalogTools(observedDocument);
  const expectedByName = new Map(expected.map(tool => [tool.name, tool]));
  const observedByName = new Map(observed.map(tool => [tool.name, tool]));
  const missing = expected.filter(tool => !observedByName.has(tool.name)).map(tool => tool.name).sort();
  const unexpected = observed.filter(tool => !expectedByName.has(tool.name)).map(tool => tool.name).sort();
  const changed = [];
  // Hosts commonly expose only callable inputs; do not mistake omission of
  // output schemas/annotations for evidence that their inputs were refreshed.
  const fields = mode === "host" ? ["inputSchema"] : FIELDS;
  for (const tool of expected) {
    const actual = observedByName.get(tool.name);
    if (!actual) continue;
    for (const field of fields) {
      const a = fingerprint(normalized(tool[field], field));
      const b = fingerprint(normalized(actual[field], field));
      if (a !== b) changed.push({ tool: tool.name, field, expected_sha256: a, observed_sha256: b });
    }
  }
  return { state: missing.length || unexpected.length || changed.length ? "mismatch" : "match", missing, unexpected, changed };
}

export function compareLayers(source, { server, host } = {}) {
  catalogTools(source);
  const sourceToServer = server === undefined ? { state: "not_observed" } : compareCatalogs(source, server);
  const sourceToHost = host === undefined ? { state: "not_observed" } : compareCatalogs(source, host, "host");
  const serverToHost = server === undefined || host === undefined ? { state: "not_observed" } : compareCatalogs(server, host, "host");
  const mismatch = [sourceToServer, sourceToHost, serverToHost].some(result => result.state === "mismatch");
  return { schema_version: 1, source_to_server: sourceToServer, source_to_host: sourceToHost,
    server_to_host: serverToHost, mismatch,
    catalog_layers_match: sourceToServer.state === "match" && sourceToHost.state === "match" && serverToHost.state === "match",
    capture_freshness: "not_verified", live_job_verified: false,
    comparison: "canonical JSON comparison, excluding root schema dialect; not semantic-equivalence proof" };
}

export async function readCatalog(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("invalid_catalog");
    if (info.size > MAX_CATALOG_BYTES) throw new Error("catalog_too_large");
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_CATALOG_BYTES + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_CATALOG_BYTES) throw new Error("catalog_too_large");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("invalid_catalog_json"); }
  } finally { await file.close(); }
}

export async function sourceCatalog() {
  const { build } = await import("esbuild");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = await build({ absWorkingDir: root, entryPoints: ["apps/worker/src/mcp/catalog-contract.ts"],
    alias: { "@aloneio/runmesh-protocol": resolve(root, "packages/protocol/src/index.ts") },
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return { tools: module.catalogContract().tools.map(({ name, description, inputSchema, outputSchema, annotations }) =>
    ({ name, description, inputSchema, outputSchema, annotations })) };
}

async function main(args) {
  const allowed = new Set(["--server-catalog", "--host-catalog", "--export-source"]);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("invalid_arguments");
    options.set(key, value);
  }
  if (!options.size) throw new Error("invalid_arguments");
  const source = await sourceCatalog();
  if (options.has("--export-source")) await writeFile(options.get("--export-source"), `${JSON.stringify(source, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const report = compareLayers(source, {
    ...(options.has("--server-catalog") ? { server: await readCatalog(options.get("--server-catalog")) } : {}),
    ...(options.has("--host-catalog") ? { host: await readCatalog(options.get("--host-catalog")) } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
  // Successful export / a matching supplied layer is not end-to-end proof.
  process.exitCode = report.mismatch ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const safeCodes = new Set(["invalid_arguments", "invalid_catalog", "incomplete_catalog", "invalid_catalog_json", "catalog_too_large"]);
    console.error(JSON.stringify({ error: safeCodes.has(error?.message) ? error.message : "catalog_check_failed" }));
    process.exitCode = 2;
  });
}
