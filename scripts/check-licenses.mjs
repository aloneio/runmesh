import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { PRODUCT_VERSION } from "./product-version.mjs";

const polyFormSha256 = "ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8";
const polyFormLicense = "PolyForm-Noncommercial-1.0.0";
const expectedVersion = PRODUCT_VERSION;
const polyFormFiles = ["LICENSE", "apps/runner/LICENSE", "apps/worker/LICENSE", "packages/protocol/LICENSE"];
const noticeFiles = ["NOTICE", "apps/runner/NOTICE", "apps/worker/NOTICE", "packages/protocol/NOTICE"];
const manifestFiles = ["package.json", "apps/runner/package.json", "apps/worker/package.json", "packages/protocol/package.json"];
const publicPackages = ["apps/runner/package.json", "packages/protocol/package.json"];
const requiredCommunityFiles = ["CODE_OF_CONDUCT.md", "GOVERNANCE.md", "CONTRIBUTORS.md", "GOVERNANCE.zh-CN.md", ".github/ISSUE_TEMPLATE/bug.yml", ".github/ISSUE_TEMPLATE/feature.yml", ".github/ISSUE_TEMPLATE/config.yml", ".github/pull_request_template.md"];
const removedProjectHistoryPaths = ["LICENSE_HISTORY.md", "LICENSE_HISTORY.zh-CN.md", "LICENSES/Apache-2.0-history.txt", "apps/runner/LICENSE_HISTORY.md", "apps/runner/LICENSES/Apache-2.0-history.txt", "apps/worker/LICENSE_HISTORY.md", "apps/worker/LICENSES/Apache-2.0-history.txt", "packages/protocol/LICENSE_HISTORY.md", "packages/protocol/LICENSES/Apache-2.0-history.txt"];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
async function requireFile(file) { await access(file, constants.R_OK); }
async function checkHash(file, expected) { const actual = sha256(await readFile(file)); if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual}; expected ${expected}`); }
for (const file of polyFormFiles) await checkHash(file, polyFormSha256);
for (const file of [...noticeFiles, ...requiredCommunityFiles]) await requireFile(file);
for (const file of manifestFiles) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (manifest.license !== polyFormLicense) throw new Error(`${file}: expected license ${polyFormLicense}, got ${manifest.license ?? "<none>"}`);
  if (manifest.version !== expectedVersion) throw new Error(`${file}: expected root product version ${expectedVersion}, got ${manifest.version ?? "<none>"}`);
}
for (const file of publicPackages) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const packedFile of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) if (!manifest.files?.includes(packedFile)) throw new Error(`${file}: package files must include ${packedFile}`);
  for (const forbiddenFile of ["LICENSE_HISTORY.md", "LICENSES/Apache-2.0-history.txt"]) if (manifest.files?.includes(forbiddenFile)) throw new Error(`${file}: package files must not include removed history ${forbiddenFile}`);
}
for (const path of removedProjectHistoryPaths) await access(path, constants.F_OK).then(() => { throw new Error(`${path}: removed project-owned Apache license history is present`); }, (error) => { if (error?.code !== "ENOENT") throw error; });
for (const file of ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.zh-CN.md"]) if (!(await readFile(file, "utf8")).includes("Apache-2.0")) throw new Error(`${file}: must retain accurate third-party Apache-2.0 notice coverage`);
console.log(`PolyForm license, NOTICE, community files, package notices, and product version ${expectedVersion} are consistent.`);
