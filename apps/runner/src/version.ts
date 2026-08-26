import { createRequire } from "node:module";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Version reported by a running Runner. Reading the installed package manifest
 * keeps the public identity aligned with the package that actually launched.
 */
export function runnerPackageVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    if (typeof manifest.version === "string" && EXACT_VERSION.test(manifest.version)) return manifest.version;
  } catch { /* package packaging is expected to include package.json */ }
  const environmentVersion = process.env.npm_package_version;
  return environmentVersion !== undefined && EXACT_VERSION.test(environmentVersion) ? environmentVersion : "unknown";
}

export const RUNNER_VERSION = runnerPackageVersion();
