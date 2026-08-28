import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./release-manifest.mjs";
import { verifyReleaseManifest } from "./release-signature.mjs";

export async function verifyReleaseAssets({ manifestPath, signaturePath, descriptorPath, keyringPath, expectedKeyId, expectedVersion }) {
  await verifyReleaseManifest({ manifestPath, signaturePath, descriptorPath, keyringPath, expectedKeyId });
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), expectedVersion);
  const directory = dirname(manifestPath);
  for (const artifact of manifest.artifacts) {
    const path = join(directory, artifact.name);
    if (basename(path) !== artifact.name) throw new Error(`release artifact name is unsafe: ${artifact.name}`);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== artifact.size) throw new Error(`release artifact size mismatch: ${artifact.name}`);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== artifact.sha256) throw new Error(`release artifact SHA-256 mismatch: ${artifact.name}`);
  }
  return manifest;
}

async function main(args) {
  const [manifestPath, signaturePath, descriptorPath, keyringPath, expectedKeyId, expectedVersion] = args;
  if (args.length !== 6 || args.some((value) => value === undefined)) {
    throw new Error("usage: release-verify.mjs <manifest> <signature> <descriptor> <trusted-keyring> <key-id> <version>");
  }
  await verifyReleaseAssets({ manifestPath: resolve(manifestPath), signaturePath: resolve(signaturePath), descriptorPath: resolve(descriptorPath), keyringPath: resolve(keyringPath), expectedKeyId, expectedVersion });
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
