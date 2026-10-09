import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Package tools pass paths through Node argv, including on Windows. Direct
 * node entrypoints ask npm for its own CLI using a fixed, offline command. */
export async function npmCliPath(env = process.env) {
  let cli = env.npm_execpath;
  if (cli === undefined) {
    const windows = process.platform === "win32";
    const command = "node -p process.env.npm_execpath";
    const result = await execute(windows ? "npm.cmd" : "npm", ["exec", "--offline", "--call", windows ? `"${command}"` : command], {
      env, shell: windows, windowsHide: true, timeout: 15_000, maxBuffer: 65_536,
    });
    cli = result.stdout.trim();
  }
  assert.ok(typeof cli === "string" && isAbsolute(cli) && basename(cli) === "npm-cli.js", "Use the installed npm CLI for package verification");
  return cli;
}
