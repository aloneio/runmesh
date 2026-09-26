import type { WorkerEnv } from "../platform/env.js";
import { parseRemoteEgress } from "../contracts/remote-values.js";
import { loadCipherKey } from "../platform/connectors/keyring.js";

/** Readiness is configuration only, not a claim of upstream availability. */
export async function centralProductSetup(env: WorkerEnv, origin: string) {
  const endpoints = (parseRemoteEgress(env.CENTRAL_MCP_EGRESS) ?? [])
    .map(rule => rule.endpoint).filter(endpoint => new URL(endpoint).origin !== origin);
  let credentialsReady = false;
  if (env.CAPABILITIES !== undefined) {
    try {
      await loadCipherKey(env.CENTRAL_VAULT_KEYRING, undefined, [env.INTERNAL_CONTROL_SECRET, env.RUNNER_TOKEN_PEPPER]);
      credentialsReady = true;
    } catch { /* Only a readiness flag may leave this boundary. */ }
  }
  return { endpoints, credentialsReady };
}
