import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@aloneio/runmesh-protocol";
import fixtures from "./fixtures/admin-render-golden.json";
import { authEntryDocument, secretCreatedPage } from "../src/admin/auth-views.js";
import { overviewPage, settingsPage } from "../src/admin/dashboard-views.js";
import { clientsPage, clientDetailPage } from "../src/admin/client-views.js";
import { runnersPage } from "../src/admin/runner-list-view.js";
import { runnerDetailPage } from "../src/admin/runner-detail-view.js";
import { adminDocument } from "../src/admin/layout.js";
import { html, htmlHeaders, redirect } from "../src/http/html-response.js";

// Hashes were captured by evaluating the pre-refactor renderers at the fixed
// baseline, not generated from the replacement views. No production state.
const views = { authEntryDocument, secretCreatedPage, overviewPage, settingsPage, clientsPage, clientDetailPage, runnersPage, runnerDetailPage, adminDocument };
describe("AR04 rendering compatibility", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(fixtures.clock_ms); });
  afterEach(() => vi.useRealTimers());
  for (const fixture of fixtures.cases) it(`preserves exact ${fixture.name} markup from ${fixtures.baseline.slice(0, 7)}`, () => {
    const args: unknown[] = [...fixture.args];
    if (fixture.fn === "runnersPage") {
      const presentation = (fixture as unknown as { presentation: { configuredModes: Record<string, string | null>; maxValidityDays: number } }).presentation;
      args.unshift({ ...presentation, configuredModes: new Map(Object.entries(presentation.configuredModes)) });
    }
    if (fixture.fn === "runnerDetailPage") {
      if (args[2] === null) args[2] = undefined;
      if (args[3] === null) args[3] = undefined;
      args.unshift((fixture as unknown as { presentation: unknown }).presentation);
    }
    const render = views[fixture.fn as keyof typeof views] as (...args: unknown[]) => string;
    const value = render(...args);
    expect(new TextEncoder().encode(value).byteLength).toBe(fixture.bytes);
    expect(sha256Hex(value)).toBe(fixture.sha256);
  });

  it("keeps untrusted names escaped and rendering synchronous", () => {
    const content = secretCreatedPage("<img src=x onerror=alert(1)>", "https://example.test/a?x=<b>&y=\"");
    expect(typeof content).toBe("string");
    expect(content).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(content).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("keeps response status, no-store cookies and CSP nonce bound to the owned script", async () => {
    const response = html(authEntryDocument("login", "synthetic-csrf"), ["fixture=1; Secure; HttpOnly"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("fixture=1");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    const body = await response.text();
    const nonce = body.match(/<script nonce="([^"]+)"/u)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    const moved = redirect("/admin", ["fixture=2; Secure"]);
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/admin");
    expect(moved.headers.get("set-cookie")).toContain("fixture=2");
    expect(htmlHeaders().get("content-security-policy")).toContain("script-src 'none'");
  });
});
