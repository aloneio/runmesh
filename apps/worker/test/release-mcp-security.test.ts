import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { randomBase64Url, sha256Hex } from "../src/security.js";
const full={read:true,edit:true,shell:true,job_control:true};
async function fixture(responder?: (request: Record<string, any>) => Response | Promise<Response>) {
  const id = env.REGISTRY.idFromName(`no-record-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const secret = randomBase64Url(), verifier = await sha256Hex(secret);
  const snapshot = await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    instance.registerRunner("r", "a".repeat(64), now, undefined, "dedicated_user");
    instance.createMcpClient({ client_id: "c", label: "test", secret_verifier: verifier, secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, now);
    const raw = { schema_version: 1 as const, runner_id: "r", revision: 1, runner_permissions: full, workspaces: [{ workspace_id: "w", root_path: "/synthetic-workspace", enabled: true, permissions: full }] };
    const checksum = runnerPolicyChecksum(raw);
    state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json=?, checksum=?, status='applied' WHERE runner_id='r' AND revision=1", JSON.stringify({ ...raw, checksum }), checksum);
    state.storage.sql.exec("UPDATE runners SET state='online', current_runner_version='0.1.1', connection_epoch=1, session_id='test-record-session', last_heartbeat_ms=?, runner_permissions_json=?, desired_policy_revision=1, applied_policy_revision=1, runner_reported_policy_revision=1, desired_policy_checksum=?, active_policy_checksum=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id='r'", now, JSON.stringify(full), checksum, checksum, checksum);
    expect(instance.selectMcpClientRunner("c", "r", false, now).ok).toBe(true);
    expect(instance.setJobRecording("c", false, now)?.record_jobs).toBe(false);
    return { ok: true, revision: raw.revision, checksum };
  });
  const forwarded: Record<string, any>[] = [];
  const job = { job_id: "j", workspace_id: "w", created_by_client_id: "c", status: "running", created_at_ms: Date.now(), updated_at_ms: Date.now() };
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub }, RUNNER: { idFromName: () => id, get: () => ({ fetch: async (req: Request) => {
    const input = await req.json() as Record<string, any>; forwarded.push(input);
    if (responder !== undefined) return responder(input);
    // job.input returns a byte acknowledgement, not a JobRecord. The former
    // mock concealed an empty projected success without testing stdin data.
    const result = input.method === "job.list" ? { jobs: [job] } : input.method === "job.input" ? { accepted: new TextEncoder().encode(String(input.params.data ?? "")).byteLength, eof: input.params.eof === true } : input.method === "exec.run" ? { job, completed: false } : job;
    return Response.json({ type: "rpc.response", result });
  } }) } } as unknown as typeof env;
  async function call(name: string, args: Record<string, unknown>) {
    const response = await worker.fetch(new Request(`https://record.test/${secret}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), localEnv, {} as ExecutionContext);
    const text = await response.text(), data = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    return { status: response.status, body: response.status === 200 ? JSON.parse(data ?? text) : undefined };
  }
  return { stub, call, forwarded, job, localEnv, snapshot };
}
it("AUDIT-LIST: runner enumeration does not turn an authorization dependency outage into an empty successful list", async () => {
  const f = await fixture();
  expect((await f.call("runner_list", {})).body.result.structuredContent.runners).toHaveLength(1);
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY); let permissionReads = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname === "/auth/clients/c/effective-workspaces/r") {
      permissionReads++;
      return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    }
    return original(id).fetch(request);
  } });
  const result = (await f.call("runner_list", {})).body.result;
  console.log(JSON.stringify({ audit: "runner_list_outage", permission_reads: permissionReads, is_error: result.isError === true, structured: result.structuredContent }));
  expect(permissionReads).toBe(1);
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "registry_unavailable", operation_state: "not_started" } } });
  expect(f.forwarded).toHaveLength(0);
});

