import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, LOCKED_PERMISSION_SET, PERMISSION_BITS, normalizeUiPermissionSet } from "@aloneio/runmesh-protocol";
import fixtures from "./fixtures/admin-render-golden.json";
import { authEntryDocument, secretCreatedPage } from "../src/admin/auth-views.js";
import { overviewPage, settingsPage } from "../src/admin/dashboard-views.js";
import { clientsPage, clientDetailPage } from "../src/admin/client-views.js";
import { runnersPage } from "../src/admin/runner-list-view.js";
import { runnerDetailPage } from "../src/admin/runner-detail-view.js";
import { adminDocument } from "../src/admin/layout.js";
import { html, htmlHeaders, redirect } from "../src/http/html-response.js";
import { localizeHtmlResponse } from "../src/i18n/html.js";
import { permissionForm, managedWorkspaceForm, workspaceProfile } from "../src/admin/forms.js";
import { workspacePermissionPreset } from "../src/contracts/permission-profiles.js";
import type { AdminData } from "../src/contracts/admin-views.js";

// Hashes were captured by evaluating the pre-refactor renderers at the fixed
// baseline. Reviewed i18n annotations and login copy changes retain their
// original hashes in the fixture; all unrelated markup remains unchanged.
// No production state.
const views = { authEntryDocument, secretCreatedPage, overviewPage, settingsPage, clientsPage, clientDetailPage, runnersPage, runnerDetailPage, adminDocument };
describe("AR04 rendering compatibility", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(fixtures.clock_ms); });
  afterEach(() => vi.useRealTimers());
  for (const fixture of fixtures.cases) it(`preserves reviewed ${fixture.name} markup (origin ${fixtures.baseline.slice(0, 7)})`, () => {
    const args: unknown[] = [...fixture.args];
    if (fixture.fn === "runnersPage") {
      const presentation = (fixture as unknown as { presentation: { configuredModes: Record<string, string | null>; maxValidityDays: number } }).presentation;
      args.unshift({ ...presentation, configuredModes: new Map(Object.entries(presentation.configuredModes)) });
    }
    if (fixture.fn === "runnerDetailPage") {
      const [runner, workspaces, jobs, environment, csrf, release] = args;
      args.splice(0, args.length, {
        presentation: (fixture as unknown as { presentation: unknown }).presentation,
        runner, workspaces, jobs: jobs ?? undefined, environment: environment ?? undefined, csrf, release,
      });
    }
    const render = views[fixture.fn as keyof typeof views] as (...args: unknown[]) => string;
    const value = render(...args);
    expect(new TextEncoder().encode(value).byteLength).toBe(fixture.bytes);
    expect(sha256Hex(value)).toBe(fixture.sha256);
  });

  it.each([true, false])("shows computer permissions for the initial access mode when central is %s", async (centralEnabled) => {
    const content = clientsPage({ clients: [], runners: [], jobs: [], snapshot: {}, notices: [] }, "fixture-csrf", centralEnabled);
    expect(content).toContain(`<details data-client-computer-permissions${centralEnabled ? "" : " open"}>`);
    expect(content.includes('<option value="central">')).toBe(centralEnabled);
    expect(content).toContain('<input type="checkbox" name="scopes" value="coding:read" checked>');
    expect(content).toContain('<input type="checkbox" name="scopes" value="coding:write">');
    expect(content).toContain('<input type="checkbox" name="scopes" value="coding:exec">');
    for (const locale of ["en", "zh-CN"] as const) {
      const response = localizeHtmlResponse(new Request(`https://worker.test/admin/clients?lang=${locale}`),
        new Response(`<html><body>${content}</body></html>`, { headers: { "content-type": "text/html" } }));
      const localized = await response.text();
      expect(localized).toContain(`<details data-client-computer-permissions${centralEnabled ? "" : " open"}>`);
      expect(localized).toContain(`<summary>${locale === "en" ? "Computer permissions" : "计算机权限"}</summary>`);
      expect(localized).toContain('<input type="checkbox" name="scopes" value="coding:read" checked>');
    }
  });

  it("keeps untrusted names escaped and rendering synchronous", () => {
    const content = secretCreatedPage("<img src=x onerror=alert(1)>", "https://example.test/a?x=<b>&y=\"");
    expect(typeof content).toBe("string");
    expect(content).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(content).not.toContain("<img src=x onerror=alert(1)>");
  });

  it.each(["en", "zh-CN"] as const)("uses one translated heading for desktop and mobile inventory cells in %s", async locale => {
    const data: AdminData = { clients: [{ client_id: "test-client", label: "Client <label>", scopes: [], revoked_at_ms: null,
      last_used_at_ms: null, active_runner_id: null }], runners: [{ runner_id: "test-runner", display_name: "Runner <label>",
      state: "offline", last_heartbeat_ms: null, configured_execution_mode: null, public_info: null }], jobs: [], snapshot: {}, notices: [] };
    const presentation = { configuredModes: new Map(), maxValidityDays: 3650 };
    for (const render of [(value: AdminData) => runnersPage(presentation, value, "fixture-csrf"), (value: AdminData) => clientsPage(value, "fixture-csrf")]) {
      const localized = await localizeHtmlResponse(new Request('https://worker.test/admin?lang=' + locale),
        new Response('<html><body>' + render(data) + '</body></html>', { headers: { "content-type": "text/html" } })).text();
      const headings = [...localized.matchAll(/<th scope="col" data-column="[^"]+">([^<]+)<\/th>/gu)].map(match => match[1]);
      const labels = [...localized.matchAll(/<span class="table-mobile-label" aria-hidden="true">([^<]+)<\/span>/gu)].map(match => match[1]);
      expect(headings).toHaveLength(6);
      expect(labels).toEqual(headings);
      expect(headings.at(-1)).toBe(locale === "en" ? "Actions" : "操作");
      expect(localized).toContain('&lt;label&gt;');
      expect(render({ ...data, clients: [], runners: [] })).not.toContain('class="table-mobile-label"');
    }
  });

  it("renders permission dependencies and workspace presets from the shared policy", () => {
    const forms = [permissionForm("r", LOCKED_PERMISSION_SET, "csrf"), managedWorkspaceForm("r", undefined, "csrf")];
    for (const form of forms) for (const name of PERMISSION_BITS) {
      const enabled = normalizeUiPermissionSet({ ...LOCKED_PERMISSION_SET, [name]: true });
      const required = PERMISSION_BITS.filter(bit => bit !== name && enabled[bit]).join(" ");
      expect(form).toContain(`<select name="${name}" data-permission-requires="${required}">`);
    }
    for (const name of ["read_only", "edit_only", "controlled_exec"]) {
      const permissions = workspacePermissionPreset(name)!;
      expect(workspaceProfile(permissions)).toBe(name);
      const enabled = PERMISSION_BITS.filter(bit => permissions[bit]).join(" ");
      expect(forms[1]).toContain(`<option value="${name}" data-permission-preset="${enabled}"`);
    }
  });

  it.each(["active", "scheduled", "expired"] as const)("shows a used enrollment code as consumed regardless of its %s window", async window => {
    const now = fixtures.clock_ms;
    const content = runnerDetailPage({
      presentation: { configuredMode: "dedicated_user", reportedMode: "dedicated_user", maxValidityDays: 3650, dayMs: 86400000 },
      runner: { runner_id: "enrollment-fixture" }, workspaces: [], csrf: "fixture-csrf", release: { latest_version: "0.1.6", distributable: true },
      enrollment: { not_before_ms: window === "scheduled" ? now + 1000 : now - 1000, expires_at_ms: window === "expired" ? now - 1 : now + 2000, used_at_ms: now - 500 },
    });
    for (const locale of ["en", "zh-CN"] as const) {
      const localized = await localizeHtmlResponse(new Request('https://worker.test/admin/runners/enrollment-fixture?lang=' + locale),
        new Response('<html><body>' + content + '</body></html>', { headers: { "content-type": "text/html" } })).text();
      const heading = locale === "en" ? "Latest enrollment code" : "最新注册码";
      expect(localized).toContain('<h2>' + heading + '</h2><span class="badge offline">' + (locale === "en" ? "Used" : "已使用") + '</span>');
      expect(localized).toContain('/admin/runners/enrollment-fixture/enrollment');
      expect(localized).toContain(locale === "en" ? "Each code can be used once. Generate a new code to enroll again." : "注册码仅可使用一次；重新注册请生成新注册码。");
    }
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
