import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDevPlan } from "./policy.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
export async function command(file, args, options = {}) {
  return execute(file, args, { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}
export async function git(...args) {
  return (await command("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { timeout: 15000 })).stdout.trim();
}
export async function readPlan(path) {
  const info = await stat(path); assert.ok(info.isFile() && info.size <= 4096, "invalid development plan file");
  return validateDevPlan(JSON.parse(await readFile(path, "utf8")));
}
export async function assertSource(plan) {
  assert.equal(await git("rev-parse", "HEAD"), plan.source_sha);
  assert.equal(await git("rev-parse", "HEAD^{tree}"), plan.source_tree);
  assert.equal(await git("status", "--porcelain", "--untracked-files=all"), "", "release source is not clean");
}
export function mainModule(meta) { return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(meta); }