it.each(["single", "mixed"] as const)("AUDIT-LIST: runner authorization contract failure is explicit for a %s list", async layout => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  const brokenRunner = layout === "single" ? "r" : "r-broken";
  const permissionReads: string[] = [];
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/runners" && layout === "mixed") {
      const response = await original(id).fetch(request);
      const value = await response.json() as { runners: Record<string, unknown>[] };
      return Response.json({ ...value, runners: [...value.runners, { ...value.runners[0], runner_id: brokenRunner }] });
    }
    if (path === "/runners/r-broken/snapshot-authorization") return Response.json(f.snapshot);
    if (path.startsWith("/auth/clients/c/effective-workspaces/")) permissionReads.push(path);
    if (path === `/auth/clients/c/effective-workspaces/${brokenRunner}`) return Response.json({ fixture: "invalid-authorization-receipt" });
    return original(id).fetch(request);
  } });
  const result = (await f.call("runner_list", {})).body.result;
  expect(permissionReads).toEqual(layout === "single" ? ["/auth/clients/c/effective-workspaces/r"]
    : ["/auth/clients/c/effective-workspaces/r", "/auth/clients/c/effective-workspaces/r-broken"]);
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "authorization_response_invalid",
    failure_class: "internal", operation_state: "not_started", next_action: "contact_operator" } } });
  expect(result.structuredContent).not.toHaveProperty("runners");
  expect(JSON.stringify(result)).not.toContain("invalid-authorization-receipt");
  expect(f.forwarded).toHaveLength(0);
});

it.each(["denied", "pending", "missing"] as const)("AUDIT-LIST: runner authorization %s remains a hidden item", async state => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let injected = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (state === "pending" && path === "/runners/r/snapshot-authorization") {
      injected++; return Response.json({ ok: false, code: "policy_pending", reason: "policy identity is not fully applied" });
    }
    if (state !== "pending" && path === "/auth/clients/c/effective-workspaces/r") {
      injected++;
      if (state === "missing") return new Response(null, { status: 404 });
      const response = await original(id).fetch(request);
      return Response.json({ ...await response.json() as Record<string, unknown>, workspaces: [] });
    }
    return original(id).fetch(request);
  } });
  const result = (await f.call("runner_list", {})).body.result;
  expect(injected).toBe(1);
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ runners: [] });
  expect(f.forwarded).toHaveLength(0);
});

it.each(["missing", "non-array", "mixed-invalid-identity"] as const)("AUDIT-LIST: Runner catalog %s is an explicit dependency failure", async shape => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let catalogReads = 0, authorizationReads = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/snapshot-authorization") || path.includes("/effective-workspaces/")) authorizationReads++;
    if (path !== "/runners") return original(id).fetch(request);
    catalogReads++;
    if (shape === "missing") return Response.json({});
    if (shape === "non-array") return Response.json({ runners: "invalid" });
    const response = await original(id).fetch(request);
    const value = await response.json() as { runners: Record<string, unknown>[] };
    return Response.json({ ...value, runners: [...value.runners, { runner_id: "invalid runner" }] });
  } });
  const result = (await f.call("runner_list", {})).body.result;
  expect(catalogReads).toBe(1);
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "registry_unavailable", operation_state: "not_started" } } });
  expect(result.structuredContent).not.toHaveProperty("runners");
  expect(authorizationReads).toBe(0);
  expect(f.forwarded).toHaveLength(0);
});

it.each(["empty", "private-fields"] as const)("AUDIT-LIST: Runner catalog %s keeps the public projection", async shape => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let catalogReads = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname !== "/runners") return original(id).fetch(request);
    catalogReads++;
    if (shape === "empty") return Response.json({ runners: [] });
    const response = await original(id).fetch(request);
    const value = await response.json() as { runners: Record<string, unknown>[] };
    return Response.json({ ...value, fixture_private: "private-catalog-field",
      runners: value.runners.map(runner => ({ ...runner, fixture_private: "private-runner-field" })) });
  } });
  const result = (await f.call("runner_list", {})).body.result;
  expect(catalogReads).toBe(1);
  expect(result.isError).not.toBe(true);
  if (shape === "empty") expect(result.structuredContent).toEqual({ runners: [] });
  else {
    expect(result.structuredContent.runners).toHaveLength(1);
    const runner = result.structuredContent.runners[0];
    expect(runner).toMatchObject({ runner_id: "r", display_name: "r", state: "online", available: true });
    expect(Object.keys(runner).sort()).toEqual(["available", "display_name", "runner_id", "state", "updated_at_ms"]);
  }
  expect(JSON.stringify(result)).not.toContain("private-");
  expect(f.forwarded).toHaveLength(0);
});

it("AUDIT-READ: invalid Runner catalog does not become an empty automatic selection", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let catalogReads = 0, selectionPosts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/auth/clients/c/active-runner") {
      if (request.method === "GET") return Response.json({ active_runner_id: null, active_runner_updated_at_ms: null, runner: null });
      if (request.method === "POST") selectionPosts++;
    }
    if (path === "/runners") { catalogReads++; return Response.json({}); }
    return original(id).fetch(request);
  } });
  const result = (await f.call("workspace_list", {})).body.result;
  expect(catalogReads).toBe(1);
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "registry_unavailable", operation_state: "not_started" } } });
  expect(selectionPosts).toBe(0);
  expect(f.forwarded).toHaveLength(0);
});

