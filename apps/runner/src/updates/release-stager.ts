import { exactRunnerRelease, FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS, MAX_RELEASE_ASSET_BYTES, releaseManifestProblem, verifyRunnerReleaseSignature, type ReleaseTrust } from "@aloneio/runmesh-protocol";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runnerArchiveFiles } from "./release-archive.js";
import { renderManagedLauncher } from "./launchers.js";

export interface RunnerReleaseTarget { readonly version: string; readonly channel: "dev" | "stable"; readonly manifest_sha256?: string; readonly artifact_sha256?: string; }
export interface RunnerReleaseStageContext { readonly installRoot: string; readonly operationId: string; readonly runtimePath: string; readonly fetch?: typeof fetch; }
export interface VerifiedStagedRelease { readonly version: string; readonly versionDirectory: string; readonly artifactSha256: string; readonly manifestSha256: string; }
const origins = new Set<string>(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS);
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** No authorization headers or cookies are sent to release hosts. */
export async function downloadRunnerReleaseAsset(url: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Runner release download timed out.")); }, 30000); });
  try { return await Promise.race([timeout, (async () => {
    let current = new URL(url);
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (current.protocol !== "https:" || current.username || current.password || !origins.has(current.origin)) throw new Error("Runner release download origin is invalid.");
      const response = await fetchImpl(current.toString(), { method: "GET", signal: controller.signal, redirect: "manual", credentials: "omit", headers: { accept: "application/octet-stream" } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location"); void response.body?.cancel().catch(() => undefined);
        if (location === null || redirects === 4) throw new Error("Runner release redirect is invalid.");
        current = new URL(location, current); continue;
      }
      if (!response.ok || response.body === null) { void response.body?.cancel().catch(() => undefined); throw new Error(`Runner release download returned HTTP ${response.status}.`); }
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) { void response.body.cancel().catch(() => undefined); throw new Error("Runner release download exceeds its size limit."); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (let parts = 0; ; parts++) {
          if (parts > 32768) throw new Error("Runner release response is too fragmented.");
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > limit) throw new Error("Runner release download exceeds its size limit.");
          chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (size === 0) throw new Error("Runner release download is empty.");
      return Buffer.concat(chunks, size);
    }
    throw new Error("Runner release redirect limit exceeded.");
  })()]); } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Runner installation directory must be a real directory.");
}
async function validateInstallRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root) throw new Error("Runner installation root is invalid.");
  const root = resolve(path);
  const canonical = resolve(await realpath(root));
  if ((process.platform === "win32" ? canonical.toLowerCase() !== root.toLowerCase() : canonical !== root)) throw new Error("Runner installation root must be canonical.");
  await ensureDirectory(root);
  return root;
}

