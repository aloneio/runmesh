import type { WorkerEnv } from "../platform/env.js";
import type { CentralConnectorInspection } from "../contracts/connector-inspection.js";
import { REMOTE_CODES, REMOTE_LIMITS } from "../contracts/remote.js";
import { catalogObject } from "../contracts/catalog-json.js";
import { publicMcpEndpoint } from "../contracts/remote-values.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";

export async function handleConnectorInspection(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (request.method !== "POST" || url.search) { cancelCentralBody(request); return centralFailure("central_invalid_request", 400); }
  const admission = await admitCentralAdmin(request, env, 4096);
  if (admission instanceof Response) return admission;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralConnectorInspection;
    const raw = await Promise.race([owner.inspectConnection(admission.session_hash, admission.body, url.origin),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), REMOTE_LIMITS.operation_ms + 1000); })]);
    if (raw?.state === "inspected") {
      const server = catalogObject(raw.server), caps = catalogObject(server?.capabilities);
      if (publicMcpEndpoint(raw.endpoint) && server && typeof server.protocol_version === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(server.protocol_version)
        && caps && ["tools", "resources", "prompts", "tasks", "apps"].every(key => typeof caps[key] === "boolean")
        && (raw.tools_count === null ? caps.tools === false : caps.tools === true && Number.isSafeInteger(raw.tools_count) && raw.tools_count >= 0 && raw.tools_count <= 128)
        && Number.isSafeInteger(raw.observed_at_ms) && raw.observed_at_ms > 0) return Response.json({ state: raw.state, endpoint: raw.endpoint,
          server: { protocol_version: server.protocol_version, capabilities: { tools: caps.tools, resources: caps.resources, prompts: caps.prompts, tasks: caps.tasks, apps: caps.apps } },
          tools_count: raw.tools_count, observed_at_ms: raw.observed_at_ms }, { headers: centralHeaders });
    } else if (raw?.state === "authorization_required") return Response.json({ state: raw.state }, { headers: centralHeaders });
    else if (raw && ["invalid", "denied", "unavailable"].includes(raw.state))
      return centralFailure(raw.code && REMOTE_CODES.includes(raw.code) ? "remote_" + raw.code : "central_" + raw.state, raw.state === "invalid" ? 400 : raw.state === "denied" ? 403 : 503);
    return centralFailure("central_result_unconfirmed", 503);
  } catch { return centralFailure("central_result_unconfirmed", 503); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
