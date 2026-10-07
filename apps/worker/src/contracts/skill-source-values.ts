import { SKILL_SOURCE_LIMITS, type SkillSource } from "./skill-source.js";
import { skillObject, skillPath } from "./skill-values.js";

/** The only accepted source is a public GitHub repository at an exact commit. */
export function parseSkillSource(input: unknown): SkillSource | undefined {
  const value = skillObject(input);
  if (!value || Object.keys(value).some(key => !["repository", "commit", "path"].includes(key))
    || typeof value.repository !== "string" || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/u.test(value.commit)
    || typeof value.path !== "string" || value.path.split("/").length > SKILL_SOURCE_LIMITS.directory_depth
    || (value.path !== "" && !skillPath(value.path))) return undefined;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/?$/u.exec(value.repository);
  if (!match || [".", ".."].includes(match[2]!)) return undefined;
  const name = match[2]!.replace(/\.git$/u, "");
  if (!name || [".", ".."].includes(name)) return undefined;
  const repository = "https://github.com/" + match[1] + "/" + name;
  return { repository, commit: value.commit, path: value.path };
}
export const skillSourceUrl = (source: SkillSource) => source.repository + "/tree/" + source.commit + (source.path ? "/" + source.path : "");
