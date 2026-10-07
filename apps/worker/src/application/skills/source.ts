import type { SkillSourcePorts, SkillSourceResult } from "../../contracts/skill-source.js";
import { makeSkillBundle } from "../../domain/skills/bundle.js";
import { skillDigest, skillObject } from "../../contracts/skill-values.js";
import { parseSkillSource, skillSourceUrl } from "../../contracts/skill-source-values.js";
import { skillFrontmatter } from "../../domain/skills/frontmatter.js";

/** Preview and install fetch the same immutable commit through a source port.
 * Installation reuses the existing atomic content/head publication transaction. */
export function createSkillSourceService(ports: SkillSourcePorts) {
  return async (hash: string, action: "preview" | "install", input: unknown, signal: AbortSignal): Promise<SkillSourceResult> => {
    let installing = false;
    try {
      const value = skillObject(input), source = parseSkillSource(value?.source);
      if (!value || !source || Object.keys(value).some(key => !["source", "expected_revision", "digest"].includes(key))
        || !Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 0
        || (value.expected_revision as number) >= Number.MAX_SAFE_INTEGER
        || (action === "install" && !skillDigest(value.digest))) return { state: "invalid" };
      const initial = await ports.admin(hash, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (initial !== "allowed") return { state: initial };
      const read = await ports.source.read(source, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (read.state !== "read") return read.state === "capacity" ? { state: "source_capacity" } : read;
      const metadata = skillFrontmatter(read.files.find(file => file.path === "SKILL.md")?.text ?? "");
      const bundle = await makeSkillBundle({ skill_id: metadata?.name, files: read.files, source: skillSourceUrl(source),
        license: typeof metadata?.license === "string" ? metadata.license : "" }, ports.digest);
      if (!bundle) return { state: "invalid" };
      const final = await ports.admin(hash, signal);
      if (signal.aborted) return { state: "unavailable" };
      if (final !== "allowed") return { state: final };
      if (action === "preview") return { state: "previewed", source, bundle };
      if (bundle.digest !== value.digest) return { state: "changed" };
      installing = true;
      const result = ports.repository.install(bundle, value.expected_revision as number);
      return result.state === "previewed" ? { state: "unknown" } : result;
    } catch { return { state: installing ? "unknown" : "unavailable" }; }
  };
}
