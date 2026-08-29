import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "runmesh-pack-smoke-"));
const cache = join(root, "npm-cache");
try {
  const packed = await exec("npm", ["pack", "--workspace=@aloneio/runmesh-runner", "--pack-destination", root], { cwd: process.cwd() });
  const runner = packed.stdout.trim().split("\n").pop();
  if (!runner?.endsWith(".tgz")) throw new Error("npm pack did not return a Runner tarball");
  await exec("npm", ["init", "-y"], { cwd: root });
  await exec("npm", ["install", "--ignore-scripts", "--offline", join(root, runner)], { cwd: root, env: { ...process.env, npm_config_cache: cache } });
  const packageRoot = join(root, "node_modules", "@aloneio", "runmesh-runner");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.private === true || manifest.bin?.["runmesh-runner"] !== "./dist/coding-runner.cjs" || Object.keys(manifest.dependencies ?? {}).length !== 0) throw new Error("Runner tarball is not self-contained");
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await readFile(join(packageRoot, file));
  const bin = process.platform === "win32" ? join(root, "node_modules", ".bin", "runmesh-runner.cmd") : join(root, "node_modules", ".bin", "runmesh-runner");
  const version = await exec(bin, ["--version"], { cwd: root });
  if (version.stdout.trim() !== manifest.version) throw new Error(`packaged CLI version mismatch: ${version.stdout.trim()}`);
  const help = await exec(bin, ["--help"], { cwd: root });
  if (!help.stdout.includes("usage: runmesh-runner")) throw new Error("packaged CLI help is invalid");
  const doctor = await exec(bin, ["doctor", "--json"], { cwd: root }).catch((error) => error);
  const parsed = JSON.parse(String(doctor.stdout ?? ""));
  if (!Array.isArray(parsed.checks)) throw new Error("packaged doctor did not produce JSON checks");
  console.log(`pack smoke passed: self-contained runner ${manifest.version}`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
}