/** A fresh, immutable directory per operation preserves old binaries for rollback. */
export async function stageRunnerRelease(target: RunnerReleaseTarget, context: RunnerReleaseStageContext, dependencies: { readonly trust?: ReleaseTrust } = {}): Promise<VerifiedStagedRelease> {
  const release = exactRunnerRelease(target.version);
  if (release.channel !== target.channel || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(context.operationId)) throw new Error("Runner update target is invalid.");
  for (const value of [target.manifest_sha256, target.artifact_sha256]) if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Runner release requires both selected digests.");
  const root = await validateInstallRoot(context.installRoot);
  const fetchImpl = context.fetch ?? fetch;
  const manifestBytes = await downloadRunnerReleaseAsset(release.manifest_url, 65536, fetchImpl);
  const signature = await downloadRunnerReleaseAsset(release.signature_url, 1024, fetchImpl);
  const descriptor = await downloadRunnerReleaseAsset(release.signature_descriptor_url, 16384, fetchImpl);
  const manifest = await verifyRunnerReleaseSignature(manifestBytes, signature, descriptor, dependencies.trust);
  // The Worker authorizes wire compatibility when it fixes the release digests.
  // This independent manager validates the signed range without inheriting the
  // wire version of the Runner package from which it was originally installed.
  const protocol = typeof manifest === "object" && manifest !== null ? manifest as Record<string, unknown> : undefined;
  const minimum = protocol?.protocol_min, maximum = protocol?.protocol_max;
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || Number(minimum) < 1 || Number(minimum) > Number(maximum)) throw new Error("Runner release protocol range is invalid.");
  if (releaseManifestProblem(manifest, { ...release, protocol_min: Number(minimum), protocol_max: Number(maximum),
    max_asset_bytes: MAX_RELEASE_ASSET_BYTES, compatibility: "overlap", node_major: Number(process.versions.node.split(".")[0]) }) !== undefined) throw new Error("Runner release requires a different protocol or Node runtime.");
  const artifact = (manifest as { artifacts: [{ size: number; sha256: string }] }).artifacts[0];
  const manifestSha256 = digest(manifestBytes);
  if ((target.manifest_sha256 !== undefined && target.manifest_sha256 !== manifestSha256) || (target.artifact_sha256 !== undefined && target.artifact_sha256 !== artifact.sha256)) throw new Error("Runner release changed after the update was requested.");
  const archive = await downloadRunnerReleaseAsset(release.artifact_url, MAX_RELEASE_ASSET_BYTES, fetchImpl);
  if (archive.byteLength !== artifact.size || digest(archive) !== artifact.sha256) throw new Error("Runner package checksum does not match its signed release.");
  const files = runnerArchiveFiles(archive);
  const packageFile = files.find(file => file.path === "package.json");
  const bundleFile = files.find(file => file.path === "dist/runmesh.cjs");
  if (packageFile === undefined || bundleFile === undefined) throw new Error("Runner package is missing its manifest or executable.");
  const packageJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageFile.bytes)) as Record<string, unknown>;
  if (packageJson.name !== "@aloneio/runmesh-runner" || packageJson.version !== target.version
    || (packageJson.dependencies !== undefined && (typeof packageJson.dependencies !== "object" || packageJson.dependencies === null || Object.keys(packageJson.dependencies).length !== 0))) throw new Error("Runner package identity or dependencies differ from its portable release contract.");
  const versions = join(root, "versions"); await ensureDirectory(versions);
  // A random suffix also avoids reusing partially installed directories after a crash.
  const versionDirectory = join(versions, `${target.version}-${context.operationId}-${randomUUID().slice(0, 8)}`);
  const temporary = `${versionDirectory}.staging`;
  await mkdir(temporary, { mode: 0o755 });
  try {
    const packageRoot = process.platform === "win32" ? join(temporary, "node_modules", "@aloneio", "runmesh-runner") : join(temporary, "lib", "node_modules", "@aloneio", "runmesh-runner");
    for (const file of files) {
      const destination = join(packageRoot, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o644 });
    }
    await mkdir(join(temporary, "runtime"), { mode: 0o755 });
    const runtime = join(temporary, "runtime", process.platform === "win32" ? "node.exe" : "node");
    const sourceStat = await lstat(context.runtimePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("Runner private Node runtime must be a regular file.");
    await copyFile(context.runtimePath, runtime); await chmod(runtime, 0o755);
    if (process.platform === "win32") {
      await writeFile(join(temporary, "runmesh.cjs"), bundleFile.bytes, { flag: "wx" });
      const wrapper = renderManagedLauncher("win32", root);
      await writeFile(join(temporary, "runmesh.cmd"), wrapper, { flag: "wx" });
      await writeFile(join(temporary, "runmesh-runner.cmd"), wrapper, { flag: "wx" });
    } else {
      await mkdir(join(temporary, "bin"), { mode: 0o755 });
      const wrapper = renderManagedLauncher(process.platform === "darwin" ? "darwin" : "linux", root);
      await writeFile(join(temporary, "bin", "runmesh"), wrapper, { flag: "wx", mode: 0o755 });
      await writeFile(join(temporary, "bin", "runmesh-runner"), wrapper, { flag: "wx", mode: 0o755 });
    }
    const probe = await promisify(execFile)(runtime, [join(packageRoot, "dist", "runmesh.cjs"), "--version"], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
    if (probe.stdout.trim() !== target.version) throw new Error("Runner package reported a different version.");
    await writeFile(join(temporary, ".runmesh-release.json"), JSON.stringify({ version: target.version, manifest_sha256: manifestSha256, artifact_sha256: artifact.sha256 }), { flag: "wx", mode: 0o644 });
    await rename(temporary, versionDirectory);
    return { version: target.version, versionDirectory, manifestSha256, artifactSha256: artifact.sha256 };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
