import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateDevPlan } from "./dev-release/policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedEmail = "git@aloneio.aleeas.com";
const emailPattern = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const knownLegalNotices = new Map([
  // Reviewed, unmodified legal notices. The bundled third-party copyright
  // attribution must stay intact; arbitrary new notices do not get an exception.
  ["THIRD_PARTY_NOTICES.md", "deb32d3b38b15760b28d7b8a40ece739e0d5a0877d95282da55370d1698751fe"],
  ["package/THIRD_PARTY_NOTICES.md", "3f956be338da018c668d0d134847763f1f58dabbf772b99bd48137d031b6db68"],
]);
const expectedAssetNames = version => new Set([
  `runmesh-runner-${version}.tgz`, "manifest.json", "manifest.sig",
  "manifest.signature.json", "SHA256SUMS", "LICENSE", "NOTICE",
  "THIRD_PARTY_NOTICES.md", "trust-keyring.json",
]);

/** Identifies release-private mailboxes, without ever printing their values. */
export function assertNoUnapprovedEmail(bytes, label, { legalNotice = false } = {}) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const detected = [...content.toString("latin1").matchAll(emailPattern)]
    .some(match => match[0].toLowerCase() !== expectedEmail);
  if (!detected) return;
  if (legalNotice && knownLegalNotices.get(label) === sha256(content)) return;
  throw new Error(`release_privacy_email_rejected: ${label}`);
}

function field(header, start, length) {
  return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "");
}
function octal(header, start, length) {
  const raw = field(header, start, length).trim();
  assert.match(raw, /^[0-7]+$/u, "release_privacy_invalid_tar_size");
  const number = Number.parseInt(raw, 8);
  assert.ok(Number.isSafeInteger(number) && number >= 0, "release_privacy_invalid_tar_size");
  return number;
}

/** Inspect every extracted archive entry, including compiled JS and npm metadata.
 * Never unpack to disk; reject unexpected tar layouts and oversized archives. */
export function assertTarballPrivacy(archive) {
  const compressed = Buffer.from(archive);
  assert.ok(compressed.length > 0 && compressed.length <= 8 * 1024 * 1024, "release_privacy_archive_size");
  const tar = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  let offset = 0, fileCount = 0, trailing = false, pendingPath;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) { trailing = true; break; }
    const size = octal(header, 124, 12);
    const end = offset + 512 + size, next = offset + 512 + Math.ceil(size / 512) * 512;
    assert.ok(end <= tar.length && next <= tar.length, "release_privacy_tar_truncated");
    const type = String.fromCharCode(header[156]);
    const name = [field(header, 345, 155), field(header, 0, 100)].filter(Boolean).join("/");
    const data = tar.subarray(offset + 512, end);
    assertNoUnapprovedEmail(header, "tar_header");
    if (type === "x" || type === "g" || type === "L") {
      assertNoUnapprovedEmail(data, "tar_extension");
      if (type === "L") pendingPath = data.toString("utf8").replace(/\0.*$/u, "");
      if (type === "x") {
        for (const match of data.toString("utf8").matchAll(/(?:^|\n)\d+ path=([^\n]+)\n/gu)) pendingPath = match[1];
      }
    } else if (type === "0" || type === "\0" || type === "5") {
      const path = (pendingPath ?? name).replace(/^\.\//u, "");
      pendingPath = undefined;
      assert.ok((type === "5" && path === "package/") || (path.startsWith("package/") && !path.includes("../") && path !== "package/"), "release_privacy_tar_path");
      if (type !== "5") {
        fileCount++;
        assert.ok(fileCount <= 1024, "release_privacy_tar_file_limit");
        assertNoUnapprovedEmail(data, path === "package/THIRD_PARTY_NOTICES.md" ? path : "archive_entry", { legalNotice: path === "package/THIRD_PARTY_NOTICES.md" });
      }
    } else throw new Error("release_privacy_tar_type");
    offset = next;
  }
  assert.ok(trailing && fileCount >= 2 && pendingPath === undefined, "release_privacy_incomplete_tar");
  return fileCount;
}

export function assertPrivacyText(text, label) {
  assertNoUnapprovedEmail(text, label);
}

async function validateNotes(flag, pathname) {
  if (flag === undefined) return;
  assert.ok(pathname && typeof pathname === "string", "release_privacy_notes_missing");
  const value = await readFile(resolve(pathname), "utf8");
  assert.ok(value.length > 0 && Buffer.byteLength(value) < 128 * 1024, "release_privacy_notes_size");
  if (flag === "--plan") validateDevPlan(JSON.parse(value));
  assertPrivacyText(value, flag === "--notes" ? "release_notes" : "dev_release_plan");
}

export async function checkReleaseAssets(directory, options = {}) {
  const base = resolve(directory);
  const names = await readdir(base);
  assert.ok(names.length === 9 && names.every(name => /^[a-zA-Z0-9._-]+$/u.test(name)), "release_privacy_asset_count");
  const manifest = JSON.parse(await readFile(join(base, "manifest.json"), "utf8"));
  const version = manifest?.version;
  assert.ok(typeof version === "string" && /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/u.test(version), "release_privacy_version");
  assert.deepEqual(new Set(names), expectedAssetNames(version), "release_privacy_unexpected_assets");
  for (const name of names) {
    const path = join(base, name), stat = await lstat(path);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024, "release_privacy_asset_file");
    const bytes = await readFile(path);
    if (name.endsWith(".tgz")) assertTarballPrivacy(bytes);
    else assertNoUnapprovedEmail(bytes, name, { legalNotice: name === "THIRD_PARTY_NOTICES.md" });
  }
  if (options.notes) await validateNotes("--notes", options.notes);
  if (options.plan) await validateNotes("--plan", options.plan);
  return { assets: names.length, archive: `runmesh-runner-${version}.tgz` };
}

function checkCommitHistory() {
  const checker = join(root, "scripts/check-git-privacy.mjs");
  // GitHub contains old immutable release tags; inspect the complete history
  // reachable from HEAD, not --all (which would re-check archived releases).
  const result = spawnSync(process.execPath, [checker, "--ci"], {
    cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, CI: "" },
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, "release_privacy_commit_history");
}
async function cli(args) {
  const [action, input, option, value] = args;
  if (action === "source" && input === undefined && option === undefined && value === undefined) {
    checkCommitHistory();
    return;
  }
  if (action === "source" && ["--notes", "--plan"].includes(input) && typeof option === "string" && value === undefined) {
    checkCommitHistory(); await validateNotes(input, option); return;
  }
  if (action === "assets" && typeof input === "string" && option === undefined && value === undefined) {
    await checkReleaseAssets(input); return;
  }
  if (action === "assets" && typeof input === "string" && ["--notes", "--plan"].includes(option) && typeof value === "string") {
    await checkReleaseAssets(input, { [option === "--notes" ? "notes" : "plan"]: value }); return;
  }
  throw new Error("release_privacy_arguments");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(() => console.log("release_privacy: passed")).catch(error => {
    // Scanner errors never contain matched mailbox values.
    console.error(error.message);
    process.exitCode = 1;
  });
}
