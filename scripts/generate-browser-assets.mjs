import { readFile, writeFile, lstat, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";
import { build } from "esbuild";
import { dependencies } from "./architecture-graph.mjs";

/** Bundle only bounded, reviewed local browser modules; never execute them. */
export async function buildBrowserSource(root) {
  const directory = await realpath(join(root, "apps/worker/browser"));
  const entry = join(directory, "admin-client.js");
  let bytes = 0;
  const result = await build({
    absWorkingDir: directory,
    entryPoints: [entry], bundle: true, write: false, platform: "browser", format: "iife",
    target: "es2022", charset: "utf8", legalComments: "none", logLevel: "silent",
    plugins: [{ name: "reviewed-browser-modules", setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.kind !== "entry-point" && (args.kind !== "import-statement" || !args.path.startsWith("."))) throw new Error("invalid_browser_dependency");
        const path = args.kind === "entry-point" ? resolve(args.path) : resolve(dirname(args.importer), args.path);
        if (!path.startsWith(directory + sep) || !path.endsWith(".js") || await realpath(path) !== path) throw new Error("invalid_browser_dependency");
        return { path };
      });
      builder.onLoad({ filter: /.*/ }, async args => {
        const stat = await lstat(args.path);
        if (!stat.isFile() || stat.isSymbolicLink() || (bytes += stat.size) > 128 * 1024) throw new Error("invalid_browser_source");
        const contents = await readFile(args.path, "utf8");
        if (dependencies(contents, args.path).some(edge => typeof edge.specifier !== "string"))
          throw new Error("invalid_browser_dependency");
        return { contents, loader: "js" };
      });
    } }],
  });
  const source = result.outputFiles[0].text;
  browserModule(source);
  return source;
}

/** Parse browser syntax without executing DOM code or modifying its bytes. */
export function browserModule(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 128 * 1024 || /<\/script\s*>/iu.test(source)) throw new Error("invalid_browser_source");
  new Script(source, { filename: "admin-client.js" });
  return `// Generated from the reviewed browser source. Do not edit or commit.\nexport const ADMIN_CLIENT_SOURCE = ${JSON.stringify(source)};\n`;
}
export async function writeBrowserAssets(root) {
  const target = join(root, "apps/worker/src/generated-admin-client.ts");
  if (await realpath(dirname(target)) !== resolve(await realpath(root), "apps/worker/src")) throw new Error("unsafe_browser_output");
  const existing = await lstat(target).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("unsafe_browser_output");
  const module = browserModule(await buildBrowserSource(root));
  if (await readFile(target, "utf8").catch(() => undefined) === module) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, module, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await writeBrowserAssets(fileURLToPath(new URL("../", import.meta.url)));
