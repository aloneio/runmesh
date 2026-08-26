import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const polyFormSha256 = 'ffcca38841adb694b6f380647e15f17c446a4d1656fed51a1e2041d064c94cc8';
const apacheHistorySha256 = '75aa71b5be8076ef3fd8775c51a889319aed777649859df377333bce0d208700';
const polyFormLicense = 'PolyForm-Noncommercial-1.0.0';

const polyFormFiles = [
  'LICENSE',
  'apps/runner/LICENSE',
  'apps/worker/LICENSE',
  'packages/protocol/LICENSE',
];
const apacheHistoryFiles = [
  'LICENSES/Apache-2.0-history.txt',
  'apps/runner/LICENSES/Apache-2.0-history.txt',
  'apps/worker/LICENSES/Apache-2.0-history.txt',
  'packages/protocol/LICENSES/Apache-2.0-history.txt',
];
const manifestFiles = [
  'package.json',
  'apps/runner/package.json',
  'apps/worker/package.json',
  'packages/protocol/package.json',
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function checkHash(file, expected) {
  const actual = sha256(await readFile(file));
  if (actual !== expected) {
    throw new Error(`${file}: SHA-256 ${actual}; expected ${expected}`);
  }
}

for (const file of polyFormFiles) await checkHash(file, polyFormSha256);
for (const file of apacheHistoryFiles) await checkHash(file, apacheHistorySha256);

for (const file of manifestFiles) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest.license !== polyFormLicense) {
    throw new Error(`${file}: expected license ${polyFormLicense}, got ${manifest.license ?? '<none>'}`);
  }
}

for (const file of ['apps/runner/package.json', 'packages/protocol/package.json']) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const requiredPackedFiles = ['LICENSE', 'LICENSES/Apache-2.0-history.txt', 'LICENSE_HISTORY.md', 'THIRD_PARTY_NOTICES.md'];
  for (const packedFile of requiredPackedFiles) {
    if (!manifest.files?.includes(packedFile)) {
      throw new Error(`${file}: package files must include ${packedFile}`);
    }
  }
}

console.log('License metadata, official PolyForm text, Apache historical record, and public package artifacts are consistent.');
