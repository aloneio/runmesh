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
import { timestamp, timeMarkup } from "../src/admin/format.js";
import { jobTable, historyJobTable, mcpCallTable } from "../src/admin/tables.js";
import type { HistoryView } from "../src/history-ui.js";
import { PRODUCT_VERSION } from "../src/generated-version.js";

// Hashes were captured by evaluating the pre-refactor renderers at the fixed
// baseline. Reviewed i18n annotations and login copy changes retain their
// original hashes in the fixture; all unrelated markup remains unchanged.
// No production state.
const views = { authEntryDocument, secretCreatedPage, overviewPage, settingsPage, clientsPage, clientDetailPage, runnersPage, runnerDetailPage, adminDocument };
describe("AR04 rendering compatibility", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(fixtures.clock_ms); });
  afterEach(() => vi.useRealTimers());
  it("keeps malformed stored dates from interrupting task and audit lists", () => {
    for (const value of [8_640_000_000_000_001, Number.MAX_SAFE_INTEGER, NaN, Infinity, -1, 1.5]) {
      expect(timestamp(value)).toBe("—");
      expect(timeMarkup(value)).toBe("—");
      const jobs = jobTable([{ job_id: "old-job", workspace_id: "workspace", status: "succeeded", updated_at_ms: value },
        { job_id: "valid-job", workspace_id: "workspace", status: "succeeded", updated_at_ms: 1000 }], "runner");
      expect(jobs).toContain("old-job"); expect(jobs).toContain("valid-job");
      expect(jobs).toContain('<td class="time-cell">—</td>');
      expect(mcpCallTable([{ method: "remote.call", completed_at_ms: value }])).toContain('<td class="time-cell">—</td>');
    }
    expect(timestamp(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(timeMarkup(null)).toBe("Never"); expect(timeMarkup(0)).toBe("Never");
    expect(timestamp(8_640_000_000_000_000)).toBe("+275760-09-13T00:00:00.000Z");
    expect(timeMarkup(8_640_000_000_000_000)).toContain('datetime="+275760-09-13T00:00:00.000Z"');
  });
  it("keeps live workspace context on task links while saved and default lists use archived links", async () => {
    const jobs = [
      { runner_id: "runner:one", job_id: "job:one" }, { job_id: "fallback-job" },
      { runner_id: "bad/runner", job_id: "unlinked-job" }, { job_id: "bad/job" }, {},
    ];
    const cases: { view?: HistoryView; query: string }[] = [
      { view: { scope: "live", limit: 10, workspace: "Project:main" }, query: "?workspace_id=Project%3Amain" },
      { view: { scope: "live", limit: 10 }, query: "?workspace_id=" },
      { view: { scope: "jobs", limit: 10, workspace: "Project:main" }, query: "" },
      { view: { scope: "all", limit: 10, workspace: "Project:main" }, query: "" },
      { query: "" },
    ];
    for (const { view, query } of cases) {
      const markup = view ? historyJobTable(jobs, "fallback-runner", view) : jobTable(jobs, "fallback-runner");
      const links: (string | null)[] = [];
      await new HTMLRewriter().on("a", { element: element => { links.push(element.getAttribute("href")); } })
        .transform(new Response(markup)).text();
      expect(links).toEqual([`/admin/runners/runner%3Aone/jobs/job%3Aone${query}`, `/admin/runners/fallback-runner/jobs/fallback-job${query}`]);
      expect(markup).toContain("unlinked-job"); expect(markup).toContain("bad/job");
    }
  });
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
    let value = render(...args);
    if (value.includes('class="product-version"')) {
      const versionMarkup = `<span class="product-version" data-no-i18n>v${PRODUCT_VERSION}</span>`;
      expect(value).toContain(versionMarkup);
      // Releases change the displayed version without changing this layout baseline.
      value = value.replace(versionMarkup, `<span class="product-version" data-no-i18n>v${fixtures.product_version}</span>`);
    }
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

  it.each(["en", "zh-CN"] as const)("keeps machine values distinct from translated Runner labels in %s", async locale => {
    for (const value of ["Source", "read", "Write", "Unknown", "<b>Source</b>"]) {
      const content = runnerDetailPage({
        presentation: { configuredMode: "dedicated_user", reportedMode: "dedicated_user", maxValidityDays: 3650, dayMs: 86400000 },
        runner: { runner_id: "Source", display_name: value, state: "online", public_info: { hostname: value, service_identity: value, platform: value, architecture: value, runner_version: value } },
        workspaces: [{ workspace_id: "read", display_name: value, root_path: "/fixture", validation_status: "valid" }],
        environment: { tools: { Source: { available: true, version: value } } }, csrf: "fixture-csrf", release: { latest_version: "0.1.7", distributable: true },
      });
      const output = await localizeHtmlResponse(new Request(`https://worker.test/admin?lang=${locale}`),
        new Response(`<html><body>${content}</body></html>`, { headers: { "content-type": "text/html" } })).text();
      const escaped = value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const field = locale === "en" ? "Hostname" : "主机名";
      expect(output).toContain(`<dt>${field}</dt>\n        <dd class="mono"><span data-no-i18n>${escaped}</span></dd>`);
      expect(output).toContain(`<li><span class="mono" data-no-i18n>read</span><span class="validation-tag`);
      expect(output).toContain('value="read"');
      expect(output).toContain('data-no-i18n placeholder="Source"');
      expect(output).toContain('<strong class="tool-name" data-no-i18n>Source</strong>');
      expect(output).toContain(`<span class="tool-version mono" data-no-i18n>${escaped}</span>`);
      expect(output).not.toContain("<b>Source</b>");
      expect(output).toContain(locale === "en" ? "online" : "在线");
    }
    const empty = runnerDetailPage({ presentation: { configuredMode: null, reportedMode: "unknown", maxValidityDays: 3650, dayMs: 86400000 },
      runner: { runner_id: "runner" }, workspaces: [], csrf: "fixture-csrf", release: { latest_version: "0.1.7", distributable: false } });
    const output = await localizeHtmlResponse(new Request(`https://worker.test/admin?lang=${locale}`),
      new Response(`<html><body>${empty}</body></html>`, { headers: { "content-type": "text/html" } })).text();
    expect(output).toContain(`<dd class="mono">${locale === "en" ? "Unknown" : "未知"}</dd>`);
    expect(output).toContain(locale === "en" ? "Not configured" : "未配置");
  });

  it.each(["en", "zh-CN"] as const)("keeps workspace deletion confirmation IDs unchanged in %s", async locale => {
    for (const workspaceId of ["Settings", "missing", "running", "work-probe", "A._:-9"]) {
      const content = managedWorkspaceForm("runner", { workspace_id: workspaceId, display_name: "Project", root_path: "/project" }, "fixture-csrf");
      const output = await localizeHtmlResponse(new Request(`https://worker.test/admin?lang=${locale}`),
        new Response(`<html><body>${content}</body></html>`, { headers: { "content-type": "text/html" } })).text();
      const confirmation = output.match(/<input name="confirmation"[^>]*>/u)?.[0];
      expect(confirmation).toContain(`data-no-i18n placeholder="${workspaceId}"`);
      expect(output).toContain(`<input type="hidden" name="workspace_id" value="${workspaceId}">`);
      expect(output).toContain(locale === "en" ? "Type Workspace ID to confirm" : "输入工作区 ID 以确认");
      expect(output).toContain(locale === "en" ? ">Delete workspace</button>" : ">删除工作区</button>");
    }
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
