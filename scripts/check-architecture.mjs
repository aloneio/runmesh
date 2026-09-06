import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoots = ["apps/runner/src", "apps/worker/src", "packages/protocol/src"];
const forbidden = [
  { pattern: /\bRUNMESH_SCHEMA_READY\b/u, reason: "runtime schema migration switch" },
  { pattern: /\bRUNMESH_PROFILE\b/u, reason: "retired profile environment alias" },
  { pattern: /\bRUNMESH_TOKEN\b/u, reason: "retired token environment alias" },
  // The Registry may mention a retired table only in its read-only schema
  // rejection guard. Any DDL or data mutation against that table would
  // reintroduce compatibility behavior and is forbidden.
  { pattern: /(?:CREATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"']?runner_policy_migrations\b/iu, reason: "retired policy-migration table mutation" },
  { pattern: /\bmanagement_mode\s*===?\s*["']legacy_local/u, reason: "retired local workspace authority" },
  { pattern: /remote-coding-(?:runtime|runner)/iu, reason: "retired product name" },
  { pattern: /\bRemoteCodingRunner\b/u, reason: "retired product name" },
];

const failures = [];
for (const directory of sourceRoots) {
  for (const file of await files(directory)) {
    const text = await readFile(join(root, file), "utf8");
    for (const { pattern, reason } of forbidden) {
      if (pattern.test(text)) failures.push(`${file}: contains ${reason}`);
    }
  }
}

const protocolFiles = await files("packages/protocol/src");
for (const file of protocolFiles) {
    const text = await readFile(join(root, file), "utf8");
  if (/from\s+["'][^"']*(?:apps\/runner|apps\/worker)/u.test(text)) {
    failures.push(`${file}: protocol must not import an application layer`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Architecture check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
}

async function files(directory) {
  const absolute = join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const next = join(absolute, entry.name);
    if (entry.isDirectory()) return files(relative(root, next));
    return entry.isFile() && /\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(entry.name)
      ? [relative(root, next).replaceAll("\\", "/")]
      : [];
  }));
  return nested.flat();
}
