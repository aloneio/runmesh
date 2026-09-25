import type { CentralAuditAdministration } from "../contracts/central-audit.js";
import type { WorkerEnv } from "../platform/env.js";
import { isCapabilityIdentifier } from "../contracts/capabilities.js";
import { REMOTE_CODES, type RemoteCode } from "../contracts/remote.js";
import { admitCentralAdmin, centralFailure, centralHeaders, cancelCentralBody } from "./central-boundary.js";
export async function handleCentralReceipts(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CENTRAL_GOVERNANCE_ENABLED !== "1" || request.method !== "GET" || url.search) { cancelCentralBody(request); return centralFailure("central_not_found", 404); }
  const admission = await admitCentralAdmin(request, env, 0);
  if (admission instanceof Response) return admission;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralAuditAdministration;
    const result = await Promise.race([owner.listCentralReceipts(admission.session_hash), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
    if (!result) return centralFailure("central_unavailable", 503);
    if (result.state !== "listed") return centralFailure(result.state === "denied" ? "central_denied" : "central_unavailable", result.state === "denied" ? 403 : 503);
    if (!Array.isArray(result.receipts) || result.receipts.length > 50) return centralFailure("central_unavailable", 503);
    const receipts = result.receipts.map(row => {
      if (!/^[a-f0-9-]{36}$/u.test(row.request_id) || !isCapabilityIdentifier(row.client_id) || !isCapabilityIdentifier(row.profile_id)
        || !isCapabilityIdentifier(row.tool_id) || !/^[a-f0-9]{64}$/u.test(row.version)
        || !["not_started", "completed", "unknown"].includes(row.operation_state) || (row.code !== "completed" && !REMOTE_CODES.includes(row.code as RemoteCode))
        || !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) throw new Error("central_receipt_invalid");
      return { request_id: row.request_id, client_id: row.client_id, profile_id: row.profile_id, tool_id: row.tool_id, version: row.version,
        operation_state: row.operation_state, code: row.code, created_at_ms: row.created_at_ms };
    });
    return Response.json({ state: "listed", receipts }, { headers: centralHeaders });
  } catch { return centralFailure("central_unavailable", 503); } finally { if (timer !== undefined) clearTimeout(timer); }
}
