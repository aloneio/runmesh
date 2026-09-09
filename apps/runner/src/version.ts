import { createRequire } from "node:module";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Version reported by a running Runner. Reading the installed package manifest
 * keeps the public identity aligned with the package that actually launched.
 */
export function runnerPackageVersion(): string {
  const bundledVersion = process.env.RUNMESH_RUNNER_VERSION;
  if (bundledVersion !== undefined && EXACT_VERSION.test(bundledVersion)) return bundledVersion;
  try {
    const manifest = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    if (typeof manifest.version === "string" && EXACT_VERSION.test(manifest.version)) return manifest.version;
  } catch { /* package packaging is expected to include package.json */ }
  const environmentVersion = process.env.npm_package_version;
  return environmentVersion !== undefined && EXACT_VERSION.test(environmentVersion) ? environmentVersion : "unknown";
}

export const RUNNER_VERSION = runnerPackageVersion();

/** Supported, patched LTS floors; an EOL major is not a production runtime. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const major = Number(match?.[1]); const minor = Number(match?.[2]); const patch = Number(match?.[3]);
  if (match !== null && ((major === 22 && (minor > 23 || (minor === 23 && patch >= 2))) || (major === 24 && minor >= 21))) return;
  throw new Error("Runmesh requires supported Node 22.23.2+ (22.x) or 24.21.0+ (24.x)");
}
