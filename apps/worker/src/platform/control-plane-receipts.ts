import { MAX_FRAME_BYTES } from "@aloneio/runmesh-protocol";
import { boundedJsonReceipt, boundedJsonResponse } from "../bounded-json.js";
import type { AuthThrottlePorts, EnrollmentPorts, McpIdentityVerifier, RunnerQueryPorts } from "../contracts/control-plane-receipts.js";
import { hmacHex, isConfiguredSecret, randomBase64Url, sha256Hex } from "../security.js";
import { registryRequest, runnerRpc } from "./control-plane.js";
import type { WorkerEnv } from "./env.js";

export function mcpIdentityVerifier(env: WorkerEnv): McpIdentityVerifier {
  return verifier => boundedJsonReceipt(signal => registryRequest(env, "/auth/mcp/verify", "POST", JSON.stringify({ secret_verifier: verifier, identity_version: 2 }), signal), [200, 404]);
}

export function enrollmentPorts(env: WorkerEnv): EnrollmentPorts {
  return {
    randomCode: randomBase64Url,
    digest: sha256Hex,
    create: (runnerId, payload) => boundedJsonResponse(signal => registryRequest(env, `/runners/${encodeURIComponent(runnerId)}/enrollments`, "POST", JSON.stringify(payload), signal)),
  };
}

/** Callers provide only the Cloudflare edge-populated address, never forwarded headers. */
export function authThrottlePorts(env: WorkerEnv, edgeAddress: string | null): AuthThrottlePorts {
  const source = edgeAddress !== null && /^[0-9a-f:.]{3,64}$/iu.test(edgeAddress) ? edgeAddress.toLowerCase() : "unattributed";
  const sourceHash = async (): Promise<string> => {
    if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) throw new Error("internal control is not configured");
    return hmacHex(env.INTERNAL_CONTROL_SECRET, `runmesh-auth-source:v1:${source}`);
  };
  return {
    check: async kind => {
      const payload = JSON.stringify({ kind, source_hash: await sourceHash() });
      return boundedJsonResponse(signal => registryRequest(env, "/auth/throttle/check", "POST", payload, signal));
    },
    record: async (kind, success) => {
      const payload = JSON.stringify({ kind, source_hash: await sourceHash(), success });
      await boundedJsonResponse(signal => registryRequest(env, "/auth/throttle/record", "POST", payload, signal));
    },
  };
}

export function runnerQueryPorts(env: WorkerEnv): RunnerQueryPorts {
  const read = (runnerId: string, action: string) => boundedJsonResponse(signal => registryRequest(env, `/runners/${encodeURIComponent(runnerId)}/${action}`, "GET", "", signal), 5000, MAX_FRAME_BYTES);
  return {
    execution: id => read(id, "execution-state"),
    readiness: id => read(id, "policy-readiness"),
    rpc: (id, method, params, revision, checksum) => boundedJsonResponse(signal => runnerRpc(env, id, method, params, revision, checksum, signal), 5000, MAX_FRAME_BYTES),
  };
}
