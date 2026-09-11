import { describe, expect, it, vi } from "vitest";
import { adminJobUrl, loadAdminJobPage } from "../src/admin-jobs.js";

const origin = "https://worker.test";
const path = "/admin/runners/test-runner/jobs/test-job";
function fixture(state = "online") {
  const job = { runner_id: "test-runner", job_id: "test-job", workspace_id: "work", status: "succeeded", created_at_ms: 100, updated_at_ms: 200, created_by_client_id: "client-1", command: "PRIVATE_COMMAND_SENTINEL", cwd: "PRIVATE_HOST_PATH_SENTINEL" };
  const registry = vi.fn(async (url: string) => Response.json(url.endsWith("/jobs/test-job") ? job : { runner_id: "test-runner", state }));
  const logs = vi.fn(async (_params: Record<string, unknown>): Promise<Response | undefined> => Response.json({ result: { job_id: "test-job", stream: "stdout", data: '<script>not html</script> & "text"', next_cursor: "16384" } }));
  const open = (query = "") => loadAdminJobPage(new URL(origin + path + query), "test-runner", "test-job", registry, logs);
  return { job, registry, logs, open };
}

describe("on-demand administrator job detail", () => {
  it("opens persisted metadata without fetching any live logs or command details", async () => {
    const f = fixture(); const page = await f.open();
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(f.registry.mock.calls.map(([url]) => url)).toEqual(["/runners/test-runner", "/runners/test-runner/jobs/test-job"]);
    expect(f.logs).not.toHaveBeenCalled();
    expect(page.body).toContain("succeeded"); expect(page.body).toContain("No automatic polling.");
    expect(page.body).toContain("?stream=stdout"); expect(page.body).toContain("?stream=stderr");
    expect(page.body).not.toContain("PRIVATE_COMMAND_SENTINEL"); expect(page.body).not.toContain("PRIVATE_HOST_PATH_SENTINEL");
  });
  it("reads exactly one bounded stream only after selection, with workspace fencing and escaped output", async () => {
    const f = fixture(); const page = await f.open("?stream=stdout&cursor=42");
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(f.logs).toHaveBeenCalledExactlyOnceWith({ job_id: "test-job", expected_workspace_id: "work", stream: "stdout", cursor: "42", limit: 16384 });
    expect(page.body).toContain("&lt;script&gt;not html&lt;/script&gt;"); expect(page.body).not.toContain("<script>");
    expect(page.body).toContain("?stream=stdout&amp;cursor=16384");
  });
  it.each(["offline", "stale", "revoked"])("retains metadata but does not contact an %s Runner", async (state) => {
    const f = fixture(state); const page = await f.open("?stream=stdout");
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(f.logs).not.toHaveBeenCalled(); expect(page.body).toContain("succeeded"); expect(page.body).toContain("Logs are unavailable.");
  });
  it.each([403, 404, 503])("keeps metadata visible when logs return HTTP %s", async (status) => {
    const f = fixture(); f.logs.mockImplementation(async () => new Response("PRIVATE_ERROR_SENTINEL", { status }));
    const page = await f.open("?stream=stderr"); expect(page.ok).toBe(true); if (!page.ok) return;
    expect(page.body).toContain("succeeded"); expect(page.body).toContain("Logs are unavailable."); expect(page.body).not.toContain("PRIVATE_ERROR_SENTINEL");
  });
  it("tolerates a log transport failure without losing saved metadata", async () => {
    const f = fixture(); f.logs.mockRejectedValue(new Error("offline"));
    const page = await f.open("?stream=stdout"); expect(page.ok).toBe(true); if (page.ok) expect(page.body).toContain("succeeded");
  });
  it.each(["?stream=other", "?cursor=0", "?stream=stdout&cursor=-1", "?stream=stdout&cursor=1e3", "?stream=stdout&cursor=9007199254740992", "?stream=stdout&cursor=x", "?stream=stdout&stream=stderr", "?stream=stdout&cursor=1&cursor=2"])("rejects an invalid query before any data access: %s", async (query) => {
    const f = fixture(); expect(await f.open(query)).toMatchObject({ ok: false, status: 400 });
    expect(f.registry).not.toHaveBeenCalled(); expect(f.logs).not.toHaveBeenCalled();
  });
  it("does not link untrusted or non-advancing log cursors", async () => {
    for (const next_cursor of ["javascript:alert(1)", "0", "9007199254740992"]) {
      const f = fixture(); f.logs.mockResolvedValue(Response.json({ result: { job_id: "test-job", stream: "stdout", data: "x".repeat(20000), next_cursor } }));
      const page = await f.open("?stream=stdout"); expect(page.ok).toBe(true); if (!page.ok) continue;
      expect(page.body).not.toContain("Next log chunk"); expect(page.body).not.toContain("x".repeat(16385));
    }
  });
  it("fails closed for missing or malformed metadata without trying live recovery", async () => {
    const f = fixture(); f.registry.mockResolvedValue(new Response("missing", { status: 404 }));
    expect(await f.open()).toMatchObject({ ok: false, status: 404 });
    f.registry.mockResolvedValue(new Response("broken", { status: 200 }));
    expect(await f.open()).toMatchObject({ ok: false, status: 503 }); expect(f.logs).not.toHaveBeenCalled();
  });
  it("builds links only from safe Runner and job identifiers", () => {
    expect(adminJobUrl("test-runner", "test-job")).toBe(path);
    for (const id of [undefined, "../etc", "<script>", "a/b", ""]) expect(adminJobUrl("test-runner", id)).toBeUndefined();
  });
});
