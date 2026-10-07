import type { SkillBundle } from "../../contracts/skills.js";
import type { SkillFileManifest } from "../../contracts/skill-manifest.js";
import { skillDigest } from "../../contracts/skill-values.js";

/** Derived from original UTF-8 bytes; never included in the stored bundle digest. */
export async function skillFileManifest(bundle: SkillBundle, hash: (text: string) => Promise<string>, stopped: () => boolean = () => false): Promise<SkillFileManifest[]> {
  const files: SkillFileManifest[] = [];
  for (const file of bundle.files) {
    if (stopped()) throw new Error("skill_manifest_interrupted");
    const sha256 = await hash(file.text);
    if (stopped()) throw new Error("skill_manifest_interrupted");
    if (!skillDigest(sha256)) throw new Error("skill_manifest_invalid");
    files.push({ path: file.path, bytes: new TextEncoder().encode(file.text).byteLength, sha256 });
  }
  return files;
}
