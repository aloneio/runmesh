import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleBrowserRunnerAction } from "../src/http/runner-actions.js";
import { resolveExactRunnerRelease } from "../src/distribution/exact-release.js";
import { resolveRunnerReleaseDescriptor } from "../src/distribution/release.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { runnerDetailPage } from "../src/admin/runner-detail-view.js";
import { localizeHtmlResponse } from "../src/i18n/html.js";
import { DevelopmentReleaseError } from "../src/distribution/release-io.js";

vi.mock("../src/distribution/exact-release.js", () => ({ resolveExactRunnerRelease: vi.fn() }));
vi.mock("../src/distribution/release.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/distribution/release.js")>(), resolveRunnerReleaseDescriptor: vi.fn() }));

beforeEach(() => {
  vi.mocked(resolveExactRunnerRelease).mockReset().mockImplementation(async version => ({ package_version: version, manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64) }) as Awaited<ReturnType<typeof resolveExactRunnerRelease>>);
  vi.mocked(resolveRunnerReleaseDescriptor).mockReset().mockResolvedValue({ distributable: true, package_version: "0.1.7-dev.42" } as Awaited<ReturnType<typeof resolveRunnerReleaseDescriptor>>);
});
afterEach(() => vi.restoreAllMocks());
function fixture(runnerId = "runner:test") {
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "GET") return Response.json({ runner: { runner_id: runnerId, configured_execution_mode: "dedicated_user" }, lifecycle_id: "lifecycle-1" });
    writes.push({ path: url.pathname, input: await request.json() as Record<string, unknown> });
    expect(url.searchParams.get("admin_session")).toBe("a".repeat(64));
    return Response.json({ operation: { state: "queued" } });
  };
  const localEnv = { ...env, adminSessionHash: "a".repeat(64), REGISTRY: { idFromName: env.REGISTRY.idFromName.bind(env.REGISTRY), get: () => ({ fetch }) } } as unknown as WorkerEnv;
  const form = new FormData(); form.set("operation_id", "operation-1"); form.set("update_channel", "pinned"); form.set("desired_runner_version", "0.1.7-dev.21");
  return { localEnv, writes, form, runnerId };
}
it.each(["runner-test", "runner:test"])("queues a verified exact version with immutable digests for %s", async runnerId => {
  const f = fixture(runnerId);
  const response = await handleBrowserRunnerAction(f.localEnv, f.form, "https://worker.test", runnerId, "version-policy");
  expect(response.status).toBe(303);
  expect(resolveExactRunnerRelease).toHaveBeenCalledWith("0.1.7-dev.21");
  expect(f.writes).toEqual([{ path: `/auth/runners/${encodeURIComponent(runnerId)}/update`, input: { operation_id: "operation-1", expected_lifecycle_id: "lifecycle-1", update_channel: "pinned", target_version: "0.1.7-dev.21", target_channel: "dev", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64) } }]);
});
it("resolves the current environment before freezing its latest version", async () => {
  const f = fixture(); f.form.set("update_channel", "stable");
  expect((await handleBrowserRunnerAction(f.localEnv, f.form, "https://worker.test", f.runnerId, "version-policy")).status).toBe(303);
  expect(resolveRunnerReleaseDescriptor).toHaveBeenCalled(); expect(resolveExactRunnerRelease).toHaveBeenCalledWith("0.1.7-dev.42");
  expect(f.writes[0]?.input.target_version).toBe("0.1.7-dev.42");
});
it("does not create an operation when exact release verification fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = fixture(); vi.mocked(resolveExactRunnerRelease).mockRejectedValue(new Error("PRIVATE_RELEASE_ERROR"));
  const response = await handleBrowserRunnerAction(f.localEnv, f.form, "https://worker.test", f.runnerId, "version-policy");
  expect(response.status).toBe(503); expect(f.writes).toEqual([]); expect(await response.text()).not.toContain("PRIVATE_RELEASE_ERROR");
  expect(warn).toHaveBeenCalledExactlyOnceWith({ event: "runner_update_release_verification_failed", phase: "verification", reason: "unexpected" });
});
it("logs fixed release failure diagnostics without exception details or creating an operation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = fixture();
  vi.mocked(resolveExactRunnerRelease).mockRejectedValue(new DevelopmentReleaseError("PRIVATE_RELEASE_URL_AND_TOKEN", { phase: "signature", reason: "http_error", http_status: 403 }));
  const response = await handleBrowserRunnerAction(f.localEnv, f.form, "https://worker.test", f.runnerId, "version-policy");
  expect(response.status).toBe(503); expect(f.writes).toEqual([]); expect(await response.text()).not.toContain("PRIVATE_RELEASE_URL_AND_TOKEN");
  expect(warn).toHaveBeenCalledExactlyOnceWith({ event: "runner_update_release_verification_failed", phase: "signature", reason: "http_error", http_status: 403 });
});
it.each(["../other", "https://example.test/version", "1.2.3-beta.1"])("rejects unsupported version input %s before fetching or writing", async version => {
  const f = fixture(); f.form.set("desired_runner_version", version);
  expect((await handleBrowserRunnerAction(f.localEnv, f.form, "https://worker.test", f.runnerId, "version-policy")).status).toBe(400);
  expect(resolveExactRunnerRelease).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
});
it("presents operation progress and recovery in English and Chinese", async () => {
  const operation = { operation_id: "operation-1", lifecycle_id: "lifecycle-1", target_version: "0.1.7-dev.21", target_channel: "dev", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: "0.1.7", manager_id: "manager-1", state: "rolled_back", error_code: "activation_failed", created_at_ms: 1, updated_at_ms: 2 };
  const content = runnerDetailPage({ presentation: { configuredMode: "dedicated_user", reportedMode: "unknown", maxValidityDays: 365, dayMs: 86400000 }, runner: { runner_id: "runner-test", update_operation: operation, update_request_id: "next-operation" }, workspaces: [], csrf: "csrf", release: { latest_version: "0.1.7-dev.21", distributable: true } });
  for (const locale of ["en", "zh-CN"] as const) {
    const html = await localizeHtmlResponse(new Request(`https://worker.test/admin/runners/runner-test?lang=${locale}`), new Response(`<html><body>${content}</body></html>`, { headers: { "content-type": "text/html" } })).text();
    expect(html).toContain(locale === "en" ? "Previous version restored" : "已恢复原版本");
    expect(html).toContain(locale === "en" ? "Request version change" : "请求切换版本");
    expect(html).toContain(locale === "en" ? "Runner version" : "Runner 版本");
    expect(html).toContain(locale === "en" ? "Choose the latest release for this environment or enter an exact version." : "选择当前环境的最新版本，或输入精确版本号。");
    expect(html).toContain('name="operation_id" value="next-operation"');
    expect(html).not.toContain("activation_failed");
  }
});
