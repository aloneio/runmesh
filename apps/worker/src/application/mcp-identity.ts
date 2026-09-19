import type { CodingScope } from "../contracts/administration.js";
import { ControlPlaneUnavailableError } from "../control-plane-errors.js";
import { boundedJsonReceipt } from "../platform/bounded-json.js";
import { isSafeIdentifier } from "../security.js";
import { record } from "../values.js";
import { registryRequest } from "../platform/control-plane.js";
import type { VerifiedMcpClient } from "../contracts/mcp-principal.js";
import type { WorkerEnv } from "../platform/env.js";

export async function verifyMcpClient(env: WorkerEnv, secretVerifier: string): Promise<VerifiedMcpClient | undefined> {
  const body = JSON.stringify({ secret_verifier: secretVerifier });
  const response = await boundedJsonReceipt(signal => registryRequest(env, "/auth/mcp/verify", "POST", body, signal), [200, 404]);
  if (response === undefined) throw new ControlPlaneUnavailableError();
  // Only an authoritative credential rejection means the secret is invalid.
  // Quota errors, a failed DO constructor and malformed upstream replies do
  // not prove revocation and must never turn a working MCP URL into a 404.
  if (response.status === 401 || response.status === 403) return undefined;
  if (response.status === 404) {
    const rejected = record(response.value);
    if (record(rejected?.error)?.code === "invalid_mcp_credential") return undefined;
  }
  if (response.status !== 200) throw new ControlPlaneUnavailableError();
  const principal = record(response.value);
  if (principal === undefined || typeof principal.client_id !== "string" || !isSafeIdentifier(principal.client_id)
    || typeof principal.label !== "string" || principal.label.trim().length === 0 || principal.label.length > 256
    || !Number.isSafeInteger(principal.secret_version) || (principal.secret_version as number) < 1
    || !Array.isArray(principal.scopes) || principal.scopes.length === 0 || principal.scopes.length > 3 || new Set(principal.scopes).size !== principal.scopes.length
    || principal.scopes.some(scope => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) throw new ControlPlaneUnavailableError();
  return { client_id: principal.client_id, label: principal.label, secret_version: principal.secret_version as number, scopes: principal.scopes as CodingScope[] };
}
