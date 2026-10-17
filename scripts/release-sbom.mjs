import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
export const RELEASE_SBOM_NAME = "sbom.spdx.json";
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const MAX_SBOM_BYTES = 8 * 1024 * 1024;

function validTimestamp(value) {
  return typeof value === "string"
    && TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().replace(".000Z", "Z") === value;
}

export async function generateReleaseSbom({ outputPath, commitSha, publishedAt, run = execFileAsync }) {
  assert.match(commitSha, COMMIT_SHA);
  assert.ok(validTimestamp(publishedAt), "publishedAt must be a UTC timestamp without milliseconds");
  const { stdout } = await run("npm", ["sbom", "--sbom-format=spdx", "--sbom-type=application", "--omit=dev"], {
    cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    maxBuffer: MAX_SBOM_BYTES,
    windowsHide: true,
  });
  const document = JSON.parse(stdout);
  assert.equal(document.spdxVersion, "SPDX-2.3", "npm must emit SPDX-2.3 JSON");
  assert.ok(Array.isArray(document.packages) && document.packages.length > 0, "SBOM must contain packages");
  assert.equal(typeof document.creationInfo, "object");
  document.creationInfo = {
    ...document.creationInfo,
    created: publishedAt,
    comment: "Generated from Runmesh commit " + commitSha,
  };
  document.documentNamespace = "https://github.com/aloneio/runmesh/spdx/" + commitSha;
  const bytes = Buffer.from(JSON.stringify(document, null, 2) + "\n", "utf8");
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= MAX_SBOM_BYTES, "SBOM exceeds the bounded release input");
  await writeFile(outputPath, bytes, { flag: "wx" });
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, commitSha, publishedAt] = process.argv.slice(2);
  if (!outputPath || !commitSha || !publishedAt) throw new Error("usage: release-sbom.mjs <output> <commit-sha> <published-at>");
  await generateReleaseSbom({ outputPath: resolve(outputPath), commitSha, publishedAt });
}
