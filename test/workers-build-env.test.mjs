import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureWorkersBuildEnvironment, GENERATED_ENV, shouldSelectProduction } from "../scripts/configure-workers-build-env.mjs";

async function fixture(gate = "0.1.1") {
  const root = await mkdtemp(join(tmpdir(), "runmesh-workers-build-"));
  await mkdir(join(root, "apps/worker"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.1" }));
  await writeFile(join(root, "apps/worker/wrangler.jsonc"), JSON.stringify({
    name: "runmesh-development",
    vars: { WORKER_ID: "worker-development" },
    env: { production: { name: "runmesh", vars: { WORKER_ID: "worker-production", RUNMESH_PUBLIC_ORIGIN: "https://runmesh.aloneio.workers.dev", RUNMESH_SIGNED_RELEASE_AVAILABLE: gate } } },
  }));
  return root;
}

const cfEnv = { WORKERS_CI: "1", WORKERS_CI_BRANCH: "dev", WORKERS_CI_COMMIT_SHA: "a".repeat(40) };

test("selects production only for the Cloudflare protected dev build", () => {
  assert.equal(shouldSelectProduction(cfEnv), true);
  assert.equal(shouldSelectProduction({ ...cfEnv, WORKERS_CI_BRANCH: "feature/x" }), false);
  assert.equal(shouldSelectProduction({ WORKERS_CI_BRANCH: "dev" }), false);
});

test("writes only the generated production selector after release-contract validation", async () => {
  const root = await fixture();
  try {
    assert.deepEqual(await configureWorkersBuildEnvironment({ repositoryRoot: root, environment: cfEnv }), { configured: true, environment: "production" });
    assert.equal(await readFile(join(root, ".env"), "utf8"), GENERATED_ENV);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fails closed on stale release gate or a pre-existing root env file", async () => {
  const stale = await fixture("0.1.0");
  try { await assert.rejects(configureWorkersBuildEnvironment({ repositoryRoot: stale, environment: cfEnv }), /exact published product version/u); }
  finally { await rm(stale, { recursive: true, force: true }); }
  const existing = await fixture();
  try {
    await writeFile(join(existing, ".env"), "CLOUDFLARE_ENV=staging\n");
    await assert.rejects(configureWorkersBuildEnvironment({ repositoryRoot: existing, environment: cfEnv }), /pre-existing root \.env/u);
  } finally { await rm(existing, { recursive: true, force: true }); }
});
