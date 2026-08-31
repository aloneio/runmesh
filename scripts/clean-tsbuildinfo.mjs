import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error("usage: clean-tsbuildinfo.mjs <directory> [...]");

async function clean(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await clean(path);
    else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) await rm(path, { force: true });
  }
}

for (const root of roots) {
  const path = resolve(root);
  const metadata = await stat(path).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (metadata?.isDirectory()) await clean(path);
}
