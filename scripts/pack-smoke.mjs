import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
// On Windows npm is exposed as a .cmd shim rather than a native executable;
// execFile cannot launch a .cmd shim without shell dispatch, so select the
// shim explicitly and enable that dispatch only on Windows.
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecOptions = process.platform === "win32" ? { shell: true } : {};
const root = await mkdtemp(join(tmpdir(), "runmesh-pack-smoke-"));
const cache = join(root, "npm-cache");
try {
  const packed = await exec(npmExecutable, ["pack", "--workspace=@aloneio/runmesh-runner", "--pack-destination", root], { cwd: process.cwd(), ...npmExecOptions });
  const runner = packed.stdout.trim().split("\n").pop();
  if (!runner?.endsWith(".tgz")) throw new Error("npm pack did not return a Runner tarball");
  await exec(npmExecutable, ["init", "-y"], { cwd: root, ...npmExecOptions });
  await exec(npmExecutable, ["install", "--ignore-scripts", "--offline", join(root, runner)], { cwd: root, env: { ...process.env, npm_config_cache: cache }, ...npmExecOptions });
  const packageRoot = join(root, "node_modules", "@aloneio", "runmesh-runner");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.private === true || manifest.bin?.["runmesh-runner"] !== "./dist/coding-runner.cjs" || Object.keys(manifest.dependencies ?? {}).length !== 0) throw new Error("Runner tarball is not self-contained");
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await readFile(join(packageRoot, file));
  const bin = process.platform === "win32" ? join(root, "node_modules", ".bin", "runmesh-runner.cmd") : join(root, "node_modules", ".bin", "runmesh-runner");
  const binExecOptions = process.platform === "win32" ? { shell: true } : {};
  const version = await exec(bin, ["--version"], { cwd: root, ...binExecOptions });
  if (version.stdout.trim() !== manifest.version) throw new Error(`packaged CLI version mismatch: ${version.stdout.trim()}`);
  const help = await exec(bin, ["--help"], { cwd: root, ...binExecOptions });
  if (!help.stdout.includes("usage: runmesh-runner")) throw new Error("packaged CLI help is invalid");
  const doctor = await exec(bin, ["doctor", "--json"], { cwd: root, ...binExecOptions }).catch((error) => error);
  const parsed = JSON.parse(String(doctor.stdout ?? ""));
  if (!Array.isArray(parsed.checks)) throw new Error("packaged doctor did not produce JSON checks");
  // Use a real consumer argv[1] so a library import cannot hide a CLI side
  // effect behind Node's `-e` convention (where argv[1] is undefined).
  const library = await exec(process.execPath, ["--input-type=module", "-e", "process.argv[1] = 'consumer.mjs'; import('@aloneio/runmesh-runner').then((value) => { if (typeof value.runCli !== 'function') process.exit(1); })"], { cwd: root });
  if (library.stdout.includes("usage: runmesh-runner") || library.stderr.trim() !== "") throw new Error(`packaged library import emitted unexpected output: ${library.stdout}${library.stderr}`);
  const commonjs = await exec(process.execPath, ["-e", "const value = require('@aloneio/runmesh-runner'); const config = require('@aloneio/runmesh-runner/config'); if (typeof value.runCli !== 'function' || typeof config.parseRunnerArgs !== 'function') process.exit(1);"], { cwd: root });
  if (commonjs.stdout.trim() !== "" || commonjs.stderr.trim() !== "") throw new Error(`packaged CommonJS import emitted unexpected output: ${commonjs.stdout}${commonjs.stderr}`);
  // TypeScript consumers must be able to use the published declaration graph
  // without installing the unpublished workspace protocol package or
  // @types/node. Keep this check strict (no skipLibCheck) so missing ambient
  // dependencies cannot be hidden by the release smoke test.
  const consumerSource = [
    'import { RunnerConnection, RunnerRuntime, type HostPlatform, type RunnerConfig } from "@aloneio/runmesh-runner";',
    'import { parseRunnerArgs } from "@aloneio/runmesh-runner/config";',
    "declare const config: RunnerConfig;",
    "void RunnerConnection;",
    "void new RunnerRuntime({ config });",
    "void parseRunnerArgs;",
    "const platform: HostPlatform = \"linux\";",
    "void platform;",
    "",
  ].join("\n");
  const esmConsumer = join(root, "consumer.mts");
  const cjsConsumer = join(root, "consumer.cts");
  await writeFile(esmConsumer, consumerSource, "utf8");
  await writeFile(cjsConsumer, consumerSource, "utf8");
  const tscPath = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const strictTypecheckArgs = [
    tscPath,
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--target", "ES2022",
  ];
  await exec(process.execPath, [...strictTypecheckArgs, "--module", "NodeNext", "--moduleResolution", "NodeNext", esmConsumer], { cwd: root });
  await exec(process.execPath, [...strictTypecheckArgs, "--module", "Node16", "--moduleResolution", "Node16", cjsConsumer], { cwd: root });
  console.log(`pack smoke passed: self-contained runner ${manifest.version}`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
}
