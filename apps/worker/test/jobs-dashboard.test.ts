import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { randomBase64Url, sha256Hex } from "../src/security.js";

async function fixture(statuses: string[] = ["succeeded"]) {
  const id = env.REGISTRY.idFromName(`jobs-ui-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const session = randomBase64Url(), csrf = randomBase64Url();
  const sessionHash = await sha256Hex(session), csrfHash = await sha256Hex(csrf);
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    expect(instance.setupAdmin("synthetic-jobs-admin-verifier", now)).toBe(true);
    expect(instance.createAdminSession(sessionHash, csrfHash, now + 60000, now, 1)).toBe(true);
    instance.registerRunner("jobs-runner", "synthetic", now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState("jobs-runner")!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = 'jobs-session', last_heartbeat_ms = ? WHERE runner_id = 'jobs-runner'", now);
    expect(instance.syncRunner("jobs-runner", fence.runner.connection_epoch, fence.runner.credential_version, [], statuses.map((status, i) => ({ runner_id: "jobs-runner", job_id: `job-${i}`, workspace_id: "work", status, created_at_ms: now - 2000, updated_at_ms: now - 1000 + i })), 0, now, true, fence.lifecycle_id, "jobs-session")).toBe(true);
  });
  const paths: string[] = []; let ready = false, unavailable = false;
  const registry = { idFromName: () => id, get: () => ({ fetch: async (request: Request) => {
    const url = new URL(request.url); paths.push(url.pathname + url.search);
    if (unavailable && (url.pathname === "/dashboard" || url.pathname.endsWith("/jobs"))) return new Response("unavailable", { status: 503 });
    if (ready && url.pathname.endsWith("/policy-readiness")) return Response.json({ ok: true, policy_status: "applied", desired_revision: 1, applied_revision: 1, runner_reported_policy_revision: 1, desired_checksum: "a".repeat(64), active_checksum: "a".repeat(64), runner_reported_policy_checksum: "a".repeat(64) });
    return stub.fetch(request);
  } }) } as unknown as typeof env.REGISTRY;
  const runnerFetch = vi.fn(async (request: Request) => {
    const body = await request.json() as { method: string; params: { job_id: string; stream: string } };
    return Response.json({ result: { job_id: body.params.job_id, stream: body.params.stream, data: "EXPLICIT_LOG_MARKER", next_cursor: null } });
  });
  const runner = { idFromName: env.RUNNER.idFromName.bind(env.RUNNER), get: () => ({ fetch: runnerFetch }) } as unknown as typeof env.RUNNER;
  const cookie = `__Host-runmesh_admin_session=${session}; __Host-runmesh_admin_csrf=${csrf}`;
  const open = (path: string, authenticated = true) => worker.fetch(new Request(`https://worker.test${path}`, { redirect: "manual", headers: authenticated ? { cookie } : {} }), { ...env, REGISTRY: registry, RUNNER: runner }, {} as ExecutionContext);
  const saveHistory = (values: Record<string,string>, validCsrf = true) => worker.fetch(new Request("https://worker.test/admin/runners/jobs-runner/history-settings",{
    method:"POST",headers:{cookie,origin:"https://worker.test","content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({csrf_token:validCsrf ? csrf : "invalid",...values}),
  }),{...env,REGISTRY:registry,RUNNER:runner},{} as ExecutionContext);
  return { open, saveHistory, stub, paths, runnerFetch, setReady: () => { ready = true; }, failSnapshot: () => { unavailable = true; } };
}

it("reads the correct dashboard response and counts active jobs outside the recent 20 records", async () => {
  const f = await fixture([...Array<string>(25).fill("running"), ...Array<string>(25).fill("succeeded")]);
  const response = await f.open("/admin?history=1"); const text = await response.text();
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(text).toContain('Active shell jobs</span><strong class="metric-value">25</strong>');
  expect(text).toContain('href="/admin/runners/jobs-runner/jobs/job-49"');
  expect(f.paths.filter((path) => path === "/dashboard")).toHaveLength(1); expect(f.paths).not.toContain("/runners");
  expect(f.runnerFetch).not.toHaveBeenCalled();
});

it("shows recent jobs of all lifecycle states instead of filtering only running", async () => {
  const statuses = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted"];
  const f = await fixture(statuses); const response = await f.open("/admin/runners/jobs-runner?history=jobs&limit=20"); const text = await response.text();
  expect(response.status).toBe(200); expect(text).toContain("<h2>Recent shell jobs</h2>");
  for (let i = 0; i < statuses.length; i++) expect(text).toContain(`href="/admin/runners/jobs-runner/jobs/job-${i}"`);
  expect(f.paths).toContain("/runners/jobs-runner/jobs?limit=20"); expect(f.paths.some((path) => path.includes("status=running"))).toBe(false);
  expect(f.runnerFetch).not.toHaveBeenCalled();
});

it("does not query job snapshots on unrelated top-level pages", async () => {
  const f = await fixture(); expect((await f.open("/admin/settings")).status).toBe(200);
  expect(f.paths).not.toContain("/dashboard"); expect(f.paths.some((path) => path.includes("/jobs"))).toBe(false); expect(f.runnerFetch).not.toHaveBeenCalled();
});

it("authenticates job pages before reading metadata or contacting the Runner", async () => {
  const f = await fixture(); const response = await f.open("/admin/runners/jobs-runner/jobs/job-0?stream=stdout", false);
  expect(response.status).toBe(303); expect(f.paths.some((path) => path.includes("/jobs"))).toBe(false); expect(f.runnerFetch).not.toHaveBeenCalled();
});

it("serves metadata without RPC, and reads a stream only with applied-policy fencing", async () => {
  const f = await fixture(); const path = "/admin/runners/jobs-runner/jobs/job-0";
  const response = await f.open(path); const text = await response.text();
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(text).toContain("<h1>Job details</h1>"); expect(text).not.toContain("EXPLICIT_LOG_MARKER"); expect(f.runnerFetch).not.toHaveBeenCalled();
  // An online Runner with unapplied permissions still cannot serve logs.
  expect((await f.open(path + "?stream=stdout")).status).toBe(200); expect(f.runnerFetch).not.toHaveBeenCalled();
  f.setReady(); const logs = await f.open(path + "?stream=stdout"); expect(await logs.text()).toContain("EXPLICIT_LOG_MARKER");
  expect(f.runnerFetch).toHaveBeenCalledTimes(1);
  // Clone before inspecting so this assertion does not depend on a consumed body.
  const requested = f.runnerFetch.mock.calls[0]![0]; expect(new URL(requested.url).pathname).toBe("/rpc");
});

it("keeps a missing snapshot distinguishable from an empty history", async () => {
  const f = await fixture(); f.failSnapshot(); const response = await f.open("/admin?history=1");
  expect(await response.text()).toContain("Job snapshot unavailable"); expect(f.runnerFetch).not.toHaveBeenCalled();
});

it("does not render an unavailable dashboard as zero active jobs or empty history", async () => {
  const f = await fixture(); f.failSnapshot(); const response = await f.open("/admin?history=1"); const text = await response.text();
  expect(text).toContain('Active shell jobs</span><strong class="metric-value">—</strong>');
  expect(text).toContain('<p class="empty">Job metadata is temporarily unavailable.</p>');
  expect(text).not.toContain('<p class="empty">No recent jobs.</p>');
});

it("keeps a failed Runner history query distinct from a successfully loaded empty list", async () => {
  const f = await fixture([]);
  const empty = await (await f.open("/admin/runners/jobs-runner?history=jobs&limit=20")).text();
  expect(empty).toContain('<p class="empty">No recent jobs.</p>');
  f.failSnapshot(); const failed = await (await f.open("/admin/runners/jobs-runner?history=jobs&limit=20")).text();
  expect(failed).toContain('<p class="empty">Job metadata is temporarily unavailable.</p>');
  expect(failed).not.toContain('<p class="empty">No recent jobs.</p>');
});

it.each(["/admin?history=1", "/admin/runners/jobs-runner?history=jobs&limit=20", "/admin/runners/jobs-runner/jobs/job-0"])("shows an explicit last-loaded timestamp on %s without polling", async (path) => {
  const f = await fixture(); const response = await f.open(path); const text = await response.text();
  expect(text).toContain('<span>Last loaded</span>');
  expect(text).toMatch(/<time datetime="[0-9]{4}-[0-9]{2}-[0-9]{2}T[^" ]+Z">/);
  expect(text).not.toContain("setInterval(");
  expect(f.runnerFetch).not.toHaveBeenCalled();
});


it("opening dashboard and Runner details performs no Job or audit reads until requested", async () => {
  const f = await fixture();
  for (const path of ["/admin","/admin/runners/jobs-runner"]) {
    f.paths.length=0;
    const response = await f.open(path), body=await response.text();
    expect(response.status).toBe(200);
    expect(f.paths.some((p) => p === "/dashboard" || /\/(jobs|mcp-calls)(?:\?|$)/.test(p))).toBe(false);
    if (path === "/admin") {
      expect(body).toContain('href="/admin?history=1"');
      expect(body).toContain('Your AI connections');
      expect(body).not.toContain('Active shell jobs');
    } else expect(body).toContain("Jobs not loaded.");
  }
});

it("manual history requests honor the selected count and do not load other history", async () => {
  const f = await fixture(Array(60).fill("succeeded"));
  for (const limit of [10,20,50,100]) {
    f.paths.length=0;
    const response = await f.open(`/admin/runners/jobs-runner?history=jobs&limit=${limit}`);
    expect(response.status).toBe(200);
    expect(f.paths).toContain(`/runners/jobs-runner/jobs?limit=${limit}`);
    expect(f.paths.some((p) => p.includes("/mcp-calls"))).toBe(false);
  }
});

it.each(["limit=10000&history=jobs","limit=-1&history=jobs","history=jobs&history=all","history=live"])("rejects invalid history query without history reads: %s", async (query) => {
  const f=await fixture();
  expect((await f.open(`/admin/runners/jobs-runner?${query}`)).status).toBe(400);
  expect(f.paths.some((p) => /\/(jobs|mcp-calls)(?:\?|$)/.test(p))).toBe(false);
});


it("retention settings require CSRF and local deletion requires a separate confirmation",async()=>{
  const f=await fixture();
  const values={mode:"batched",interval_seconds:"300",retention_days:"3",local_retention_days:"1"};
  expect((await f.saveHistory({...values,confirm_local_cleanup:"true"},false)).status).toBe(403);
  expect((await f.saveHistory(values)).status).toBe(400);
  expect((await f.saveHistory({...values,confirm_local_cleanup:"true"})).status).toBe(303);
  await runInDurableObject(f.stub,instance=>{
    expect(instance.jobHistorySettings("jobs-runner")).toEqual({mode:"batched",interval_seconds:300,retention_days:3,local_retention_days:1});
  });
  expect((await f.saveHistory({...values,local_retention_days:"0",retention_days:"999"})).status).toBe(400);
  expect(f.runnerFetch).not.toHaveBeenCalled();
});
