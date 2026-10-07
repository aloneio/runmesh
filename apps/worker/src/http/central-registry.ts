import type { WorkerEnv } from "../platform/env.js";
import { MCP_REGISTRY_LIMITS } from "../contracts/mcp-registry.js";
import { previewRegistryEntry } from "../domain/connectors/registry-entry.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";
import { sha256Hex } from "../security.js";

export async function handleRegistryPreview(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (request.method !== "POST" || url.search) { cancelCentralBody(request); return centralFailure("central_invalid_request", 400); }
  const admission = await admitCentralAdmin(request, env, MCP_REGISTRY_LIMITS.bytes);
  if (admission instanceof Response) return admission;
  if (Object.keys(admission.body).some(key => key !== "entry")) return centralFailure("central_invalid_request", 400);
  const preview = previewRegistryEntry(admission.body.entry);
  if (!preview) return centralFailure("registry_invalid_entry", 400);
  return Response.json({ ...preview, digest: await sha256Hex(JSON.stringify(admission.body.entry)), observed_at_ms: Date.now() }, { headers: centralHeaders });
}
