import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { transform } from "esbuild";
import { dependencies } from "./architecture-graph.mjs";

/** Compile authored pure TypeScript, never import/evaluate the input. */
export async function releaseValidationModule(root) {
  const path = "apps/worker/src/domain/release-manifest.ts";
  const source = await readFile(resolve(root, path), "utf8");
  if (Buffer.byteLength(source) > 32768 || dependencies(source, path).length !== 0)
    throw new Error("release field validator must be bounded and have no runtime or type imports");
  const { code } = await transform(source, { loader: "ts", format: "iife", globalName: "RunmeshReleaseContract", target: "es2022", minify: false, legalComments: "none" });
  return `// Generated from domain/release-manifest.ts. Do not edit.\nexport const RELEASE_VALIDATION_SOURCE = ${JSON.stringify(code)};\n`;
}

export async function writeReleaseValidation(root) {
  const output = await releaseValidationModule(root);
  const target = resolve(root, "apps/worker/src/generated-release-validation.ts");
  if (await readFile(target, "utf8").catch(() => undefined) === output) return false;
  const temporary = `${target}.${process.pid}.tmp`;
  try { await writeFile(temporary, output, { flag: "wx" }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  return true;
}
