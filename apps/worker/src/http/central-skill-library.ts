import type { WorkerEnv } from "../platform/env.js";
import type { CentralSkills } from "../contracts/skills.js";
import { isCapabilityIdentifier } from "../contracts/capabilities.js";
import { skillDigest, skillObject } from "../domain/skills/bundle.js";
import { centralFailure, centralHeaders } from "./central-boundary.js";

/** Admin metadata only: file contents require an explicit bundle inspection. */
export async function listSkillLibraryResponse(env: WorkerEnv, hash: string, after?: string): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralSkills;
    const result = await Promise.race([owner.listSkillLibrary(hash, after), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
    if (result?.state !== "listed") {
      return centralFailure(result?.state === "denied" ? "central_admin_denied" : "central_result_unconfirmed", result?.state === "denied" ? 403 : 503);
    }
    if (!Array.isArray(result.skills) || result.skills.length > 50 || (result.next_after !== null && !isCapabilityIdentifier(result.next_after))) throw new Error();
    let previous = after ?? "";
    const skills = result.skills.map(entry => {
      const head = skillObject(entry.head), summary = skillObject(entry.summary);
      if (!head || !summary || !isCapabilityIdentifier(head.skill_id) || head.skill_id <= previous
        || !Number.isSafeInteger(head.revision) || (head.revision as number) < 1 || typeof head.enabled !== "boolean"
        || !skillDigest(head.staged_digest) || (head.active_digest !== null && !skillDigest(head.active_digest)) || (head.enabled && !head.active_digest)
        || summary.skill_id !== head.skill_id || summary.digest !== head.staged_digest
        || typeof summary.name !== "string" || summary.name.length > 64 || typeof summary.description !== "string" || summary.description.length > 1024) throw new Error();
      previous = head.skill_id;
      return { head: { skill_id: head.skill_id, revision: head.revision, staged_digest: head.staged_digest, active_digest: head.active_digest, enabled: head.enabled },
        summary: { name: summary.name, description: summary.description } };
    });
    if (result.next_after !== null && (skills.length !== 50 || result.next_after !== previous)) throw new Error();
    return Response.json({ state: "listed", skills, next_after: result.next_after }, { headers: centralHeaders });
  } catch { return centralFailure("central_result_unconfirmed", 503); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
