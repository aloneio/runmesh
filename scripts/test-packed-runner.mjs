import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.argv.length, 3, "pass the exact Runner tarball to validate");
const archive = resolve(process.argv[2]);
const info = await stat(archive);
assert.ok(info.isFile() && info.size > 0 && info.size <= 8*1024*1024, "invalid portable archive size");
const root = await mkdtemp(join(tmpdir(), "runmesh-exact-package-e2e-"));
async function run(command, args, options = {}) {
  const child = spawn(command,args,{cwd:repo,stdio:"inherit",...options});
  const code = await new Promise((resolveExit,reject) => { child.once("error",reject); child.once("exit",(code,signal) => resolveExit(signal === null ? code : 1)); });
  assert.equal(code,0,`${command} failed while checking exact portable artifact`);
}
try {
  await writeFile(join(root,"package.json"),JSON.stringify({name:"runmesh-artifact-test",version:"1.0.0",private:true}));
  await run(process.platform === "win32" ? "npm.cmd" : "npm",["install","--ignore-scripts","--offline","--no-audit","--no-fund",archive],{cwd:root,env:{...process.env,npm_config_cache:join(root,"empty-cache")},...(process.platform === "win32" ? {shell:true} : {})});
  const pkg = join(root,"node_modules","@aloneio","runmesh-runner");
  const manifest = JSON.parse(await readFile(join(pkg,"package.json"),"utf8"));
  const source = JSON.parse(await readFile(join(repo,"package.json"),"utf8"));
  assert.equal(manifest.version,source.version);
  assert.equal(Object.keys(manifest.dependencies ?? {}).length,0);
  const entry = join(pkg,"dist","runmesh.cjs");
  await run(process.execPath,[entry,"--version"]);
  await run(process.execPath,[join(repo,"scripts","run-e2e.mjs")],{env:{...process.env,RUNMESH_E2E_RUNNER_ENTRY:entry}});
  console.log(`EXACT_PACKAGED_RUNNER_E2E_OK ${manifest.version}`);
} finally { await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
