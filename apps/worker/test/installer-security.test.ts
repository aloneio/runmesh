import { describe, expect, it } from "vitest";
import {
  FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS,
  FIXED_RELEASE_VERSION,
  canonicalPublicOrigin,
  powershellQuote,
  renderPowerShellInstaller,
  renderPosixInstaller,
  resolvePublicOrigin,
  shellQuote,
} from "../src/installer.js";
import { runnerConfiguredExecutionMode, runnerEnrollmentPage } from "../src/index.js";

describe("hosted installer origin and template safety", () => {
  it("canonicalizes only strict HTTPS authorities", () => {
    expect(canonicalPublicOrigin("https://EXAMPLE.test:443/")).toBe("https://example.test");
    expect(canonicalPublicOrigin("https://example.test:8443")).toBe("https://example.test:8443");
    for (const value of [
      "https://x.test';id;#",
      "https://x.test%27.example",
      "https://user:pass@example.test",
      "http://example.test",
      "https://example.test/path",
      "https://example.test?redirect=1",
      "https://example.test\\evil",
      "https://foo_bar.example",
      "https://example.test:0",
    ]) {
      expect(() => canonicalPublicOrigin(value)).toThrow();
    }
  });

  it("uses the configured public origin and rejects Host confusion", () => {
    const request = new Request("https://public.example/runner/install.sh", { headers: { host: "public.example" } });
    expect(resolvePublicOrigin(request, "https://PUBLIC.example/")).toBe("https://public.example");
    expect(resolvePublicOrigin(new Request("https://internal.worker/runner/install.sh", { headers: { host: "public.example" } }), "https://public.example")).toBe("https://public.example");
    expect(resolvePublicOrigin(new Request("http://internal.worker/runner/install.sh", { headers: { host: "public.example" } }), "https://public.example")).toBe("https://public.example");
    expect(resolvePublicOrigin(new Request("https://custom.example/runner/install.sh", { headers: { host: "custom.example" } }), "https://public.example")).toBe("https://custom.example");
    expect(() => resolvePublicOrigin(new Request("https://public.example/runner/install.sh", { headers: { host: "evil.example" } }), "https://public.example")).toThrow();
    expect(() => resolvePublicOrigin(new Request("https://public.example/runner/install.sh", { headers: { host: "x.test';id;#" } }), "https://public.example")).toThrow();
    expect(() => resolvePublicOrigin(new Request("https://public.example/runner/install.sh", { headers: { host: "evil.example" } }))).toThrow();
  });

  it("quotes shell metacharacters without creating a second command", () => {
    expect(shellQuote("a'b;$(id)\nnext")).toBe("'a'\"'\"'b;$(id)\nnext'");
    expect(powershellQuote("a'b;$(id)`x")).toBe("'a''b;$(id)`x'");
    expect(() => shellQuote("bad\u0000value")).toThrow();
    expect(() => powershellQuote("bad\u0000value")).toThrow();
  });

  it("renders fixed installers with pinned HTTPS redirects and escaped enrollment URL", () => {
    const shell = renderPosixInstaller("https://worker.example");
    const powershell = renderPowerShellInstaller("https://worker.example");
    for (const text of [shell, powershell]) {
      expect(text.toLowerCase()).toContain("release redirect escaped pinned origins");
      expect(text).toContain("https://github.com");
      expect(text).toContain("https://objects.githubusercontent.com");
      expect(text).not.toContain("__RELEASE_");
      expect(text).not.toContain("coding-runner");
    }
    expect(shell).toContain("--proto-redir '=https'");
    expect(shell).toContain("--max-redirs 0");
    expect(shell).toContain("release redirect Location is invalid");
    expect(powershell).toContain("AllowAutoRedirect = $false");
    expect(powershell).toContain("$AllowedReleaseOrigins -notcontains $nextOrigin");
    expect(renderPosixInstaller("https://worker.example")).toContain("ENROLLMENT_URL='https://worker.example/runner/enroll'");
    expect(renderPowerShellInstaller("https://worker.example")).toContain("$EnrollmentUrl = 'https://worker.example/runner/enroll'");
  });

  it("keeps redirect allowlist finite and HTTPS-only", () => {
    expect(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS.length).toBeGreaterThan(1);
    expect(FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS.every((value) => value.startsWith("https://"))).toBe(true);
  });

  it("embeds enrollment codes in hosted commands while keeping manual enrollment available", async () => {
    const code = "A".repeat(43);
    const page = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://worker.example", "runner-test", code, "csrf", false, "privileged_host", true);
    expect(page.status).toBe(200);
    const html = await page.text();
    // Without a verified release gate, the manual path still prompts locally.
    // With the gate enabled, hosted commands include the code for convenience.
    expect(html).toContain(code);
    expect(html).not.toContain(`--code ${code}`);
    expect(html).toContain("--code-stdin");

    const rejected = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://evil.example/path", "runner-test", code, "csrf");
    expect(rejected.status).toBe(421);

    const hosted = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example", RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, "https://worker.example", "runner-test", code, "csrf", false, "privileged_host", true);
    expect(hosted.status).toBe(200);
    const hostedHtml = await hosted.text();
    expect(hostedHtml).toContain(code);
    const commands = [...hostedHtml.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((match) => match[1]);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const command of commands.slice(0, 3)) expect(command).toContain(code);
    expect(commands[0]).toContain(`sudo sh -s -- &#039;${code}&#039;`);
    expect(commands[1]).toContain(`sudo sh -s -- &#039;${code}&#039;`);
    expect(commands[2]).toContain(`.Content)) &#039;${code}&#039;&quot;`);
    expect(hostedHtml).toContain("-NonInteractive");
    expect(hostedHtml).toContain("no second code entry is needed");
    expect(hostedHtml).toContain("Treat the command as a secret");
    expect(hostedHtml).toContain("Copy installer command");
  });

  it("states the dedicated_user default and privileged confirmation requirement on the enrollment page", async () => {
    const code = "B".repeat(43);
    const page = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://worker.example", "runner-test", code, "csrf", false, "privileged_host", true);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("The default is dedicated_user");
    expect(html).toContain("--confirm-privileged-host");
    expect(runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://worker.example", "runner-test", code, "csrf", false, "privileged_host").status).toBe(400);
  });

  it("never treats Runner-reported execution mode as administrator authorization", () => {
    expect(runnerConfiguredExecutionMode({
      configured_execution_mode: "privileged_host",
      metadata: { execution_mode: "privileged_host" },
      public_info: { execution_mode: "privileged_host" },
    })).toBe("privileged_host");
    expect(runnerConfiguredExecutionMode({
      metadata: { execution_mode: "dedicated_user" },
      public_info: { execution_mode: "dedicated_user" },
    })).toBeNull();
    expect(runnerConfiguredExecutionMode({
      configured_execution_mode: "dedicated_user",
      metadata: { execution_mode: "privileged_host" },
      public_info: { execution_mode: "privileged_host" },
    })).toBe("dedicated_user");
  });
});

it("accepts enrollment arguments with an optional prompt and keeps stdin forwarding", () => {
  const shell = renderPosixInstaller("https://worker.example");
  const powershell = renderPowerShellInstaller("https://worker.example");
  expect(shell).toContain("ENROLLMENT_CODE_ARG");
  expect(shell).toContain("--code)");
  expect(shell).toContain("--code=*)");
  expect(shell.match(/ENROLLMENT_CODE="\$ENROLLMENT_CODE_ARG"/g)).toHaveLength(2);
  expect(shell).not.toContain("ENROLLMENT_INPUT");
  expect(shell).not.toContain("REFRESH_INPUT");
  expect(shell).toContain("hidden terminal prompt");
  expect(powershell).toContain("EnrollmentCodeArgument");
  expect(powershell.match(/Read-EnrollmentCode \$EnrollmentCodeArgument/g)).toHaveLength(2);
  expect(powershell).toContain("-AsSecureString");
  expect(powershell).toContain("Enrollment code supplied more than once.");
  expect(powershell).toContain("return $CodeArgument");
  expect(shell.indexOf("ok 'Signed release assets verified.'")).toBeLessThan(shell.lastIndexOf("IFS= read -r ENROLLMENT_CODE"));
});

it("rejects old installed versions before code input and checks the Windows marker Boolean", () => {
  const shell = renderPosixInstaller("https://worker.example");
  const powershell = renderPowerShellInstaller("https://worker.example");
  const shellCheck = shell.indexOf('installed Runner version differs from the fixed release');
  expect(shellCheck).toBeGreaterThan(0);
  expect(shellCheck).toBeLessThan(shell.indexOf('IFS= read -r ENROLLMENT_CODE'));
  const refresh = powershell.slice(powershell.indexOf('function Refresh-Existing'));
  expect(refresh.indexOf('Installed Runner version differs from the fixed release')).toBeGreaterThan(0);
  expect(refresh.indexOf('Installed Runner version differs from the fixed release')).toBeLessThan(refresh.indexOf('$EnrollmentCode = Read-EnrollmentCode'));
  expect(refresh).toContain('if (-not (Select-String -LiteralPath $ServiceManifest');
  expect(refresh).not.toContain('$null -eq (Select-String');
});

it("keeps the downloaded PowerShell script safe for Windows PowerShell 5.1 file decoding", () => {
  // Windows PowerShell treats a BOM-less script as the current ANSI codepage.
  // ASCII-only templates parse identically both from a saved file and via IWR.
  expect(renderPowerShellInstaller("https://worker.example")).toMatch(/^[\x00-\x7f]*$/u);
});
