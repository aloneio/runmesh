import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export function validateReleaseHealth(health) {
  assert.equal(health?.ok,true,"public Worker is not healthy");
  assert.equal(health?.service,"runmesh-agent-control-plane");
  assert.equal(health?.worker_id,"worker-production");
  assert.equal(health?.release_gate?.test_mode_disabled,true,"production test mode must be disabled");
  assert.equal(health?.release_gate?.canonical_public_origin_configured,true);
  assert.equal(health?.release_readiness?.contract,"release-chain-audit-v1","audited Worker is not deployed");
  assert.equal(health?.release_readiness?.rpc_authorization_complete,true,"final RPC authorization is incomplete");
  assert.equal(health?.job_history?.backend,"packed_d1");
  assert.equal(health?.job_history?.protocol,1,"batched history negotiation is unavailable");
  assert.equal(health?.audit_history?.backend,"d1");
  assert.equal(health?.audit_history?.binding_configured,true,"history storage is not bound");
}

async function main() {
  const configuredOrigin = process.argv[2] ?? process.env.RUNMESH_RELEASE_PREFLIGHT_ORIGIN;
  assert.equal(typeof configuredOrigin, "string", "Supply the deployed HTTPS origin explicitly; release preflight configuration is not a Worker runtime variable");
  const origin = new URL(configuredOrigin);
  assert.equal(origin.protocol, "https:"); assert.equal(origin.origin, configuredOrigin);
  const response=await fetch(new URL("/health",origin),{redirect:"error",signal:AbortSignal.timeout(15000),headers:{"cache-control":"no-cache"}});
  assert.equal(response.status,200,"public control plane is unavailable");
  const text=await response.text();assert.ok(text.length<65536,"oversized health response");
  const health=JSON.parse(text);validateReleaseHealth(health);
  console.log(JSON.stringify({live_release_preflight:"passed",worker_version:health.worker_version,contract:health.release_readiness.contract,history_backend:health.job_history.backend}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
