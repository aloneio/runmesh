import { expect, it } from "vitest";
import { clientDetailPage, clientsPage } from "../src/admin/client-views.js";
import { clientList, statusBadge } from "../src/admin/tables.js";
import { localizeHtmlResponse } from "../src/ui-locale.js";
import type { ClientViewModel } from "../src/contracts/admin-views.js";

for (const revoked of [false, true]) for (const locale of ["en", "zh-CN"]) {
  it("describes client credential validity across views: " + locale + ", revoked=" + revoked, async () => {
    const client: ClientViewModel = { client_id: "client-presence", label: "Synthetic client", scopes: ["coding:read"],
      revoked_at_ms: revoked ? 1 : null, last_used_at_ms: null, active_runner_id: null };
    const expected = locale === "en" ? (revoked ? "Credential revoked" : "Credential valid") : (revoked ? "凭据已撤销" : "凭据有效");
    const pages = [clientList([client]),
      clientsPage({ clients: [client], runners: [], jobs: [], snapshot: {}, notices: [] }, "synthetic-csrf"),
      clientDetailPage({ ...client }, [], [], "synthetic-csrf")];
    for (const [index, page] of pages.entries()) {
      const response = localizeHtmlResponse(new Request("https://worker.test/admin?lang=" + locale), new Response('<html lang="en"><body>' + page + '</body></html>', { headers: { "content-type": "text/html; charset=utf-8" } }));
      const html = await response.text();
      const compactExpected = locale === "en" ? (revoked ? "Revoked" : "Valid") : (revoked ? "已撤销" : "有效");
      expect(html).toContain(index === 1 ? compactExpected : expected);
      if (index === 1) {
        expect(html).toContain('credential-badge');
        expect(html).not.toContain(expected);
      }
      expect(html).not.toMatch(/>\s*(online|offline|在线|离线)\s*</u);
    }
    const explanation = locale === "en" ? "Credential validity does not indicate a connected client or an online Runner." : "凭据有效不代表客户端已连接，也不代表 Runner 在线。";
    for (const page of pages.slice(1)) {
      const response = localizeHtmlResponse(new Request("https://worker.test/admin?lang=" + locale), new Response('<html lang="en"><body>' + page + '</body></html>', { headers: { "content-type": "text/html; charset=utf-8" } }));
      expect(await response.text()).not.toContain(explanation);
    }
  });
}

for (const locale of ["en", "zh-CN"]) it("renders client dates and UTC times separately with the precise timestamp retained: " + locale, async () => {
  const iso = "2026-09-20T02:30:26.946Z";
  const clients: ClientViewModel[] = [Date.parse(iso), null, 0].map((last_used_at_ms, index) => ({
    client_id: "client-time-" + index, label: "Client " + index, scopes: [], revoked_at_ms: null, last_used_at_ms, active_runner_id: null,
  }));
  const page = clientsPage({ clients, runners: [], jobs: [], snapshot: {}, notices: [] }, "synthetic-csrf");
  const response = localizeHtmlResponse(new Request("https://worker.test/admin/clients?lang=" + locale), new Response('<html><body>' + page + '</body></html>', { headers: { "content-type": "text/html" } }));
  const html = await response.text();
  expect(html).toContain(`<time class="timestamp" datetime="${iso}" title="${iso}" data-no-i18n><span>2026-09-20 </span><span>02:30:26 UTC</span></time>`);
  expect(html.match(/<time\b/g)).toHaveLength(1);
  // Check the timestamp value independently of decorative mobile headings.
  const values = await new HTMLRewriter().on('[aria-hidden="true"]', { element(element) { element.remove(); } }).transform(new Response(html)).text();
  expect(values.match(new RegExp('<td class="time-cell">' + (locale === "en" ? "Never" : "从未") + '</td>', 'g'))).toHaveLength(2);
  expect(clients[0]!.last_used_at_ms).toBe(Date.parse(iso));
});

it("retains genuine Runner connection status badges", () => {
  expect(statusBadge("online")).toContain(">online</span>");
  expect(statusBadge("offline")).toContain(">offline</span>");
  expect(statusBadge("stale")).toContain(">stale</span>");
});
