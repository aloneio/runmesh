import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import { basename, join } from "node:path";

export function releaseVersion(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid release version: ${tag}`);
  }
  return version;
}

export async function buildManifest(releaseDirectory, tag, publishedAt) {
  const version = releaseVersion(tag);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(publishedAt)) throw new Error("published_at must be a UTC ISO timestamp");
  const names = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".tgz")).sort();
  if (names.length === 0) throw new Error("release contains no tarball artifacts");
  const artifacts = [];
  for (const name of names) {
    const path = join(releaseDirectory, name);
    const bytes = await readFile(path);
    artifacts.push({ name: basename(name), sha256: createHash("sha256").update(bytes).digest("hex"), size: (await stat(path)).size });
  }
  return { schema_version: 1, version, channel: "stable", published_at: publishedAt, artifacts };
}

export async function writeManifest(releaseDirectory, tag, publishedAt) {
  const manifest = await buildManifest(releaseDirectory, tag, publishedAt);
  await writeFile(join(releaseDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function verifyManifestSignature(manifest, signature, publicKey) {
  try {
    return verify(null, manifest, createPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}
