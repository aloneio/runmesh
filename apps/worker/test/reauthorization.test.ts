import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { randomBase64Url, sha256Hex } from "../src/security.js";

/** Initial URL authentication uses a real isolated Registry. Only the later
 * authorization request is faulted; no production state is touched. */
async function fixture() {
  const id = env.REGISTRY.idFromName(`reauth-${crypto.randomUUID()}`), stub = env.REGISTRY.get(id);
  const secret = randomBase64Url(), verifier = await sha256Hex(secret);
  await runInDurableObject(stub, instance => {
    instance.createMcpClient({ client_id: "c", label: "reauth", secret_verifier: verifier, secret_prefix: "test", scopes: ["coding:read", "coding:write", "coding:exec"] }, Date.now());
  });
  let fault: (() => Response | Promise<Response>) | undefined;
  let beforeSelection: ((request: Request) => Promise<void>) | undefined;
  let revalidations = 0, forwarded = 0;
  const input = { ...env, REGISTRY: { idFromName: () => id, get: () => ({ fetch: async (request: Request) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/auth/clients/c/active-runner") await beforeSelection?.(request);
    if (new URL(request.url).pathname === "/auth/mcp/revalidate") {
      revalidations++; if (fault) return fault();
    }
    return stub.fetch(request);
  } }) }, RUNNER: { idFromName: () => id, get: () => ({ fetch: () => { forwarded++; throw new Error("must not dispatch"); } }) } } as unknown as typeof env;
  async function call(name = "shell", args: Record<string, unknown> = { workspace_id: "w", command: "never execute" }) {
    const response = await worker.fetch(new Request(`https://reauth.test/${secret}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), input, {} as ExecutionContext);
    expect(response.status).toBe(200);
    const text = await response.text(), data = text.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim();
    return JSON.parse(data ?? text).result;
  }
  return { stub, call, setFault(value: typeof fault) { fault = value; }, beforeSelection(value: typeof beforeSelection) { beforeSelection = value; }, counts: () => ({ revalidations, forwarded }) };
}

it.each([429, 500, 502, 503, 504])("AR02 revalidation HTTP %s is unavailable, never credential revocation", async status => {
  const f = await fixture(); f.setFault(() => new Response("private secret URL /host/path", { status }));
  const result = await f.call();
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "registry_unavailable", failure_class: "availability", operation_state: "not_started", next_action: "wait_and_retry" } } });
  expect(JSON.stringify(result)).not.toContain("private"); expect(f.counts()).toEqual({ revalidations: 1, forwarded: 0 });
  f.setFault(undefined);
  expect((await f.call("runner_list", {})).isError).not.toBe(true);
});

it("AR02 revalidation transport failure preserves the credential and does not retry", async () => {
  const f = await fixture(); f.setFault(() => { throw new Error("private-token /private/state"); });
  expect(await f.call()).toMatchObject({ structuredContent: { error: { code: "registry_unavailable", operation_state: "not_started" } } });
  expect(f.counts()).toEqual({ revalidations: 1, forwarded: 0 });
});

it.each([401, 403, 404])("AR02 actual revalidation denial HTTP %s still denies", async status => {
  const f = await fixture(); f.setFault(() => new Response("not found", { status }));
  expect(await f.call()).toMatchObject({ isError: true, structuredContent: { error: { code: "permission_denied", failure_class: "authorization", operation_state: "not_started" } } });
  expect(f.counts().forwarded).toBe(0);
});

it.each([{}, { client_id: "c", secret_version: "1", scopes: ["coding:read"] }, { client_id: "c", secret_version: 1, scopes: ["admin"] }, { client_id: "c", secret_version: 1, scopes: ["coding:read", "coding:read"] }])("AR02 malformed successful revalidation %j is not fabricated revocation", async value => {
  const f = await fixture(); f.setFault(() => Response.json(value));
  expect(await f.call()).toMatchObject({ isError: true, structuredContent: { error: { code: "authorization_response_invalid", operation_state: "not_started", next_action: "contact_operator" } } });
  expect(f.counts().forwarded).toBe(0);
});

it.each(["not-json", "x".repeat(17000)])("AR02 non-JSON or oversized revalidation is bounded", async text => {
  const f = await fixture(); f.setFault(() => new Response(text));
  expect(await f.call()).toMatchObject({ structuredContent: { error: { code: "authorization_response_invalid", operation_state: "not_started" } } });
  expect(f.counts().forwarded).toBe(0);
});

it.each([{ client_id: "another", secret_version: 1 }, { client_id: "c", secret_version: 2 }])("AR02 a valid but different principal or generation is denied %j", async identity => {
  const f = await fixture(); f.setFault(() => Response.json({ ...identity, scopes: ["coding:exec"] }));
  expect(await f.call()).toMatchObject({ structuredContent: { error: { code: "permission_denied" } } });
  expect(f.counts().forwarded).toBe(0);
});

it("AR02 revocation after initial authentication still prevents execution", async () => {
  const f = await fixture();
  f.setFault(async () => {
    await runInDurableObject(f.stub, instance => { instance.revokeMcpClient("c", Date.now()); });
    return new Response("not found", { status: 404 });
  });
  expect(await f.call()).toMatchObject({ structuredContent: { error: { code: "permission_denied" } } });
  expect(f.counts()).toEqual({ revalidations: 1, forwarded: 0 });
});

it("AR02 current read-only scopes still prohibit shell after successful revalidation", async () => {
  const f = await fixture(); f.setFault(() => Response.json({ client_id: "c", secret_version: 1, scopes: ["coding:read"] }));
  expect(await f.call()).toMatchObject({ structuredContent: { error: { code: "insufficient_scope" } } });
  expect(f.counts().forwarded).toBe(0);
});

it.each(["rotate", "revoke", "remove-read-scope"])("does not let a late %s credential change the active Runner after tool revalidation", async action => {
  const f = await fixture();
  await runInDurableObject(f.stub, instance => {
    const now = Date.now();
    expect(instance.registerRunner("original", "a".repeat(64), now, undefined, "dedicated_user")).toBe(true);
    expect(instance.registerRunner("other", "b".repeat(64), now, undefined, "dedicated_user")).toBe(true);
    expect(instance.selectMcpClientRunner("c", "original", false, now).ok).toBe(true);
  });
  let mutations = 0;
  f.beforeSelection(async request => {
    mutations++;
    expect((await request.clone().json() as Record<string, unknown>).mcp_authorization).toEqual({ client_id: "c", secret_version: 1 });
    await runInDurableObject(f.stub, instance => {
      if (action === "rotate") expect(instance.rotateMcpClient("c", "d".repeat(64), "next", Date.now())?.secret_version).toBe(2);
      else if (action === "revoke") expect(instance.revokeMcpClient("c", Date.now())?.revoked_at_ms).not.toBeNull();
      else expect(instance.updateMcpClientScopes("c", ["coding:exec"], Date.now())?.scopes).toEqual(["coding:exec"]);
    });
  });
  const result = await f.call("runner_select", { runner_id: "other", confirm_switch: true });
  expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: action === "remove-read-scope" ? "insufficient_scope" : "permission_denied", operation_state: "not_started" } } });
  expect(mutations).toBe(1);
  expect(f.counts()).toEqual({ revalidations: 1, forwarded: 0 });
  expect(await runInDurableObject(f.stub, instance => instance.getMcpClientActiveRunner("c")?.active_runner_id)).toBe("original");
});
