import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { randomBase64Url, sha256Hex } from "../src/security.js";
const full = { read: true, edit: true, shell: true, job_control: true };
const ro = { read: true, edit: false, shell: false, job_control: false };
async function fixture() {
  const id = env.REGISTRY.idFromName(`permission-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const secret = randomBase64Url(), verifier = await sha256Hex(secret);
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    instance.registerRunner("r", "a".repeat(64), now, undefined, "dedicated_user");
    instance.createMcpClient({ client_id: "c", label: "synthetic client", secret_verifier: verifier, secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, now);
    const raw = { schema_version: 1 as const, runner_id: "r", revision: 1, runner_permissions: full, workspaces: [{ workspace_id: "w", root_path: "/synthetic-workspace", enabled: true, permissions: full }] };
    const checksum = runnerPolicyChecksum(raw);
    state.storage.sql.exec("UPDATE runner_policy_versions SET policy_json=?, checksum=?, status='applied' WHERE runner_id='r' AND revision=1", JSON.stringify({ ...raw, checksum }), checksum);
    state.storage.sql.exec("UPDATE runners SET state='online', token_verifier=?, connection_epoch=1, session_id='permission-session', last_heartbeat_ms=?, runner_permissions_json=?, desired_policy_revision=1, applied_policy_revision=1, runner_reported_policy_revision=1, desired_policy_checksum=?, active_policy_checksum=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id='r'", "a".repeat(64), now, JSON.stringify(full), checksum, checksum, checksum);
    expect(instance.selectMcpClientRunner("c", "r", false, now).ok).toBe(true);
    expect(instance.effectivePermissions("c", "r", "w")).toEqual(full);
  });
  let forwarded = 0, afterRegistry: ((path: string) => Promise<void>) | undefined;
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => ({ fetch: async (req: Request) => { const response = await stub.fetch(req); await afterRegistry?.(new URL(req.url).pathname); return response; } }) }, RUNNER: { idFromName: () => id, get: () => ({ fetch: async () => { forwarded++; return Response.json({ type: "rpc.response", result: { workspace_id: "w", path: "x.txt", data: "sentinel", encoding: "utf-8", offset: 0, next_cursor: null, truncated: false, size: 8 } }); } }) } } as unknown as typeof env;
  async function call(name: string, args: Record<string, unknown>) {
    const response = await worker.fetch(new Request(`https://permission.test/${secret}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), localEnv, {} as ExecutionContext);
    const text = await response.text(), data = text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    return { status: response.status, body: response.status === 200 ? JSON.parse(data ?? text) : undefined };
  }
  return { stub, call, forwarded: () => forwarded, hook: (value: typeof afterRegistry) => { afterRegistry = value; } };
}
it("AUTH-01 revoked clients lose effective permissions", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance) => { instance.revokeMcpClient("c", Date.now()); expect(instance.effectivePermissions("c", "r", "w")).toBeUndefined(); });
});
it("AUTH-02 malformed stored override fails closed", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance, state) => {
    instance.setClientRunnerOverride("c", "r", ro, Date.now());
    state.storage.sql.exec("UPDATE client_runner_overrides SET permissions_json='broken-json' WHERE client_id='c' AND runner_id='r'");
    expect(instance.effectivePermissions("c", "r", "w")?.edit).not.toBe(true);
  });
});
it("AUTH-03 workspace_list reports effective client permissions", async () => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance) => { instance.setClientRunnerOverride("c", "r", ro, Date.now()); });
  const result = await f.call("workspace_list", {});
  expect(result.status).toBe(200); expect(result.body.result.isError).not.toBe(true);
  expect(result.body.result.structuredContent.workspaces[0].permissions).toEqual(ro);
});
it.each(["revoke", "rotate"])("AUTH-04 %s after initial URL auth blocks late dispatch", async (action) => {
  const f = await fixture(); let triggered = false;
  f.hook(async (path) => { if (path !== "/auth/mcp/verify" || triggered) return; triggered = true;
    await runInDurableObject(f.stub, (instance) => { if (action === "revoke") instance.revokeMcpClient("c", Date.now()); else instance.rotateMcpClient("c", "b".repeat(64), "next", Date.now()); });
  });
  const result = await f.call("read", { workspace_id: "w", path: "x.txt" });
  expect(triggered).toBe(true); expect(f.forwarded()).toBe(0);
  expect(result.status !== 200 || result.body.result.isError === true).toBe(true);
});
it("AUTH-05 override revoked after preflight cannot dispatch", async () => {
  const f = await fixture(); let triggered = false;
  f.hook(async (path) => { if (!path.endsWith("/policy-readiness") || triggered) return; triggered = true;
    await runInDurableObject(f.stub, (instance) => { instance.setClientRunnerOverride("c", "r", { read: false, edit: false, shell: false, job_control: false }, Date.now()); });
  });
  const result = await f.call("read", { workspace_id: "w", path: "x.txt" });
  expect(triggered).toBe(true); expect(f.forwarded()).toBe(0); expect(result.body.result.isError).toBe(true);
});

it("AUTH-06 allowed calls succeed while independent tool scopes remain enforced", async () => {
  const f = await fixture();
  expect((await f.call("read", { workspace_id: "w", path: "x.txt" })).body.result.isError).not.toBe(true);
  expect(f.forwarded()).toBe(1);
  await runInDurableObject(f.stub, (instance) => { instance.updateMcpClientScopes("c", ["coding:read", "coding:exec"], Date.now()); });
  expect((await f.call("edit", { workspace_id: "w", patch: "*** Begin Patch\n*** Add File: x\n+x\n*** End Patch" })).body.result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });
  expect(f.forwarded()).toBe(1);
});
it("AUTH-07 scope removed during readiness cannot inherit the exec ceiling", async () => {
  const f = await fixture(); let changed = false;
  f.hook(async (path) => { if (!path.endsWith("/policy-readiness") || changed) return; changed = true;
    await runInDurableObject(f.stub, (instance) => { instance.updateMcpClientScopes("c", ["coding:read", "coding:exec"], Date.now()); });
  });
  expect((await f.call("edit", { workspace_id: "w", patch: "*** Begin Patch\n*** Add File: x\n+x\n*** End Patch" })).body.result.isError).toBe(true);
  expect(changed).toBe(true); expect(f.forwarded()).toBe(0);
});
it.each(["{}", "null", "[]", '{"read":true,"edit":"true","shell":true,"job_control":true}'])("AUTH-09 malformed stored permission rule %s fails closed", async (json) => {
  const f = await fixture();
  await runInDurableObject(f.stub, (instance, state) => {
    instance.setClientRunnerOverride("c", "r", full, Date.now());
    state.storage.sql.exec("UPDATE client_runner_overrides SET permissions_json=? WHERE client_id='c' AND runner_id='r'", json);
    expect(instance.effectivePermissions("c", "r", "w")).toEqual({ read: false, edit: false, shell: false, job_control: false });
  });
});
