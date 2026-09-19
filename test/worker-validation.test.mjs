import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execute = promisify(execFile);
const marker = "--dry-run: exiting now.";

/** Exercise the actual validator in an isolated fake checkout. No production
 * CLI substitution option or deployment credential is added to the wrapper. */
async function validate(script, timeout = "5000") {
  const root = await mkdtemp(join(tmpdir(), "runmesh-validator-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "node_modules/wrangler/bin"), { recursive: true });
    for (const file of ["validate-worker.mjs", "windows-tools.mjs"]) {
      await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(root, "scripts", file));
    }
    await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), script);
    try {
      const result = await execute(process.execPath, [join(root, "scripts/validate-worker.mjs")], {
        cwd: root, encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024,
        env: { ...process.env, RUNMESH_VALIDATE_WORKER_TIMEOUT_MS: timeout }, windowsHide: true,
      });
      return { code: 0, ...result };
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("validator recognizes success before a long same-chunk telemetry trailer", async () => {
  const result = await validate(`require('node:fs').writeSync(1, ${JSON.stringify(marker + "\n" + "telemetry ".repeat(220))});`);
  assert.equal(result.code, 0, result.stderr);
});

test("validator preserves a partial stdout marker across interleaved stderr", async () => {
  const result = await validate(`const fs=require('node:fs');fs.writeSync(1,'--dry-run: ');setTimeout(()=>{fs.writeSync(2,'independent warning\\n');setTimeout(()=>fs.writeSync(1,'exiting now.\\n'),30);},30);`);
  assert.equal(result.code, 0, result.stderr);
});

test("validator cannot manufacture success from marker halves on different streams", async () => {
  const result = await validate(`const fs=require('node:fs');fs.writeSync(1,'--dry-run: ');setTimeout(()=>fs.writeSync(2,'exiting now.\\n'),30);`);
  assert.notEqual(result.code, 0);
});

test("validator drains child stdio before deciding whether the success marker exists", async () => {
  const writer = `setTimeout(()=>require('node:fs').writeSync(1,${JSON.stringify(marker + "\n")}),80);`;
  // The writer must actually survive its parent on Windows as well as POSIX.
  // It has one bounded timer and exits naturally after writing, not a daemon.
  const result = await validate(`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:['ignore',1,2],windowsHide:true,detached:true});child.unref();`);
  assert.equal(result.code, 0, result.stderr);
});

test("validator rejects an explicit failure even if success-looking text preceded it", async () => {
  const result = await validate(`require('node:fs').writeSync(1,${JSON.stringify(marker + "\n")});process.exitCode=7;`);
  assert.equal(result.code, 7);
});

test("validator does not accept a zero exit without a success marker", async () => {
  const result = await validate(`console.log('not a successful dry run');`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /without its successful dry-run marker/);
});

test("validator timeout remains a bounded failure, not success", async () => {
  const result = await validate(`setInterval(()=>{},1000);`, "300");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not finish within 300 ms/);
});

test("validator cleans up a lingering CLI only after its verified dry-run marker", async () => {
  const result = await validate(`require('node:fs').writeSync(1,${JSON.stringify(marker + "\n")});setInterval(()=>{},1000);`);
  assert.equal(result.code, 0, result.stderr);
});
