import type { CodingScope } from "../contracts/administration.js";
import { ControlPlaneUnavailableError } from "../control-plane-errors.js";
import { json } from "../platform/control-plane.js";
import { record } from "../values.js";
import { registryPost } from "../platform/control-plane.js";
import type { VerifiedMcpClient } from "../contracts/mcp-principal.js";
import type { WorkerEnv } from "../platform/env.js";

export async function verifyMcpClient(env: WorkerEnv, secretVerifier: string): Promise<VerifiedMcpClient | undefined> {
  let response: Response;
  try { response = await registryPost(env, "/auth/mcp/verify", { secret_verifier: secretVerifier }); } catch { throw new ControlPlaneUnavailableError(); }
  // Only an authoritative credential rejection means the secret is invalid.
  // Quota errors, a failed DO constructor and malformed upstream replies do
  // not prove revocation and must never turn a working MCP URL into a 404.
  if (response.status === 401 || response.status === 403) return undefined;
  if (response.status === 404) {
    const rejected = record(await json(response));
    if (record(rejected?.error)?.code === "invalid_mcp_credential") return undefined;
  }
  if (!response.ok) throw new ControlPlaneUnavailableError();
  const body = record(await json(response));
  if (body === undefined || typeof body.client_id !== "string" || typeof body.label !== "string" || !Number.isSafeInteger(body.secret_version) || (body.secret_version as number) < 1 || !Array.isArray(body.scopes) || body.scopes.some((scope) => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) throw new ControlPlaneUnavailableError();
  return { client_id: body.client_id, label: body.label, secret_version: body.secret_version as number, scopes: body.scopes as CodingScope[] };
}
