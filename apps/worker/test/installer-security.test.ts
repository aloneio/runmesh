import { describe, expect, it } from "vitest";
import {
  FIXED_RELEASE_ALLOWED_REDIRECT_ORIGINS,
  canonicalPublicOrigin,
  powershellQuote,
  renderPowerShellInstaller,
  renderPosixInstaller,
  resolvePublicOrigin,
  shellQuote,
} from "../src/installer.js";

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
});
