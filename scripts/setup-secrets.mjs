import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { missingSecretNames, generateMissingSecrets, REQUIRED_SECRET_NAMES, CENTRAL_VAULT_SECRET } from "./runtime-config-tools.mjs";

/** Explicit setup action, never part of a Worker request or recurring build. */
export function setupMissingSecrets({ environment, apply = false, invoke }) {
  assert.ok(environment === "production" || environment === "development", "Select --env production|development");
  const target = ["--config", "apps/worker/wrangler.jsonc", "--env", environment];
  const required = environment === "development" ? [...REQUIRED_SECRET_NAMES, CENTRAL_VAULT_SECRET] : REQUIRED_SECRET_NAMES;
  const inventory = () => {
    const result = invoke(["secret", "list", ...target, "--format", "json"]);
    assert.equal(result.status, 0, "Cannot read Cloudflare secret names. Authenticate and deploy the Worker first; no secrets changed.");
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Secret inventory is not valid JSON; no secrets changed."); }
    return missingSecretNames(parsed, required);
  };
  const missing = inventory();
  if (!apply || missing.length === 0) return { environment, required, missing, created: [] };
  // A concurrent administrative update must not be overwritten based on an
  // earlier inventory. Do not run initialization concurrently in two hosts.
  assert.deepEqual(inventory(), missing, "Secret inventory changed; review before retrying.");
  const values = generateMissingSecrets(missing);
  const result = invoke(["secret", "bulk", ...target], JSON.stringify(values));
  // Never forward subprocess output here: diagnostics must not echo input.
  for (const key of Object.keys(values)) delete values[key];
  assert.equal(result.status, 0, "Secret upload outcome is uncertain. Inspect Cloudflare before retrying; no automatic retry was performed.");
  assert.deepEqual(inventory(), [], "Required secrets could not be confirmed; review Cloudflare setup.");
  return { environment, required, missing: [], created: missing };
}

function main() {
  const args = process.argv.slice(2);
  assert.ok((args.length === 2 || args.length === 3) && args[0] === "--env" && (args.length === 2 || args[2] === "--apply"), "Use setup:secrets -- --env production|development [--apply]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  const report = setupMissingSecrets({ environment: args[1], apply: args[2] === "--apply", invoke: (command, input) => {
    const result = spawnSync(process.execPath, [wrangler, ...command], { cwd: root, input, encoding: "utf8", timeout: 120000, maxBuffer: 1048576, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    return { status: result.status ?? 1, stdout: result.stdout ?? "" };
  } });
  console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
