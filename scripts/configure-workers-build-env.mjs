import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GENERATED_ENV = "# Generated only inside Cloudflare Workers Builds for the protected dev branch.\nCLOUDFLARE_ENV=production\n";

function parseJsonc(source) {
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
}

export function shouldSelectProduction(environment = process.env) {
  return environment.WORKERS_CI === "1" && environment.WORKERS_CI_BRANCH === "dev";
}

export async function configureWorkersBuildEnvironment({ repositoryRoot = DEFAULT_ROOT, environment = process.env } = {}) {
  if (!shouldSelectProduction(environment)) return { configured: false };
  assert.match(environment.WORKERS_CI_COMMIT_SHA ?? "", /^[0-9a-f]{40}$/u, "Workers Builds must provide a full commit SHA");
  const pkg = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const config = parseJsonc(await readFile(resolve(repositoryRoot, "apps/worker/wrangler.jsonc"), "utf8"));
  const production = config.env?.production;
  assert.equal(production?.name, "runmesh", "production Worker identity must remain explicit");
  assert.equal(production?.vars?.WORKER_ID, "worker-production", "production Worker ID must remain explicit");
  assert.equal(production?.vars?.RUNMESH_SIGNED_RELEASE_AVAILABLE, pkg.version, "Workers Builds may deploy only the exact published product version");
  assert.match(production?.vars?.RUNMESH_PUBLIC_ORIGIN ?? "", /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/u, "production public origin must be canonical HTTPS");
  assert.notEqual(config.name, production.name, "default Wrangler environment must remain distinct from production");
  const path = resolve(repositoryRoot, ".env");
  let existing;
  try { existing = await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== GENERATED_ENV) throw new Error("refusing to overwrite a pre-existing root .env in Workers Builds");
  await writeFile(path, GENERATED_ENV, { encoding: "utf8", mode: 0o600 });
  return { configured: true, environment: "production" };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureWorkersBuildEnvironment().then((result) => {
    if (result.configured) process.stdout.write("Workers Builds Wrangler environment selected: production\n");
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
