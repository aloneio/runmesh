import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { assertSecurityReadiness } from "./release-readiness.mjs";
import { sourceObservation, ROOT } from "./ci-report.mjs";
try {
  const manifest = JSON.parse(await readFile(new URL("../release/security-readiness.json", import.meta.url), "utf8"));
  const source = sourceObservation();
  if (source.state !== "clean") throw new Error("unclean release source");
  const verification = JSON.parse(await readFile(new URL("../ci-results/security-regressions.json", import.meta.url), "utf8"));
  const result = assertSecurityReadiness(manifest, source.commit, verification);
  for (const finding of manifest.findings) {
    execFileSync("git", ["merge-base", "--is-ancestor", finding.fixed_commit, source.commit], { cwd: ROOT, timeout: 5000, stdio: "pipe" });
    for (const file of finding.regressions) execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: ROOT, timeout: 5000, stdio: "pipe" });
  }
  console.log(JSON.stringify(result));
} catch {
  console.error("security_release_blocked: resolve and rerun each documented security regression on the release candidate; no signing or publishing was attempted");
  process.exitCode = 1;
}
