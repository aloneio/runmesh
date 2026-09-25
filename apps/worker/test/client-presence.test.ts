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
    for (const page of pages) {
      const response = localizeHtmlResponse(new Request("https://worker.test/admin?lang=" + locale), new Response('<html lang="en"><body>' + page + '</body></html>', { headers: { "content-type": "text/html; charset=utf-8" } }));
      const html = await response.text();
      expect(html).toContain(expected);
      expect(html).not.toMatch(/>\s*(online|offline|在线|离线)\s*</u);
    }
    const explanation = locale === "en" ? "Credential validity does not indicate a connected client or an online Runner." : "凭据有效不代表客户端已连接，也不代表 Runner 在线。";
    for (const page of pages.slice(1)) {
      const response = localizeHtmlResponse(new Request("https://worker.test/admin?lang=" + locale), new Response('<html lang="en"><body>' + page + '</body></html>', { headers: { "content-type": "text/html; charset=utf-8" } }));
      expect(await response.text()).toContain(explanation);
    }
  });
}

it("retains genuine Runner connection status badges", () => {
  expect(statusBadge("online")).toContain(">online</span>");
  expect(statusBadge("offline")).toContain(">offline</span>");
  expect(statusBadge("stale")).toContain(">stale</span>");
});
