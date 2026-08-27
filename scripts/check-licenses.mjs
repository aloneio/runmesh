import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const polyFormSha256 = "ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8";
const polyFormLicense = "PolyForm-Noncommercial-1.0.0";
const TARGET_VERSION = "0.1.0-dev.1";

const polyFormFiles = [
  "LICENSE",
  "apps/runner/LICENSE",
  "apps/worker/LICENSE",
  "packages/protocol/LICENSE",
];
const noticeFiles = [
  "NOTICE",
  "apps/runner/NOTICE",
  "apps/worker/NOTICE",
  "packages/protocol/NOTICE",
];
const manifestFiles = [
  "package.json",
  "apps/runner/package.json",
  "apps/worker/package.json",
  "packages/protocol/package.json",
];
const publicPackages = [
  "apps/runner/package.json",
  "packages/protocol/package.json",
];
const requiredCommunityFiles = [
  "CONTRIBUTION_PERMISSION.md",
  "CONTRIBUTION_PERMISSION.zh-CN.md",
  "CLA-INDIVIDUAL.md",
  "CLA-ENTITY.md",
  "CODE_OF_CONDUCT.md",
  "GOVERNANCE.md",
  "CONTRIBUTORS.md",
  "docs/cla-setup.md",
  "docs/zh-CN/cla-setup.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
];
const removedProjectHistoryPaths = [
  "LICENSE_HISTORY.md",
  "LICENSE_HISTORY.zh-CN.md",
  "LICENSES/Apache-2.0-history.txt",
  "apps/runner/LICENSE_HISTORY.md",
  "apps/runner/LICENSES/Apache-2.0-history.txt",
  "apps/worker/LICENSE_HISTORY.md",
  "apps/worker/LICENSES/Apache-2.0-history.txt",
  "packages/protocol/LICENSE_HISTORY.md",
  "packages/protocol/LICENSES/Apache-2.0-history.txt",
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function requireFile(file) {
  await access(file, constants.R_OK);
}

async function checkHash(file, expected) {
  const actual = sha256(await readFile(file));
  if (actual !== expected) {
    throw new Error(`${file}: SHA-256 ${actual}; expected ${expected}`);
  }
}

for (const file of polyFormFiles) await checkHash(file, polyFormSha256);
for (const file of noticeFiles) await requireFile(file);
for (const file of requiredCommunityFiles) await requireFile(file);

for (const file of manifestFiles) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (manifest.license !== polyFormLicense) {
    throw new Error(`${file}: expected license ${polyFormLicense}, got ${manifest.license ?? "<none>"}`);
  }
  if (manifest.version !== TARGET_VERSION) {
    throw new Error(`${file}: expected version ${TARGET_VERSION}, got ${manifest.version ?? "<none>"}`);
  }
}

for (const file of publicPackages) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const packedFile of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    if (!manifest.files?.includes(packedFile)) {
      throw new Error(`${file}: package files must include ${packedFile}`);
    }
  }
  for (const forbiddenFile of ["LICENSE_HISTORY.md", "LICENSES/Apache-2.0-history.txt"]) {
    if (manifest.files?.includes(forbiddenFile)) {
      throw new Error(`${file}: package files must not include removed project history ${forbiddenFile}`);
    }
  }
}

for (const path of removedProjectHistoryPaths) {
  await access(path, constants.F_OK).then(
    () => { throw new Error(`${path}: removed project-owned Apache license history is present`); },
    (error) => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
}

for (const file of ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.zh-CN.md"]) {
  const text = await readFile(file, "utf8");
  if (!text.includes("Apache-2.0")) {
    throw new Error(`${file}: must retain accurate third-party Apache-2.0 dependency notice coverage`);
  }
}

console.log("PolyForm license text, NOTICE, community governance files, public package notices, and third-party notice coverage are consistent.");