it.each([{}, { ok: true }, { ok: false, code: "policy_pending" }])("AUDIT-LIST: snapshot authorization rejects incomplete receipt %j", async receipt => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let snapshotReads = 0, workspaceReads = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/runners/r/snapshot-authorization") { snapshotReads++; return Response.json(receipt); }
    if (path === "/auth/clients/c/effective-workspaces/r") workspaceReads++;
    return original(id).fetch(request);
  } });
  const result = (await f.call("runner_list", {})).body.result;
  expect(snapshotReads).toBe(1);
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "authorization_response_invalid", operation_state: "not_started" } } });
  expect(result.structuredContent).not.toHaveProperty("runners");
  expect(workspaceReads).toBe(0);
  expect(f.forwarded).toHaveLength(0);
});

it("AUDIT-LIST: per-Job permission outage does not erase visible snapshot jobs", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY); let snapshotReads = 0;
  const checkedWorkspaces: Array<string | null> = [];
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/runners/r/jobs") { snapshotReads++; return Response.json({ jobs: [f.job] }); }
    // Fail the permission read for a returned Job, independently of how many
    // permission observations were needed to admit the list itself.
    if (url.pathname === "/auth/clients/c/effective-permissions/r" && snapshotReads > 0) {
      checkedWorkspaces.push(url.searchParams.get("workspace_id"));
      return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    }
    return original(id).fetch(request);
  } });
  const result = (await f.call("job", { action: "list", limit: 10 })).body.result;
  console.log(JSON.stringify({ audit: "job_list_outage", snapshot_reads: snapshotReads, permission_calls: checkedWorkspaces.length, is_error: result.isError === true, structured: result.structuredContent }));
  expect(snapshotReads).toBe(1); expect(checkedWorkspaces).toEqual([f.job.workspace_id]);
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "registry_unavailable", operation_state: "not_started" } } });
  expect(f.forwarded).toHaveLength(0);
});

it("AUDIT-LIST: malformed workspace response is not a confirmed empty workspace set", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => new URL(request.url).pathname.includes("/effective-workspaces/") ? Response.json({ fixture: "missing-workspaces-field" }) : original(id).fetch(request) });
  const result = (await f.call("workspace_list", {})).body.result;
  console.log(JSON.stringify({ audit: "malformed_workspace_list", is_error: result.isError === true, structured: result.structuredContent }));
  expect(result.isError).toBe(true);
});

it("AUDIT-AUTH: a policy-readiness outage is reported as dependency unavailability rather than stale policy", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => new URL(request.url).pathname.endsWith("/policy-readiness") ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : original(id).fetch(request) });
  const result = (await f.call("shell", { workspace_id: "w", command: "synthetic-not-executed" })).body.result;
  console.log(JSON.stringify({ audit: "readiness_outage", code: result.structuredContent?.error?.code, dispatched: f.forwarded.length }));
  expect(f.forwarded).toHaveLength(0);
  expect(result.structuredContent.error.code).toBe("registry_unavailable");
});

it("AUDIT-RECEIPT: rejected execution output must not leave an audit success record", async () => {
  const f = await fixture(() => Response.json({ type: "rpc.response", result: { job: { job_id: "j", workspace_id: "w" }, completed: false } }));
  await runInDurableObject(f.stub, instance => { instance.setJobRecording("c", true, Date.now()); });
  const result = (await f.call("shell", { workspace_id: "w", command: "synthetic-not-executed" })).body.result;
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "tool_result_invalid", operation_state: "unknown" } } });
  await runInDurableObject(f.stub, (_instance, state) => {
    const rows = state.storage.sql.exec<{ call_json: string }>("SELECT call_json FROM mcp_calls").toArray().map(row => { const v=JSON.parse(row.call_json); return { status: v.status, error_code: v.error_code }; });
    console.log(JSON.stringify({ audit: "output_contract_audit", tool_error: result.structuredContent.error.code, rows }));
    expect(rows).toHaveLength(1); expect(rows[0]?.status).not.toBe("ok");
  });
  expect(f.forwarded).toHaveLength(1);
});

it("AUDIT-CONTROL: a revoked principal is rejected before dispatch", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, instance => { instance.revokeMcpClient("c", Date.now()); });
  const result = await f.call("shell", { workspace_id: "w", command: "synthetic-not-executed" });
  expect(result.status).toBe(404); expect(f.forwarded).toHaveLength(0);
});
