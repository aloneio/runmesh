import type { WorkerEnv } from "../platform/env.js";
import { SKILL_LIMITS, type CentralSkills } from "../contracts/skills.js";
import { skillInstallation } from "../domain/skills/install.js";
import { skillDigest, skillObject } from "../domain/skills/bundle.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";

export async function handleSkillInstallation(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (env.CENTRAL_SKILLS_ENABLED !== "1") { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  if (request.method !== "POST" || url.search) {
    cancelCentralBody(request); return centralFailure("central_invalid_request", 400);
  }
  const admission = await admitCentralAdmin(request, env, SKILL_LIMITS.request_bytes);
  if (admission instanceof Response) return admission;
  const installation = skillInstallation(admission.body);
  if (!installation) return centralFailure("skill_invalid_package", 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralSkills;
    const result = skillObject(await Promise.race([owner.installSkill(admission.session_hash, admission.body),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), SKILL_LIMITS.operation_ms + 1000); })]));
    const head = skillObject(result?.head);
    if (result?.state === "written" && head?.skill_id === installation.bundle.skill_id && head.revision === installation.revision + 1
      && head.enabled === true && skillDigest(head.active_digest) && head.staged_digest === head.active_digest) {
      return Response.json({ state: "installed", skill_id: head.skill_id, name: installation.bundle.name, description: installation.bundle.description, revision: head.revision, digest: head.active_digest }, { headers: centralHeaders });
    }
    if (result?.state === "conflict" && Number.isSafeInteger(result.current_revision) && (result.current_revision as number) >= 0) {
      return Response.json({ state: "conflict", skill_id: installation.bundle.skill_id, current_revision: result.current_revision }, { status: 409, headers: centralHeaders });
    }
    if (result && ["invalid", "denied", "capacity", "unavailable"].includes(String(result.state))) {
      return centralFailure("skill_" + result.state, result.state === "invalid" ? 400 : result.state === "denied" ? 403 : result.state === "capacity" ? 429 : 503);
    }
    return centralFailure("central_result_unconfirmed", 503, "unknown");
  } catch { return centralFailure("central_result_unconfirmed", 503, "unknown"); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
