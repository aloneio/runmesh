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
import { runnerEnrollmentPage } from "../src/index.js";

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

  it("keeps enrollment codes out of copied commands and rejects Host confusion", async () => {
    const code = "A".repeat(43);
    const page = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://worker.example", "runner-test", code, "csrf");
    expect(page.status).toBe(200);
    const html = await page.text();
    // The code is shown once for the operator, but it must never be present
    // in a command/clipboard payload or passed as an argv value.
    expect(html).toContain(code);
    expect(html).not.toContain(`--code ${code}`);
    expect(html).toContain("--code-stdin");

    const rejected = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://evil.example", "runner-test", code, "csrf");
    expect(rejected.status).toBe(421);

    const hosted = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example", RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, "https://worker.example", "runner-test", code, "csrf");
    expect(hosted.status).toBe(200);
    const hostedHtml = await hosted.text();
    expect(hostedHtml).not.toContain(`--code ${code}`);
    expect(hostedHtml).toContain("Copy installer command");
  });

  it("states the privileged_host default and confirmation requirement on the enrollment page", async () => {
    const code = "B".repeat(43);
    const page = runnerEnrollmentPage({ RUNMESH_PUBLIC_ORIGIN: "https://worker.example" }, "https://worker.example", "runner-test", code, "csrf");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("The recommended execution mode is privileged_host");
    expect(html).toContain("--confirm-privileged-host");
  });
});
