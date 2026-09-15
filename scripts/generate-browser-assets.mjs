import { readFile, writeFile, lstat, realpath, rename, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Script } from "node:vm";

/** Parse browser syntax without executing DOM code or modifying its bytes. */
export function browserModule(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 128 * 1024 || /<\/script\s*>/iu.test(source)) throw new Error("invalid_browser_source");
  new Script(source, { filename: "admin-client.js" });
  return `// Generated from the reviewed browser source. Do not edit or commit.\nexport const ADMIN_CLIENT_SOURCE = ${JSON.stringify(source)};\n`;
}
export async function writeBrowserAssets(root) {
  const input = join(root, "apps/worker/browser/admin-client.js"), target = join(root, "apps/worker/src/generated-admin-client.ts");
  const stat = await lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("invalid_browser_source");
  if (await realpath(dirname(target)) !== resolve(await realpath(root), "apps/worker/src")) throw new Error("unsafe_browser_output");
  const existing = await lstat(target).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("unsafe_browser_output");
  const module = browserModule(await readFile(input, "utf8"));
  if (await readFile(target, "utf8").catch(() => undefined) === module) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, module, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await writeBrowserAssets(fileURLToPath(new URL("../", import.meta.url)));
