import { SKILL_LIMITS, type SkillBundle, type SkillFile } from "../../contracts/skills.js";
import { isCapabilityIdentifier, parseCapabilityTarget, type CapabilityTarget } from "../../contracts/capabilities.js";
import { skillFrontmatter } from "./frontmatter.js";
import { skillDigest, skillObject, skillPath } from "../../contracts/skill-values.js";
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function text(value: unknown, max: number, required = true): value is string {
  return typeof value === "string" && (!required || value.trim().length > 0) && bytes(value) <= max && !value.includes(String.fromCharCode(0));
}
/** Text collections only. Frontmatter stays content, never authority. */
function parseBundle(input: unknown, stored: boolean): Omit<SkillBundle, "digest"> | undefined {
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
  const body = files.find(f => f.path === "SKILL.md")?.text;
  if (body === undefined) return undefined;
  // Persisted metadata is part of the original content digest. A parser update
  // must not reinterpret a previously installed description or change its ID.
  const metadata = stored ? value : skillFrontmatter(body);
  const name = metadata?.name, description = metadata?.description;
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
export function parseSkillBundle(input: unknown): Omit<SkillBundle, "digest"> | undefined {
  return parseBundle(input, false);
}
export async function makeSkillBundle(input: unknown, hash: (text: string) => Promise<string>): Promise<SkillBundle | undefined> {
  const parsed = parseSkillBundle(input);
  if (!parsed) return undefined;
  const digest = await hash(JSON.stringify(parsed));
  return skillDigest(digest) ? { ...parsed, digest } : undefined;
}

/** Verify immutable stored bytes without reparsing metadata under newer rules. */
export async function verifySkillBundle(input: unknown, hash: (text: string) => Promise<string>): Promise<SkillBundle | undefined> {
  const value = skillObject(input), parsed = parseBundle(input, true);
  if (!parsed || value?.schema_version !== 1 || !skillDigest(value.digest)) return undefined;
  const digest = await hash(JSON.stringify(parsed));
  return digest === value.digest ? { ...parsed, digest } : undefined;
}
