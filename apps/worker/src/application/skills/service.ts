import type { CapturedIdentity } from "../../contracts/identity.js";
import { parseClientIdentity } from "../../contracts/identity.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { SKILL_LIMITS, type SkillPorts, type SkillMutation, type SkillInspection, type SkillPage, type SkillContent, type SkillSummary, type SkillDependency, type SkillLibraryPage } from "../../contracts/skills.js";
import { makeSkillBundle, skillDigest, skillObject, skillPath } from "../../domain/skills/bundle.js";
import { skillInstallation } from "../../domain/skills/install.js";

export function createSkillService(ports: SkillPorts) {
  async function authorization(principal: CapturedIdentity, signal: AbortSignal) {
    if (!isCapabilityIdentifier(principal?.client_id) || !Number.isSafeInteger(principal.secret_version) || principal.secret_version < 1) return undefined;
    const result = await ports.identity(principal, signal);
    if (signal.aborted || result.state === "unavailable" || result.state === "malformed") throw new Error("skill_identity_unavailable");
    if (result.state !== "allowed") return undefined;
    const identity = parseClientIdentity(result.identity);
    if (!identity) throw new Error("skill_identity_invalid");
    if (identity.client_id !== principal.client_id || identity.secret_version !== principal.secret_version) return undefined;
    return identity;
  }
  return {
    async install(hash: string, input: unknown, signal: AbortSignal): Promise<SkillMutation> {
      try {
        const installation = skillInstallation(input);
        if (!installation) return { state: "invalid" };
        const initial = await ports.admin(hash, signal);
        if (signal.aborted) return { state: "unavailable" };
        if (initial !== "allowed") return { state: initial };
        const bundle = await makeSkillBundle(installation.bundle, ports.digest);
        if (!bundle) return { state: "invalid" };
        const final = await ports.admin(hash, signal);
        if (signal.aborted) return { state: "unavailable" };
        if (final !== "allowed") return { state: final };
        return ports.repository.install(bundle, installation.revision);
      } catch { return { state: "unavailable" }; }
    },
    async library(hash: string, after: string | undefined, signal: AbortSignal): Promise<SkillLibraryPage> {
      try {
        if (after !== undefined && !isCapabilityIdentifier(after)) return { state: "invalid" };
        const admin = await ports.admin(hash, signal);
        if (signal.aborted) return { state: "unavailable" };
        if (admin !== "allowed") return { state: admin };
        const heads = ports.repository.heads(after ?? "", 51);
        const skills = heads.slice(0, 50).map(head => {
          const summary = ports.repository.summary(head.skill_id, head.staged_digest);
          if (!summary || summary.skill_id !== head.skill_id || summary.digest !== head.staged_digest) throw new Error("skill_summary_invalid");
          return { head, summary };
        });
        return { state: "listed", skills, next_after: heads.length > 50 ? skills[49]!.head.skill_id : null };
      } catch { return { state: "unavailable" }; }
    },
    async mutate(hash: string, input: unknown, signal: AbortSignal): Promise<SkillMutation> {
      try {
        const v = skillObject(input);
        if (!v || !isCapabilityIdentifier(v.skill_id) || !["preview", "stage", "activate", "disable"].includes(String(v.action))) return { state: "invalid" };
        const admin = await ports.admin(hash, signal);
        if (signal.aborted) return { state: "unavailable" };
        if (admin !== "allowed") return { state: admin };
        if (v.action !== "preview" && (!Number.isSafeInteger(v.expected_revision) || (v.expected_revision as number) < 0 || (v.expected_revision as number) >= Number.MAX_SAFE_INTEGER)) return { state: "invalid" };
        if (v.action === "preview" || v.action === "stage") {
          const bundle = await makeSkillBundle(v, ports.digest);
          if (!bundle) return { state: "invalid" };
          const final = await ports.admin(hash, signal);
          if (signal.aborted) return { state: "unavailable" };
          if (final !== "allowed") return { state: final };
          return v.action === "preview" ? { state: "previewed", bundle } : ports.repository.stage(bundle, v.expected_revision as number);
        }
        if (v.action === "activate" && !skillDigest(v.digest)) return { state: "invalid" };
        return v.action === "activate" ? ports.repository.activate(v.skill_id, v.digest as string, v.expected_revision as number)
          : ports.repository.disable(v.skill_id, v.expected_revision as number);
      } catch { return { state: "unavailable" }; }
    },
    async inspect(hash: string, id: string, digest: string | undefined, signal: AbortSignal): Promise<SkillInspection> {
      try {
        if (!isCapabilityIdentifier(id) || (digest !== undefined && !skillDigest(digest))) return { state: "invalid" };
        const admin = await ports.admin(hash, signal);
        if (signal.aborted) return { state: "unavailable" };
        if (admin !== "allowed") return { state: admin };
        const head = ports.repository.head(id), bundle = head && ports.repository.bundle(id, digest ?? head.staged_digest);
        return head && bundle ? { state: "found", head, bundle } : { state: "missing" };
      } catch { return { state: "unavailable" }; }
    },
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
        const bundle = await makeSkillBundle(raw, ports.digest);
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
        const final = await authorization(principal, signal);
        if (!final || ports.repository.head(v.skill_id)?.revision !== head.revision) return { state: "denied" };
        return { state: "read", skill_id: v.skill_id, digest: v.digest, path: file.path, text: file.text, dependencies };
      } catch { return { state: "unavailable" }; }
    },
  };
}
