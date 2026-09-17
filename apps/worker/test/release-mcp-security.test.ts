import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { randomBase64Url, sha256Hex } from "../src/security.js";
const full={read:true,edit:true,shell:true,job_control:true};
async function fixture(responder?: (request: Record<string, any>) => Response | Promise<Response>) {
  const id = env.REGISTRY.idFromName(`no-record-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const secret = randomBase64Url(), verifier = await sha256Hex(secret);
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    instance.registerRunner("r", "a".repeat(64), now, undefined, "dedicated_user");
    instance.createMcpClient({ client_id: "c", label: "test", secret_verifier: verifier, secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, now);
    const raw = { schema_version: 1 as const, runner_id: "r", revision: 1, runner_permissions: full, workspaces: [{ workspace_id: "w", root_path: "/synthetic-workspace", enabled: true, permissions: full }] };
    const checksum = runnerPolicyChecksum(raw);
    state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json=?, checksum=?, status='applied' WHERE runner_id='r' AND revision=1", JSON.stringify({ ...raw, checksum }), checksum);
    state.storage.sql.exec("UPDATE runners SET state='online', current_runner_version='0.1.1', connection_epoch=1, session_id='test-record-session', last_heartbeat_ms=?, runner_permissions_json=?, desired_policy_revision=1, applied_policy_revision=1, runner_reported_policy_revision=1, desired_policy_checksum=?, active_policy_checksum=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id='r'", now, JSON.stringify(full), checksum, checksum, checksum);
    expect(instance.selectMcpClientRunner("c", "r", false, now).ok).toBe(true);
    expect(instance.setJobRecording("c", false, now)?.record_jobs).toBe(false);
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
  return { stub, call, forwarded, job, localEnv };
}
it("AUDIT-LIST: runner enumeration does not turn an authorization dependency outage into an empty successful list", async () => {
  const f = await fixture();
  expect((await f.call("runner_list", {})).body.result.structuredContent.runners).toHaveLength(1);
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => new URL(request.url).pathname.includes("/effective-permissions/") ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : original(id).fetch(request) });
  const result = (await f.call("runner_list", {})).body.result;
  console.log(JSON.stringify({ audit: "runner_list_outage", is_error: result.isError === true, structured: result.structuredContent }));
  expect(result.isError).toBe(true);
});

it("AUDIT-LIST: per-Job permission outage does not erase visible snapshot jobs", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY); let permissions = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/runners/r/jobs") return Response.json({ jobs: [f.job] });
    if (path.includes("/effective-permissions/") && ++permissions >= 2) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    return original(id).fetch(request);
  } });
  const result = (await f.call("job", { action: "list", limit: 10 })).body.result;
  console.log(JSON.stringify({ audit: "job_list_outage", permission_calls: permissions, is_error: result.isError === true, structured: result.structuredContent }));
  expect(permissions).toBe(2); expect(result.isError).toBe(true);
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
