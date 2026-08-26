import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "runmesh-pack-smoke-"));
try {
  const protocol = (await exec("npm", ["pack", "--workspace=@aloneio/runmesh-protocol", "--pack-destination", root], { cwd: process.cwd() })).stdout.trim().split("\n").pop();
  const runner = (await exec("npm", ["pack", "--workspace=@aloneio/runmesh-runner", "--pack-destination", root], { cwd: process.cwd() })).stdout.trim().split("\n").pop();
  if (!protocol || !runner) throw new Error("npm pack did not return package names");
  const install = join(root, "install");
  await exec("npm", ["init", "-y"], { cwd: root });
  await exec("npm", ["install", "--ignore-scripts", join(root, protocol), join(root, runner)], { cwd: root });
  const packageJson = JSON.parse(await readFile(join(root, "node_modules", "@aloneio", "runmesh-runner", "package.json"), "utf8"));
  if (packageJson.private === true || packageJson.bin === undefined) throw new Error("runner package is not distributable");
  await exec("node", [join(root, "node_modules", "@aloneio", "runmesh-runner", "dist", "cli.js"), "--help"], { cwd: root }).catch((error) => {
    if (error?.code !== 1 || !String(error?.stderr ?? "").includes("usage:")) throw error;
  });
  console.log(`pack smoke passed: ${install}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
