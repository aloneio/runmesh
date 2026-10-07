import { afterAll, beforeAll, expect, it } from "vitest";
import { createBrowserWorkerFixture } from "../../scripts/browser-worker-fixture.mjs";
import { checkUiWithChromium } from "../../scripts/ui-browser-check.mjs";

let fixture: Awaited<ReturnType<typeof createBrowserWorkerFixture>> | undefined;
beforeAll(async () => { fixture = await createBrowserWorkerFixture(); }, 90_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

it("renders stable single-locale dashboard and navigation in Chromium", async () => {
  if (fixture === undefined) throw new Error("Browser Worker fixture did not initialize");
  await checkUiWithChromium(fixture.origin, fixture.cookies, undefined);
  fixture.assertRunning();
}, 45_000);

it.each(["en", "zh-CN"] as const)("localizes the new central forms through the real Worker response (%s)", async locale => {
  if (fixture === undefined) throw new Error("Browser Worker fixture did not initialize");
  const response = await fetch(fixture.origin + "/admin/central?lang=" + locale, {
    headers: { cookie: fixture.cookies }, redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-language")).toBe(locale);
  const html = await response.text(), chinese = locale === "zh-CN";
  expect(html.includes('<html lang="' + locale + '">')).toBe(true);
  for (const label of chinese
    ? ["<summary>从 GitHub 导入</summary>", "<summary>导入 server.json</summary>", "GitHub 仓库<input", "提交 SHA<input", "Skill 文件夹路径（可选）<input"]
    : ["<summary>Import from GitHub</summary>", "<summary>Import server.json</summary>", "GitHub repository<input", "Commit SHA<input", "Skill folder path (optional)<input"])
    expect(html.includes(label), "Missing localized central label: " + label).toBe(true);
  const check = /<button\b[^>]*data-service-check[^>]*>([^<]*)<\/button>/u.exec(html)?.[1];
  expect(check).toBe(chinese ? "检查连接" : "Check connection");
  fixture.assertRunning();
});
