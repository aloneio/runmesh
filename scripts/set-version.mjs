import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION } from "./product-version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedVersion = process.argv[2];
if (process.argv.length > 3 || (requestedVersion !== undefined && requestedVersion !== PRODUCT_VERSION)) {
  throw new Error(`version must be sourced from root package.json (${PRODUCT_VERSION})`);
}

const packagePaths = [
  "apps/runner/package.json",
  "apps/worker/package.json",
  "packages/protocol/package.json",
];

for (const relativePath of packagePaths) {
  const path = resolve(repositoryRoot, relativePath);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = PRODUCT_VERSION;
  if (relativePath === "apps/runner/package.json") {
    if (manifest.devDependencies?.["@aloneio/runmesh-protocol"] !== undefined) {
      manifest.devDependencies["@aloneio/runmesh-protocol"] = PRODUCT_VERSION;
    }
    if (manifest.dependencies?.["@aloneio/runmesh-protocol"] !== undefined) {
      manifest.dependencies["@aloneio/runmesh-protocol"] = PRODUCT_VERSION;
    }
  }
  if (relativePath === "apps/worker/package.json" && manifest.dependencies?.["@aloneio/runmesh-protocol"] !== undefined) {
    manifest.dependencies["@aloneio/runmesh-protocol"] = PRODUCT_VERSION;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const lockPath = resolve(repositoryRoot, "package-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
lock.version = PRODUCT_VERSION;
if (lock.packages?.[""] !== undefined) lock.packages[""].version = PRODUCT_VERSION;
for (const relativePath of ["apps/runner", "apps/worker", "packages/protocol"]) {
  const entry = lock.packages?.[relativePath];
  if (entry === undefined) continue;
  entry.version = PRODUCT_VERSION;
  if (entry.dependencies?.["@aloneio/runmesh-protocol"] !== undefined) {
    entry.dependencies["@aloneio/runmesh-protocol"] = PRODUCT_VERSION;
  }
  if (entry.devDependencies?.["@aloneio/runmesh-protocol"] !== undefined) {
    entry.devDependencies["@aloneio/runmesh-protocol"] = PRODUCT_VERSION;
  }
}
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
process.stdout.write(`synchronized ${PRODUCT_VERSION}\n`);
