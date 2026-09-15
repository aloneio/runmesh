import assert from "node:assert/strict";
import { lstat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./ci-report.mjs";

/** Explicit projected summaries only. A new attempt replaces old success
 * before any external process; never recursively copy a report directory. */
export async function writeSupplement(name, value, root = ROOT) {
  assert.ok(["package-e2e", "browser-tests", "crossforge-evidence"].includes(name));
  const directory = join(root, "ci-results");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const folder = await lstat(directory); assert.ok(folder.isDirectory() && !folder.isSymbolicLink());
  const target = join(directory, `${name}.json`), temporary = join(directory, `${randomUUID()}.tmp`);
  const current = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
  assert.ok(current === undefined || current.isFile() && !current.isSymbolicLink());
  const body = JSON.stringify(value, null, 2) + "\n"; assert.ok(Buffer.byteLength(body) <= 65536);
  try { await writeFile(temporary, body, { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
}
