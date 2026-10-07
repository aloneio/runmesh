import type { WorkerEnv } from "../platform/env.js";
import { SKILL_SOURCE_LIMITS, type CentralSkillSource } from "../contracts/skill-source.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";
import { verifySkillBundle } from "../domain/skills/bundle.js";
import { skillObject, skillDigest } from "../contracts/skill-values.js";
import { parseSkillSource, skillSourceUrl } from "../contracts/skill-source-values.js";
import { isCapabilityIdentifier } from "../contracts/capabilities.js";
import { sha256Hex } from "../security.js";

export async function handleSkillSource(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CENTRAL_SKILLS_ENABLED !== "1") { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  const action = url.pathname === "/admin/central/skill-source/preview" ? "preview" : url.pathname === "/admin/central/skill-source/install" ? "install" : undefined;
  if (!action || request.method !== "POST" || url.search) { cancelCentralBody(request); return centralFailure("central_invalid_request", 400); }
  const admission = await admitCentralAdmin(request, env, 4096);
  if (admission instanceof Response) return admission;
  const requestedSource = parseSkillSource(admission.body.source);
  if (!requestedSource || !Number.isSafeInteger(admission.body.expected_revision) || (admission.body.expected_revision as number) < 0
    || (admission.body.expected_revision as number) >= Number.MAX_SAFE_INTEGER
    || Object.keys(admission.body).some(key => !["source", "expected_revision", "digest"].includes(key))
    || (action === "install" && !skillDigest(admission.body.digest))) return centralFailure("skill_source_invalid", 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralSkillSource;
    const result = skillObject(await Promise.race([owner.skillSource(admission.session_hash, action, admission.body),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SKILL_SOURCE_LIMITS.operation_ms + 1000); })]));
    if (action === "preview" && result?.state === "previewed") {
      const source = parseSkillSource(result.source), bundle = await verifySkillBundle(result.bundle, sha256Hex);
      if (source && JSON.stringify(source) === JSON.stringify(requestedSource) && bundle && bundle.source === skillSourceUrl(source))
        return Response.json({ state: "previewed", source, bundle }, { headers: centralHeaders });
    }
    const head = skillObject(result?.head);
    if (action === "install" && result?.state === "written" && head && head.enabled === true
      && head.staged_digest === admission.body.digest && head.active_digest === admission.body.digest && skillDigest(head.active_digest)
      && Number.isSafeInteger(head.revision) && head.revision === Number(admission.body.expected_revision) + 1 && isCapabilityIdentifier(head.skill_id)) {
      return Response.json({ state: "written", head: { skill_id: head.skill_id, revision: head.revision,
        staged_digest: head.staged_digest, active_digest: head.active_digest, enabled: true } }, { headers: centralHeaders });
    }
    if (result?.state === "conflict" && Number.isSafeInteger(result.current_revision))
      return Response.json({ state: "conflict", current_revision: result.current_revision }, { status: 409, headers: centralHeaders });
    if (result?.state === "source_capacity") return centralFailure("skill_source_capacity", 429);
    if (result?.state === "busy") return centralFailure("skill_source_busy", 429);
    if (result?.state === "capacity") return centralFailure("skill_capacity", 429);
    if (result && ["invalid", "missing", "denied", "changed", "unavailable"].includes(String(result.state))) {
      const status = result.state === "invalid" ? 400 : result.state === "missing" ? 404 : result.state === "denied" ? 403
        : result.state === "changed" ? 409 : 503;
      return centralFailure("skill_source_" + result.state, status);
    }
    return centralFailure("central_result_unconfirmed", 503, action === "install" ? "unknown" : "not_started");
  } catch { return centralFailure("central_result_unconfirmed", 503, action === "install" ? "unknown" : "not_started"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
