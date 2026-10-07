import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDevPlan } from "./policy.mjs";
import { readEvidenceJson } from "../evidence-io.mjs";
import { sourceObservation } from "../ci-report.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
export async function command(file, args, options = {}) {
  return execute(file, args, { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}
export async function git(...args) {
  return (await command("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { timeout: 15000 })).stdout.trim();
}
export async function readPlan(path) {
  return validateDevPlan(await readEvidenceJson(path, 4096));
}
export async function assertSource(plan) {
  const source = sourceObservation(root);
  assert.equal(source.state, "clean", "release source is not clean or could not be observed");
  assert.equal(source.commit, plan.source_sha);
  assert.equal(source.tree, plan.source_tree);
}
export function mainModule(meta) { return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(meta); }
