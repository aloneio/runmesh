import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import type { SkillAdminPorts, SkillMutation, SkillInspection, SkillLibraryPage } from "../../contracts/skills.js";
import { makeSkillBundle } from "../../domain/skills/bundle.js";
import { parseSkillCommand, skillDigest } from "../../contracts/skill-values.js";
import { skillInstallation } from "../../domain/skills/install.js";

/** Administrator installation and publication use the Registry session authority. */
export function createSkillAdministration(ports: SkillAdminPorts) {
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
          // Pausing keeps the selected version. A newer upload is reviewed separately.
          const selected = head.active_digest ?? head.staged_digest;
          const summary = ports.repository.summary(head.skill_id, selected);
          if (!summary || summary.skill_id !== head.skill_id || summary.digest !== selected) throw new Error("skill_summary_invalid");
          return { head, summary };
        });
        return { state: "listed", skills, next_after: heads.length > 50 ? skills[49]!.head.skill_id : null };
      } catch { return { state: "unavailable" }; }
    },
    async mutate(hash: string, input: unknown, signal: AbortSignal): Promise<SkillMutation> {
      try {
        const command = parseSkillCommand(input);
        if (!command) return { state: "invalid" };
        const admin = await ports.admin(hash, signal);
        if (signal.aborted) return { state: "unavailable" };
        if (admin !== "allowed") return { state: admin };
        switch (command.action) {
          case "preview":
          case "stage": {
            const bundle = await makeSkillBundle(command.bundle, ports.digest);
            if (!bundle) return { state: "invalid" };
            const final = await ports.admin(hash, signal);
            if (signal.aborted) return { state: "unavailable" };
            if (final !== "allowed") return { state: final };
            return command.action === "preview" ? { state: "previewed", bundle } : ports.repository.stage(bundle, command.expected_revision);
          }
          case "activate": return ports.repository.activate(command.skill_id, command.digest, command.expected_revision);
          case "disable": return ports.repository.disable(command.skill_id, command.expected_revision);
        }
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
  };
}
