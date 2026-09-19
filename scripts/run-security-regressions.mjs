import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, sourceObservation } from "./ci-report.mjs";
import { securityTestFiles, projectSecurityEvidence } from "./security-regressions.mjs";
import { assertSecurityReadiness } from "./release-readiness.mjs";
import { readEvidenceJson } from "./evidence-io.mjs";

const target = join(ROOT, "ci-results/security-regressions.json");
let temporary, source;
async function publish(value) {
  const directory = join(ROOT, "ci-results"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
  const file = join(directory, `security-${crypto.randomUUID()}.tmp`);
  try { await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(file, target); }
  finally { await rm(file, { force: true }); }
}
try {
  source = sourceObservation();
  await publish({ schema_version: 1, commit: source.commit, state: "not_run", findings: [] });
  assert.equal(process.platform, "linux", "this security evidence lane requires Linux; native lanes remain separate");
  assert.equal(source.state, "clean", "security evidence requires a clean candidate");
  const manifest = await readEvidenceJson(join(ROOT, "release/security-readiness.json"), 65536);
  const files = securityTestFiles(manifest);
  temporary = await mkdtemp(join(tmpdir(), "runmesh-security-regressions-"));
  const reports = [];
  for (const workspace of ["runner", "worker"]) {
    const prefix = `apps/${workspace}/`, selected = files.filter(file => file.startsWith(prefix));
    if (selected.length === 0) continue;
    const report = join(temporary, `${workspace}.json`);
    const processResult = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...selected.map(file => file.slice(prefix.length)), "--reporter=json", `--outputFile=${report}`], {
      cwd: join(ROOT, prefix), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "inherit", timeout: 240000,
    });
    assert.equal(processResult.status, 0, `${workspace} security regressions did not pass`);
    reports.push(await readEvidenceJson(report));
  }
  assert.deepEqual(sourceObservation(), source, "candidate changed during security verification");
  const evidence = projectSecurityEvidence(manifest, source.commit, reports, ROOT);
  assertSecurityReadiness(manifest, source.commit, evidence);
  await publish(evidence);
  console.log(JSON.stringify({ security_regressions: "passed", commit: source.commit, findings: evidence.findings.length, files: files.length, signed_release: "not_run", production: "not_run" }));
} catch {
  await publish({ schema_version: 1, commit: source?.commit ?? null, state: "failed", findings: [] }).catch(() => undefined);
  console.error("security_regressions_failed: require reviewed closure, a clean source and successful unskipped runtime assertions; see the verification log");
  process.exitCode = 1;
} finally { if (temporary !== undefined) await rm(temporary, { recursive: true, force: true }); }
