import type { RegistryRoute } from "./request.js";
import type { ClientIdentity } from "../../contracts/identity.js";
import type { VerifiedMcpClient } from "../records.js";
import { stringField } from "../values.js";

export interface IdentityRoutePorts {
  revalidateMcpIdentity(clientId: unknown, secretVersion: unknown): ClientIdentity | undefined;
  revalidateMcpClient(clientId: unknown, secretVersion: unknown, includeJobRecording?: boolean): VerifiedMcpClient | undefined;
  authorizeMcpRpc(input: Record<string, unknown>): { ok: true; record_history?: boolean } | { ok: false; code: string };
  verifyMcpIdentity(secretVerifier: string, nowMs: number): ClientIdentity | undefined;
  verifyMcpClient(secretVerifier: string, nowMs: number): VerifiedMcpClient | undefined;
}

/** Parsing and responses only; authority and transactions stay with RegistryDO. */
export function createIdentityRoutes(ports: IdentityRoutePorts): RegistryRoute {
  return ({ method, segments, input, nowMs }) => {
    const action = segments[0]; const clientId = segments[1];
    if (method === "POST" && action === "mcp" && clientId === "revalidate") {
      if (input.identity_version !== undefined && input.identity_version !== 2) return new Response("unsupported identity version", { status: 400 });
      const client = input.identity_version === 2 ? ports.revalidateMcpIdentity(input.client_id, input.secret_version)
        : ports.revalidateMcpClient(input.client_id, input.secret_version);
      return client === undefined ? new Response("not found", { status: 404 }) : Response.json(client);
    }
    if (method === "POST" && action === "mcp" && clientId === "authorize-rpc") {
      const decision = ports.authorizeMcpRpc(input);
      return Response.json(decision, { status: decision.ok ? 200 : decision.code === "stale_policy" ? 409 : 403 });
    }
    if (method === "POST" && action === "mcp" && clientId === "verify") {
      if (input.identity_version !== undefined && input.identity_version !== 2) return new Response("unsupported identity version", { status: 400 });
      const verifier = stringField(input, "secret_verifier", 64);
      const client = verifier === undefined ? undefined : input.identity_version === 2 ? ports.verifyMcpIdentity(verifier, nowMs) : ports.verifyMcpClient(verifier, nowMs);
      return client === undefined ? Response.json({ error: { code: "invalid_mcp_credential" } }, { status: 404 }) : Response.json(client);
    }
    return undefined;
  };
}
