import { describe, expect, it } from "vitest";
import { FIXED_RELEASE_VERSION, renderPosixInstaller, renderPowerShellInstaller, renderPosixUninstaller, renderPowerShellUninstaller } from "../src/installer.js";
import { runnerEnrollmentPage } from "../src/index.js";

describe("maintenance bootstrap", () => {
  it("uses a separately downloaded runtime and package, not an old installed binary", () => {
    const shell = renderPosixUninstaller("https://worker.example");
    const windows = renderPowerShellUninstaller("https://worker.example");
    expect(shell).toContain("RUNMESH_ACTION='uninstall'");
    expect(windows).toContain("$MaintenanceAction = 'uninstall'");
    expect(shell).toContain('"$MAINTENANCE/lib/node_modules/@aloneio/runmesh-runner/dist/runmesh.cjs" uninstall --purge --yes');
    expect(windows).toContain("& $NodePath $MaintenanceRunner uninstall --purge --yes");
    expect(shell.indexOf("signature does not verify")).toBeLessThan(shell.indexOf('"$MAINTENANCE/lib/node_modules'));
    expect(windows.indexOf("signature does not verify")).toBeLessThan(windows.indexOf("& $NodePath $MaintenanceRunner"));
    for (const script of [shell, windows]) expect(script).not.toContain("__ACTION__");
  });
  it("isolates cleanup failure from new-install rollback and never purges legacy data during install rollback", () => {
    const shell = renderPosixInstaller("https://worker.example");
    const windows = renderPowerShellInstaller("https://worker.example");
    expect(shell).toContain('if [ "$RUNMESH_ACTION" = uninstall ]; then cleanup;');
    expect(shell).not.toContain('uninstall --profile "$PROFILE" --purge');
    expect(windows).toContain("if (-not $Succeeded -and $MaintenanceAction -ne 'uninstall')");
    expect(windows).not.toContain("uninstall --profile $Profile --purge");
  });
  it("shows compact installation stages without release-engineering jargon or checksum success paths", () => {
    const shell = renderPosixInstaller("https://worker.example");
    const windows = renderPowerShellInstaller("https://worker.example");
    for (const script of [shell, windows]) {
      expect(script).not.toContain("Downloading the fixed release assets.");
      expect(script).not.toContain("Installing the verified Runner package.");
      expect(script).toContain("Preparing runtime");
      expect(script).toContain("Starting service");
      expect(script).toContain("signature does not verify");
    }
    expect(shell).toContain("sha256sum -c - > /dev/null");
    expect(shell).toContain('[ -z "${NO_COLOR:-}" ]');
    expect(shell).not.toContain("__NO_COLOR__");
    expect(windows).toMatch(/^[\x00-\x7f]*$/u);
  });
  it("offers one-line reinstall-safe uninstall with no enrollment credential", async () => {
    const code = "A".repeat(43);
    const html = await runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example", RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, "https://worker.example", "test", code, "csrf").text();
    expect(html).toContain("/runner/uninstall.sh"); expect(html).toContain("/runner/uninstall.ps1");
    for (const command of [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]!)) {
      if (command.includes("uninstall.")) { expect(command).not.toContain(code); expect(command).toContain("--purge --yes"); expect(command).not.toContain("\n"); }
    }
  });
});
