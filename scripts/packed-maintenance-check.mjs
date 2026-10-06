import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Exercise the exact published manager alone: neither the selected Runner nor
 * workspace modules are available in an installed manager directory. */
export async function checkPackedMaintenance(packageRoot, version) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-maintenance-package-"));
  try {
    const entry = join(root, "maintenance.cjs");
    await copyFile(join(packageRoot, "dist", "maintenance.cjs"), entry);
    await writeFile(join(root, "runmesh.cjs"), 'throw new Error("selected Runner cannot start");\n');
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = args => execute(process.execPath, [entry, ...args], { cwd: root, env, timeout: 15_000, maxBuffer: 65_536, windowsHide: true });
    const reported = await run(["--version"]);
    assert.equal(reported.stdout.trim(), version, "packaged maintenance version differs from the signed Runner package");
    assert.equal(reported.stderr, "");
    const help = await run(["--help"]);
    assert.ok(help.stdout.includes("Runmesh maintenance") && help.stdout.includes("maintenance-agent"), "packaged maintenance entry did not load independently");
    assert.equal(help.stderr, "");
    await assert.rejects(run(["maintenance-agent"]), error => error.code === 1 && /--profilePath is required/u.test(error.stderr), "maintenance must validate its own arguments before loading the host installation");
    await assert.rejects(run(["start"]), error => error.code === 1 && /Runmesh maintenance/u.test(error.stderr) && !/selected Runner cannot start|Cannot find module/u.test(error.stderr), "maintenance must reject ordinary Runner commands without loading them");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
