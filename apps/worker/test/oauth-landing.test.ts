import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { oauthLanding } from "../src/http/oauth-landing.js";

it.each(["en", "zh-CN"] as const)("OAuth callback uses the shared layout and a single localized state (%s)", async locale => {
  const response = oauthLanding(locale), page = await response.text();
  expect(response.headers.get("content-language")).toBe(locale);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page).toContain('class="app-header"');
  expect(page).toContain('class="auth-card secret-card"');
  expect(page).toContain('name="viewport" content="width=device-width,initial-scale=1"');
  expect(page).toContain('role="status" aria-live="polite"');
  expect(page).toContain(locale === "en" ? '>Connecting MCP</h1>' : '>正在连接 MCP</h1>');
  expect(page).toContain(locale === "en" ? '>Back to MCP &amp; Skill</a>' : '>返回 MCP 和 Skill</a>');
  expect(page).not.toContain("do not replay");
  expect(page).not.toContain(" / 正在");
  const nonce = /<script nonce="([a-f0-9]{32})">/u.exec(page)?.[1];
  expect(nonce).toBeTruthy(); expect(page.match(/<script /gu)).toHaveLength(1);
  const policy = response.headers.get("content-security-policy")!;
  expect(policy.split(";").find(part => part.trim().startsWith("script-src"))?.trim()).toBe(`script-src 'nonce-${nonce}'`);
  expect(page).toContain("history.replaceState");
  expect(page).toContain("signal:AbortSignal.timeout(25000)");
});

it("cross-site OAuth callback localizes without reflecting authorization parameters", async () => {
  const response = await SELF.fetch("https://worker.test/admin/central/connections/callback?code=private-fixture-code&state=private-fixture-state", { headers: { "accept-language": "zh-CN" } });
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain('lang="zh-CN"'); expect(page).toContain("正在连接 MCP");
  expect(page).toContain('aria-label="主导航"'); expect(page).toContain('>仪表盘</a>');
  expect(page).not.toContain("private-fixture-code"); expect(page).not.toContain("private-fixture-state");
});
