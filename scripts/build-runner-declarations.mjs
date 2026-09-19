import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(repositoryRoot, "apps", "runner", "dist");

// Runtime code bundles the shared error registry. Its public declarations
// must remain standalone as well: generate them from that same source rather
// than maintaining another handwritten set of types or adding a dependency
// on an unpublished workspace package.
const failureDeclarations = (await readFile(join(repositoryRoot, "packages", "protocol", "dist", "failure.d.ts"), "utf8"))
  .replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gmu, "");
await writeFile(join(distRoot, "_protocol-failure.d.ts"), failureDeclarations, "utf8");
const errorDeclarationPath = join(distRoot, "errors.d.ts");
const errorDeclarations = await readFile(errorDeclarationPath, "utf8");
await writeFile(errorDeclarationPath, errorDeclarations.replaceAll('"@aloneio/runmesh-protocol"', '"./_protocol-failure.js"'), "utf8");

async function declarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await declarationFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

const existingCjsDeclarations = [];
async function cjsDeclarationFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await cjsDeclarationFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".d.cts")) existingCjsDeclarations.push(path);
  }
}

await cjsDeclarationFiles(distRoot);
await Promise.all(existingCjsDeclarations.map((path) => rm(path, { force: true })));

const declarations = await declarationFiles(distRoot);
for (const source of declarations) {
  const target = `${source.slice(0, -".d.ts".length)}.d.cts`;
  let content = await readFile(source, "utf8");
  // A .d.cts file must resolve its relative declaration graph as CommonJS.
  // TypeScript maps a `.cjs` specifier to a sibling `.d.cts` declaration.
  content = content.replace(/(["'])(\.{1,2}\/[^"']+)\.js\1/gu, "$1$2.cjs$1");
  // Declaration source maps are generated only for the ESM graph; retaining
  // the comment would point CJS consumers at a non-existent map variant.
  content = content.replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gmu, "");
  await writeFile(target, content, "utf8");
}

console.log(`built ${declarations.length} CommonJS declaration files`);
