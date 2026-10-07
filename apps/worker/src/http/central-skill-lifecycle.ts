import type { WorkerEnv } from "../platform/env.js";
import { SKILL_LIMITS } from "../contracts/skills.js";
import { SKILL_LIFECYCLE_LIMITS, type CentralSkillLifecycle, type SkillLifecycleAction } from "../contracts/skill-lifecycle.js";
import { skillObject } from "../contracts/skill-values.js";
import { lifecycleRevision } from "../contracts/skill-lifecycle-values.js";
import { projectSkillLifecycleReceipt } from "../contracts/skill-lifecycle-receipts.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";
import { matchIdentifierPath } from "./path-identifiers.js";

export async function handleSkillLifecycleAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CENTRAL_SKILLS_ENABLED !== "1" || !env.CAPABILITIES) { cancelCentralBody(request); return centralFailure("central_skills_disabled", 404); }
  const match = matchIdentifierPath(/^\/admin\/central\/skills\/([^/]+)\/(versions|compare|retention|cleanup-preview|cleanup)$/u, url.pathname);
  if (!match || url.search || request.method !== (match[2] === "versions" ? "GET" : "POST")) { cancelCentralBody(request); return centralFailure("skill_lifecycle_invalid", 400); }
  const action = match[2] as SkillLifecycleAction, id = match[1]!, writes = action === "cleanup" || action === "retention";
  const admission = await admitCentralAdmin(request, env, SKILL_LIFECYCLE_LIMITS.request_bytes); if (admission instanceof Response) return admission;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as CentralSkillLifecycle;
    const raw = await Promise.race([owner.skillLifecycle(admission.session_hash, id, action, admission.body),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SKILL_LIMITS.operation_ms + 1000); })]);
    const result = skillObject(raw);
    if (result && ["invalid", "missing", "denied", "unavailable", "unknown", "conflict", "expired", "protected"].includes(String(result.state))) {
      const status = result.state === "invalid" ? 400 : result.state === "missing" ? 404 : result.state === "denied" ? 403
        : ["conflict", "expired", "protected"].includes(String(result.state)) ? 409 : 503;
      return Response.json({ error: { code: "skill_lifecycle_" + result.state, operation_state: result.state === "unknown" ? "unknown" : "not_started",
        ...(lifecycleRevision(result.current_revision) ? { current_revision: result.current_revision } : {}) } }, { status, headers: centralHeaders });
    }
    const safe = projectSkillLifecycleReceipt(result, action, id, admission.body);
    return safe ? Response.json(safe, { headers: centralHeaders }) : centralFailure("skill_lifecycle_unavailable", 503, writes ? "unknown" : "not_started");
  } catch { return centralFailure("skill_lifecycle_unavailable", 503, writes ? "unknown" : "not_started"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
