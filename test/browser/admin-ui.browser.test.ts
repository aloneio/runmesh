import { afterAll, beforeAll, it } from "vitest";
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
