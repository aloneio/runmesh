import assert from "node:assert/strict";
import { ROOT } from "./ci-report.mjs";
import { writeCiEvidenceFile } from "./evidence-io.mjs";

/** Explicit projected summaries only. A new attempt replaces old success
 * before any external process; never recursively copy a report directory. */
export async function writeSupplement(name, value, root = ROOT) {
  assert.ok(["package-e2e", "browser-tests", "transport-tests", "crossforge-evidence"].includes(name));
  const body = JSON.stringify(value, null, 2) + "\n"; assert.ok(Buffer.byteLength(body) <= 65536);
  await writeCiEvidenceFile(root, `${name}.json`, body);
}
