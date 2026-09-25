import { SKILL_LIMITS, type SkillBundle, type SkillFile } from "../../contracts/skills.js";
import { isCapabilityIdentifier, parseCapabilityTarget, type CapabilityTarget } from "../../contracts/capabilities.js";

export const skillDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export function skillObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function skillPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9._/-]+$/u.test(value)) return false;
  const parts = value.split("/");
  return parts.every(p => p !== "" && p !== "." && p !== ".." && !p.endsWith(".")
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:[.]|$)/iu.test(p));
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function text(value: unknown, max: number, required = true): value is string {
  return typeof value === "string" && (!required || value.trim().length > 0) && bytes(value) <= max && !value.includes(String.fromCharCode(0));
}
/** Text collections only. Frontmatter stays content, never authority.
 * The first importer supports bounded scalar name/description fields. */
export function parseSkillBundle(input: unknown): Omit<SkillBundle, "digest"> | undefined {
  const value = skillObject(input);
  if (!value || !isCapabilityIdentifier(value.skill_id) || !text(value.source, 2048, false) || !text(value.license, 256, false)
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > SKILL_LIMITS.files) return undefined;
  const files: SkillFile[] = [], paths = new Set<string>();
  for (const entry of value.files) {
    const file = skillObject(entry);
    if (!file || Object.keys(file).some(k => k !== "path" && k !== "text") || !skillPath(file.path)
      || !text(file.text, SKILL_LIMITS.file_bytes, false) || paths.has(file.path.toLowerCase())) return undefined;
    paths.add(file.path.toLowerCase()); files.push({ path: file.path, text: file.text });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const nl = String.fromCharCode(10), body = files.find(f => f.path === "SKILL.md")?.text.replaceAll(String.fromCharCode(13), "");
  if (!body?.startsWith("---" + nl)) return undefined;
  const end = body.indexOf(nl + "---" + nl, 4);
  if (end < 0 || end > 8192) return undefined;
  const lines = body.slice(4, end).split(nl);
  const scalar = (key: string) => {
    const matches = lines.filter(line => line.startsWith(key + ":"));
    if (matches.length !== 1) return undefined;
    const result = matches[0]!.slice(key.length + 1).trim();
    if (!result || ["|", ">", "&", "*"].includes(result[0]!)) return undefined;
    const quote = result.charCodeAt(0);
    return (quote === 34 || quote === 39) && result.charCodeAt(result.length - 1) === quote ? result.slice(1, -1) : result;
  };
  const name = scalar("name"), description = scalar("description");
  if (!text(name, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || !text(description, 1024)) return undefined;
  // Runmesh-specific JSON sidecar; frontmatter never becomes permission policy.
  const sidecar = files.find(f => f.path === "runmesh.json");
  let required: CapabilityTarget[] | undefined;
  if (sidecar) {
    let manifest: Record<string, unknown> | undefined;
    try { manifest = skillObject(JSON.parse(sidecar.text)); } catch { return undefined; }
    if (!manifest || manifest.schema_version !== 1 || Object.keys(manifest).some(k => !["schema_version", "requiredCapabilities"].includes(k))
      || !Array.isArray(manifest.requiredCapabilities) || manifest.requiredCapabilities.length > SKILL_LIMITS.dependencies) return undefined;
    required = [];
    const seen = new Set<string>();
    for (const raw of manifest.requiredCapabilities) {
      const target = parseCapabilityTarget(raw), object = skillObject(raw);
      if (!target || !object || Object.keys(object).some(k => !Object.hasOwn(target, k))) return undefined;
      const key = JSON.stringify(target);
      if (seen.has(key)) return undefined;
      seen.add(key); required.push(target);
    }
  }
  const bundle = { schema_version: 1 as const, skill_id: value.skill_id, name, description, source: value.source, license: value.license, files,
    ...(required === undefined ? {} : { required_capabilities: required }) };
  return bytes(JSON.stringify(bundle)) <= SKILL_LIMITS.bundle_bytes ? bundle : undefined;
}
export async function makeSkillBundle(input: unknown, hash: (text: string) => Promise<string>): Promise<SkillBundle | undefined> {
  const parsed = parseSkillBundle(input);
  if (!parsed) return undefined;
  const digest = await hash(JSON.stringify(parsed));
  return skillDigest(digest) ? { ...parsed, digest } : undefined;
}
