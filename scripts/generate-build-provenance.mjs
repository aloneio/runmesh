import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { writeBuildProvenance } from "./build-provenance.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--require-clean"), "Use generate:provenance [--require-clean]");
const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const info = await writeBuildProvenance(root, process.env, { strict: args.length === 1 || process.env.WORKERS_CI === "1" });
  console.log(JSON.stringify({ build_provenance: info }));
} catch {
  console.error("provenance_unavailable: build identity could not be verified; no deployment was requested");
  process.exitCode = 1;
}
