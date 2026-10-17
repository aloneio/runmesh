import { afterAll, beforeAll, expect, it } from "vitest";
import { createBrowserWorkerFixture } from "../../scripts/browser-worker-fixture.mjs";
import { checkUiWithChromium } from "../../scripts/ui-browser-check.mjs";
import { chromium } from "playwright";

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
    ? ["<summary>从 GitHub 导入</summary>", "<summary>导入 MCP JSON 配置</summary>", "GitHub 仓库<input", "提交 SHA<input", "Skill 文件夹路径（可选）<input"]
    : ["<summary>Import from GitHub</summary>", "<summary>Import MCP JSON configuration</summary>", "GitHub repository<input", "Commit SHA<input", "Skill folder path (optional)<input"])
    expect(html.includes(label), "Missing localized central label: " + label).toBe(true);
  const check = /<button\b[^>]*data-service-check[^>]*>([^<]*)<\/button>/u.exec(html)?.[1];
  expect(check).toBe(chinese ? "检查连接" : "Check connection");
  fixture.assertRunning();
});

it.each(["dedicated_user", "privileged_host"] as const)("keeps the one-time %s enrollment result while switching languages in Chromium", async mode => {
  if (fixture === undefined) throw new Error("Browser Worker fixture did not initialize");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.RUNMESH_CHROMIUM_EXECUTABLE ?? chromium.executablePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    // Match the existing loopback fixture contract, including the explicit
    // root path required by __Host cookies, without Playwright rewriting it.
    await session.send("Network.setCookies", { cookies: fixture.cookies.split(";").map(part => {
      const at = part.indexOf("=");
      return { name: part.slice(0, at).trim(), value: part.slice(at + 1), url: fixture!.origin, path: "/", secure: true, httpOnly: false, sameSite: "Lax" as const };
    }) });
    await session.detach();
    // Observe what the real copy handler sends without using a host clipboard.
    await page.addInitScript(() => {
      const values: string[] = [];
      Object.defineProperty(window, "enrollmentCopiedValues", { value: values });
      Object.defineProperty(navigator, "clipboard", { value: { async writeText(value: string) { values.push(value); } } });
    });
    await page.goto(fixture.origin + "/admin/runners?lang=en");
    const create = page.locator("#add-runner form");
    await create.locator('input[name="display_name"]').fill("Local language fixture");
    await create.locator('input[name="runner_id"]').fill("locale-browser-" + mode);
    await create.locator(`input[name="execution_mode"][value="${mode}"]`).check();
    if (mode === "privileged_host") await create.locator('input[name="confirm_privileged_host"]').check();
    await Promise.all([page.waitForNavigation(), create.locator("button").click()]);

    const requests: string[] = [];
    page.on("request", request => { if (request.isNavigationRequest() || ["fetch", "xhr"].includes(request.resourceType())) requests.push(request.method()); });
    for (const result of ["created", "regenerated"]) {
      await page.waitForSelector("#main-content[data-local-locale]");
      expect(await page.locator("[data-enrollment-code]").count()).toBe(1);
      const code = await page.locator("[data-enrollment-code]").textContent();
      expect(/^[A-Za-z0-9_-]{43}$/u.test(code ?? "")).toBe(true);
      const commands = await page.locator("pre code").allTextContents();
      const url = page.url();
      await page.locator('[data-tab="windows"]').click();
      await page.locator('input[name="code_valid_days"]').fill("3");
      await page.locator(".runner-removal-commands summary").click();
      requests.length = 0;
      for (const locale of ["zh-CN", "en", "zh-CN"]) {
        await page.locator(`[data-lang-toggle="${locale}"]`).click();
        expect(await page.locator("html").getAttribute("lang")).toBe(locale);
        expect(await page.locator("#enrollment-title").textContent()).toBe(locale === "en" ? "Enroll Runner" : "注册 Runner");
        expect(page.url()).toBe(url);
        expect((await page.locator("[data-enrollment-code]").textContent()) === code).toBe(true);
        expect(JSON.stringify(await page.locator("pre code").allTextContents()) === JSON.stringify(commands)).toBe(true);
        expect(await page.locator('[data-tab="windows"]').getAttribute("aria-selected")).toBe("true");
        expect(await page.locator('input[name="code_valid_days"]').inputValue()).toBe("3");
        expect(await page.locator('input[name="expected_execution_mode"]').inputValue()).toBe(mode);
        expect(await page.locator(".runner-removal-commands").getAttribute("open")).not.toBeNull();
        const install = page.locator('#panel-windows [data-copy-source="command"]');
        await install.click();
        expect(await install.textContent()).toBe(locale === "en" ? "Copied" : "已复制");
        await page.locator(".runner-removal-commands [data-copy]").last().click();
        expect(await page.evaluate(() => {
          const copied = (window as unknown as { enrollmentCopiedValues: string[] }).enrollmentCopiedValues;
          const install = document.querySelector("#panel-windows pre code")?.textContent;
          const uninstall = document.querySelectorAll(".runner-removal-commands pre code")[1]?.textContent;
          return copied.at(-2) === install && copied.at(-1) === uninstall;
        })).toBe(true);
        expect(requests).toEqual([]);
      }
      if (result === "created") await Promise.all([page.waitForNavigation(), page.locator('.dialog-actions form button').click()]);
    }
    await page.locator('.dialog-actions > a[href="/admin/runners"]').click();
    await page.waitForSelector("#add-runner");
    expect(await page.locator("html").getAttribute("lang")).toBe("zh-CN");
    expect(await page.locator("#main-content[data-local-locale]").count()).toBe(0);
    await Promise.all([page.waitForNavigation(), page.locator('[data-lang-toggle="en"]').click()]);
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    fixture.assertRunning();
  } finally { await browser.close(); }
}, 60_000);
