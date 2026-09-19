import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const sha = /^[a-f0-9]{40}$/u;
const branch = value => value === "main" || value === "dev" ? value : null;
const absent = (state, reason) => ({ schema_version: 1, state, commit: null, tree: null, branch: null, reason });

/** A directory can have multiple Windows case/8.3 spellings. Compare the
 * actual directory object, never case-fold arbitrary paths or trust a prefix.
 * BigInt prevents distinct 64-bit file IDs from collapsing through rounding. */
export function sourceDirectoryIdentity(path) {
  try {
    const info = statSync(path, { bigint: true });
    if (!info.isDirectory() || typeof info.dev !== "bigint" || info.dev < 0n || typeof info.ino !== "bigint" || info.ino <= 0n) return undefined;
    return { device: info.dev, inode: info.ino };
  } catch { return undefined; }
}
export function sameDirectoryIdentity(left, right) {
  return left !== undefined && right !== undefined && left !== null && right !== null
    && typeof left.device === "bigint" && left.device >= 0n && typeof left.inode === "bigint" && left.inode > 0n
    && left.device === right.device && left.inode === right.inode;
}

/** Build-time only. Read Git metadata; never consult remotes, author identity,
 * credentials, database state, replace refs, executable diff or fsmonitor.
 * A clean Git tree identifies tracked source, not a signed binary attestation.
 */
export function captureBuildProvenance(root, metadata = process.env) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args) => spawnSync("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd: root, env: environment, encoding: "utf8", timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  try {
    const rootIdentity = sourceDirectoryIdentity(root);
    const top = git("rev-parse", "--show-toplevel");
    if (top.status !== 0 || !sameDirectoryIdentity(rootIdentity, sourceDirectoryIdentity(top.stdout.trim()))) return absent("unavailable", "git_unavailable");
    const head = git("rev-parse", "--verify", "HEAD"), treeResult = git("rev-parse", "HEAD^{tree}");
    const commit = head.stdout.trim(), tree = treeResult.stdout.trim();
    if (head.status !== 0 || treeResult.status !== 0 || !sha.test(commit) || !sha.test(tree)) return absent("unavailable", "git_unavailable");
    const flags = git("ls-files", "-v", "-z"), modes = git("ls-files", "--stage", "-z");
    if (flags.status !== 0 || modes.status !== 0) return absent("unavailable", "git_unavailable");
    if (flags.stdout.split("\0").some(line => /^[a-zS] /u.test(line))) return absent("unavailable", "hidden_index_flags");
    if (modes.stdout.split("\0").some(line => /^(?:120000|160000) /u.test(line))) return absent("unavailable", "unsupported_tree");
    const clean = () => {
      const diff = git("diff", "--no-ext-diff", "--no-textconv", "--exit-code", "HEAD", "--");
      const status = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
      if (status.status !== 0 || ![0, 1].includes(diff.status)) throw new Error("git_unavailable");
      return diff.status === 0 && status.stdout === "";
    };
    if (!clean()) return absent("dirty", "dirty_checkout");
    const commits = [metadata.WORKERS_CI_COMMIT_SHA, metadata.CI_COMMIT_SHA, metadata.GITHUB_SHA].filter(value => value !== undefined && value !== "");
    if (commits.some(value => typeof value !== "string" || !sha.test(value) || value !== commit)) return absent("conflict", "metadata_conflict");
    const githubBranch = typeof metadata.GITHUB_REF === "string" && metadata.GITHUB_REF.startsWith("refs/heads/") ? metadata.GITHUB_REF.slice(11) : undefined;
    const branches = [metadata.WORKERS_CI_BRANCH, metadata.CI_COMMIT_BRANCH, githubBranch].filter(value => value !== undefined && value !== "");
    if (branches.some(value => typeof value !== "string" || value.length > 256) || new Set(branches).size > 1) return absent("conflict", "metadata_conflict");
    const local = git("symbolic-ref", "--quiet", "--short", "HEAD");
    const localBranch = local.status === 0 ? local.stdout.trim() : null;
    if (localBranch !== null && branches.length && localBranch !== branches[0]) return absent("conflict", "metadata_conflict");
    const nonBranch = Boolean(metadata.CI_COMMIT_TAG || metadata.CI_MERGE_REQUEST_IID || ["pull_request", "pull_request_target"].includes(metadata.GITHUB_EVENT_NAME)
      || (metadata.GITHUB_REF && !metadata.GITHUB_REF.startsWith("refs/heads/")));
    const sourceBranch = nonBranch ? null : branch(localBranch ?? (commits.length ? branches[0] : null));
    // A source mutation during observation invalidates the entire statement.
    if (git("rev-parse", "HEAD").stdout.trim() !== commit || !clean() || !sameDirectoryIdentity(rootIdentity, sourceDirectoryIdentity(root))) return absent("dirty", "source_changed");
    return { schema_version: 1, state: "clean", commit, tree, branch: sourceBranch, reason: null };
  } catch { return absent("unavailable", "git_unavailable"); }
}

/** Replace a stale generated statement even on failure. The ignored module
 * avoids embedding its own commit/tree identity in the tree it identifies.
 */
export async function writeBuildProvenance(root, metadata = process.env, { strict = metadata.WORKERS_CI === "1" } = {}) {
  const info = captureBuildProvenance(root, metadata);
  const target = join(root, "apps/worker/src/generated-provenance.ts");
  if (await realpath(dirname(target)) !== resolve(await realpath(root), "apps/worker/src")) throw new Error("provenance_output_unsafe");
  const existing = await lstat(target).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("provenance_output_unsafe");
  const source = `// Generated locally by scripts/build-provenance.mjs. Do not commit this file.\nexport const BUILD_PROVENANCE = ${JSON.stringify(info)} as const;\n`;
  if (await readFile(target, "utf8").catch(() => undefined) !== source) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, source, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  if (strict && info.state !== "clean") throw new Error(`provenance_unavailable: ${info.reason}`);
  return info;
}
