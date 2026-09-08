import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredNode = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npmCli = process.platform === "win32" ? "npm.cmd" : "npm";
const npmVersion = execFileSync(npmCli, ["--version"], { encoding: "utf8", ...(process.platform === "win32" ? { shell: true } : {}) }).trim();
if (process.versions.node !== requiredNode || `npm@${npmVersion}` !== root.packageManager) {
  throw new Error(`toolchain mismatch: require Node ${requiredNode} and ${root.packageManager}; got Node ${process.versions.node} and npm ${npmVersion}`);
}
console.log(`toolchain verified: Node ${requiredNode}, npm ${npmVersion}`);
