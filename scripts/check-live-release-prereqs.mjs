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

export const MAX_RELEASE_HEALTH_BYTES = 65535;
const MAX_RELEASE_HEALTH_FRAGMENTS = 1024;

/** Bound the response while reading, not after response.text() has already
 * allocated an arbitrary remote body. Injected fetch/signal are test seams;
 * the CLI retains its fixed deadline and explicit public-origin contract. */
export async function readReleaseHealth(configuredOrigin, fetchImpl = fetch, signal = AbortSignal.timeout(15000)) {
  assert.equal(typeof configuredOrigin, "string", "Supply the deployed HTTPS origin explicitly; release preflight configuration is not a Worker runtime variable");
  const origin = new URL(configuredOrigin);
  assert.equal(origin.protocol, "https:"); assert.equal(origin.origin, configuredOrigin);
  signal.throwIfAborted();
  const response = await fetchImpl(new URL("/health", origin), {
    redirect: "error", cache: "no-store", credentials: "omit", signal,
    headers: { accept: "application/json", "cache-control": "no-cache" },
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("public control plane is unavailable");
  }
  assert.ok(response.body, "public control plane returned no health body");
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, fragments = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      assert.ok(++fragments <= MAX_RELEASE_HEALTH_FRAGMENTS, "health response fragment limit exceeded");
      bytes += item.value.byteLength;
      assert.ok(bytes <= MAX_RELEASE_HEALTH_BYTES, "oversized health response");
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
}

async function main() {
  const health = await readReleaseHealth(process.argv[2] ?? process.env.RUNMESH_RELEASE_PREFLIGHT_ORIGIN);
  validateReleaseHealth(health);
  console.log(JSON.stringify({live_release_preflight:"passed",worker_version:health.worker_version,contract:health.release_readiness.contract,history_backend:health.job_history.backend}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
