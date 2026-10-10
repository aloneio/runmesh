import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

async function fileExists(path, executable = false) {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (executable) await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return false;
    throw error;
  }
}

async function adjacentCli(launcher) {
  const physical = await realpath(launcher), directory = dirname(physical);
  if (basename(physical) === "npm-cli.js") return physical;
  for (const candidate of [join(directory, "npm-cli.js"), join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (await fileExists(candidate)) return realpath(candidate);
  }
}

/** Resolve standard installed layouts without npm exec or shell descendants.
 * Explicit npm identity wins; otherwise preserve the first PATH launcher. */
export async function npmCliPath(env = process.env) {
  let cli = env.npm_execpath;
  if (cli === undefined) {
    const windows = process.platform === "win32";
    const pathValue = windows ? Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] : env.PATH;
    for (const entry of (pathValue ?? "").split(delimiter)) {
      const directory = windows ? entry.replace(/^"(.*)"$/u, "$1") : entry;
      // Empty and relative PATH entries must not make the caller project an
      // authority for locating the installed package manager.
      if (!isAbsolute(directory)) continue;
      const launcher = join(directory, windows ? "npm.cmd" : "npm");
      if (!await fileExists(launcher, !windows)) continue;
      cli = await adjacentCli(launcher);
      assert.ok(cli !== undefined, "The first npm launcher on PATH has an unsupported layout; set npm_execpath to its installed npm-cli.js");
      break;
    }
    // Portable Node distributions may have npm installed but no PATH entry.
    cli ??= await adjacentCli(process.execPath);
  }
  assert.ok(typeof cli === "string" && isAbsolute(cli) && basename(cli) === "npm-cli.js", "Use the installed npm CLI for package verification; set npm_execpath to npm-cli.js");
  return cli;
}
