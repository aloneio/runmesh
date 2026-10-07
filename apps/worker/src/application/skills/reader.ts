import type { CapturedIdentity } from "../../contracts/identity.js";
import { capturedIdentityState } from "../../contracts/identity.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { SKILL_LIMITS, type SkillReadPorts, type SkillPage, type SkillContent, type SkillSummary, type SkillDependency } from "../../contracts/skills.js";
import { verifySkillBundle } from "../../domain/skills/bundle.js";
import { skillDigest, skillObject, skillPath } from "../../contracts/skill-values.js";
import { skillFileManifest } from "../../domain/skills/manifest.js";

/** Client reads have no publication ports or administrator-session dependency. */
export function createSkillReader(ports: SkillReadPorts) {
  async function authorization(principal: CapturedIdentity, signal: AbortSignal) {
    if (!isCapabilityIdentifier(principal?.client_id) || !Number.isSafeInteger(principal.secret_version) || principal.secret_version < 1) return undefined;
    const result = await ports.identity(principal, signal);
    if (signal.aborted) throw new Error("skill_identity_unavailable");
    const state = capturedIdentityState(principal, result);
    if (state === "unavailable") throw new Error("skill_identity_unavailable");
    return state === "allowed";
  }
  return {
    async list(principal: CapturedIdentity, query: unknown, signal: AbortSignal): Promise<SkillPage> {
      try {
        const v = skillObject(query);
        if (!v || Object.keys(v).some(k => !["skill_id", "after"].includes(k))
          || (v.skill_id !== undefined && !isCapabilityIdentifier(v.skill_id))
          || (v.after !== undefined && (!isCapabilityIdentifier(v.after) || v.skill_id !== undefined))) return { state: "invalid" };
        if (!await authorization(principal, signal)) return { state: "denied" };
        const selected = v.skill_id === undefined ? undefined : ports.repository.head(v.skill_id as string);
        const heads = v.skill_id === undefined ? ports.repository.heads((v.after as string | undefined) ?? "", SKILL_LIMITS.page + 1) : selected ? [selected] : [];
        const page = heads.slice(0, SKILL_LIMITS.page);
        const skills: SkillSummary[] = [];
        for (const head of page) {
          if (!head.enabled) continue;
          if (!head.active_digest || !ports.repository.approved(head.skill_id, head.active_digest)) throw new Error("skill_publication_invalid");
          const summary = ports.repository.summary(head.skill_id, head.active_digest);
          if (!summary || summary.skill_id !== head.skill_id || summary.digest !== head.active_digest) throw new Error("skill_summary_invalid");
          skills.push({ ...summary, revision: head.revision });
        }
        const final = await authorization(principal, signal);
        if (!final || page.some(head => ports.repository.head(head.skill_id)?.revision !== head.revision)) return { state: "denied" };
        skills.sort((a, b) => (a.skill_id + a.digest).localeCompare(b.skill_id + b.digest));
        return { state: "listed", skills, next_after: heads.length > SKILL_LIMITS.page ? page.at(-1)!.skill_id : null };
      } catch { return { state: "unavailable" }; }
    },
    async read(principal: CapturedIdentity, input: unknown, signal: AbortSignal): Promise<SkillContent> {
      try {
        const v = skillObject(input);
        if (!v || Object.keys(v).some(k => !["skill_id", "digest", "path"].includes(k)) || !isCapabilityIdentifier(v.skill_id) || !skillDigest(v.digest) || !skillPath(v.path)) return { state: "invalid" };
        if (!await authorization(principal, signal)) return { state: "denied" };
        const head = ports.repository.head(v.skill_id);
        if (!head?.enabled || head.active_digest !== v.digest || !ports.repository.approved(v.skill_id, v.digest)) return { state: "denied" };
        const raw = ports.repository.bundle(v.skill_id, v.digest);
        if (!raw) return { state: "missing" };
        const bundle = await verifySkillBundle(raw, ports.digest);
        if (!bundle || bundle.digest !== v.digest || bundle.skill_id !== v.skill_id) return { state: "unavailable" };
        const file = bundle.files.find(f => f.path === v.path);
        if (!file) return { state: "missing" };
        const dependencies: SkillDependency[] = [];
        for (const target of bundle.required_capabilities ?? []) {
          if (signal.aborted) return { state: "unavailable" };
          let state: SkillDependency["state"];
          // Advisory publication status; dependencies never enable or execute capabilities.
          try {
            if (target.kind === "skill") {
              const dependency = ports.repository.head(target.resource_id);
              state = !dependency ? "not_configured" : !dependency.enabled ? "disabled"
                : dependency.active_digest === target.version && ports.repository.approved(target.resource_id, target.version) ? "configured" : "incompatible";
            } else state = await ports.remoteDependency?.(target, signal) ?? "unavailable";
          } catch { state = "unavailable"; }
          dependencies.push({ target, state });
        }
        const files = file.path === "SKILL.md" ? await skillFileManifest(bundle, ports.digest, () => signal.aborted) : undefined;
        const final = await authorization(principal, signal);
        if (!final || ports.repository.head(v.skill_id)?.revision !== head.revision) return { state: "denied" };
        return { state: "read", skill_id: v.skill_id, digest: v.digest, path: file.path, text: file.text, dependencies, ...(files ? { files } : {}) };
      } catch { return { state: "unavailable" }; }
    },
  };
}
