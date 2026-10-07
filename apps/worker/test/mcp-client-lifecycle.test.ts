import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { internalHeaders, randomBase64Url, sha256Hex } from "../src/security.js";

async function fixture(native: boolean) {
  const id = env.REGISTRY.idFromName("client-lifecycle-" + crypto.randomUUID());
  const stub = env.REGISTRY.get(id);
  const session = randomBase64Url(), csrf = randomBase64Url(), secret = randomBase64Url();
  const sessionHash = await sha256Hex(session), csrfHash = await sha256Hex(csrf), verifier = await sha256Hex(secret);
  const clientId = "client:target", otherId = "client:keep";
  await runInDurableObject(stub, instance => {
    const now = Date.now();
    expect(instance.setupAdmin("synthetic-lifecycle-admin", now)).toBe(true);
    expect(instance.createAdminSession(sessionHash, csrfHash, now + 60000, now, 1)).toBe(true);
  });
  async function internal(path: string, value: unknown = {}, method = "POST") {
    const body = method === "DELETE" ? "" : JSON.stringify(value);
    return stub.fetch(new Request("https://registry.internal" + path, {
      method, body, headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, method, path, body),
    }));
  }
  for (const [key, label, secretVerifier] of [[clientId, "Target client", verifier], [otherId, "Keep client", "b".repeat(64)]] as const) {
    const response = await internal("/auth/clients", { identity_version: 2, client_id: key, label,
      secret_verifier: secretVerifier, secret_prefix: "synthetic", native_scopes: native ? ["coding:read"] : [] });
    expect(response.status).toBe(200);
  }
  await runInDurableObject(stub, instance => {
    const now = Date.now();
    instance.registerRunner("keep-runner", "synthetic", now, undefined, "dedicated_user");
    const permissions = { read: true, edit: false, shell: false, job_control: false };
    expect(instance.setClientRunnerOverride(clientId, "keep-runner", permissions, now)).toBe(true);
    expect(instance.setClientRunnerOverride(otherId, "keep-runner", permissions, now)).toBe(true);
  });
  let unavailableAction: "delete" | "revoke" | undefined;
  let unavailableRead: string | undefined;
  let malformedRead: boolean | Record<string, unknown> = false;
  const registry = { idFromName: () => id, get: () => ({ fetch: (request: Request) => {
    if (request.method === "GET" && new URL(request.url).pathname === unavailableRead) return Promise.resolve(malformedRead ? Response.json(malformedRead === true ? {} : malformedRead) : new Response("unavailable", { status: 503 }));
    if ((unavailableAction === "delete" && request.method === "DELETE")
      || (unavailableAction === "revoke" && new URL(request.url).pathname.endsWith("/revoke"))) return Promise.resolve(new Response("unavailable", { status: 503 }));
    return stub.fetch(request);
  } }) } as unknown as typeof env.REGISTRY;
  const cookie = "__Host-runmesh_admin_session=" + session + "; __Host-runmesh_admin_csrf=" + csrf;
  const request = (path: string, init: RequestInit = {}) => worker.fetch(new Request("https://worker.test" + path, init), { ...env, REGISTRY: registry }, {} as ExecutionContext);
  const open = (path: string) => request(path, { headers: { cookie }, redirect: "manual" });
  const submit = (action: string, validCsrf = true, authenticated = true) => request("/admin/clients/" + encodeURIComponent(clientId) + "/" + action, {
    method: "POST", redirect: "manual", headers: { origin: "https://worker.test", "content-type": "application/x-www-form-urlencoded", ...(authenticated ? { cookie } : {}) },
    body: new URLSearchParams({ csrf_token: validCsrf ? csrf : "invalid" }),
  });
  const mcp = () => request("/" + secret + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  return { stub, clientId, otherId, internal, open, submit, mcp, failAction: (action: "delete" | "revoke") => { unavailableAction = action; }, failRead: (path?: string, malformed: boolean | Record<string, unknown> = false) => { unavailableRead = path; malformedRead = malformed; } };
}

it.each([false, true])("deletes active MCP clients and their overrides when computer access is %s", async native => {
  const f = await fixture(native);
  expect((await f.mcp()).status).toBe(200);
  const response = await f.submit("delete");
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/admin/clients");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect((await f.mcp()).status).toBe(404);
  expect((await f.internal("/auth/mcp/revalidate", { identity_version: 2, client_id: f.clientId, secret_version: 1 })).status).toBe(404);
  await runInDurableObject(f.stub, instance => {
    expect(instance.getMcpClient(f.clientId)).toBeUndefined();
    expect(instance.listClientRunnerOverrides(f.clientId)).toEqual([]);
    expect(instance.getMcpClient(f.otherId)).toBeDefined();
    expect(instance.listClientRunnerOverrides(f.otherId)).toHaveLength(1);
    expect(instance.getRunner("keep-runner")).toBeDefined();
  });
  const missing = await f.open("/admin/clients/" + encodeURIComponent(f.clientId));
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain('aria-current="page" href="/admin/clients"');
  expect((await f.open("/admin")).status).toBe(200);
});

it("revocation retains the client until it is deleted", async () => {
  const f = await fixture(false);
  expect((await f.submit("revoke")).status).toBe(303);
  expect((await f.mcp()).status).toBe(404);
  await runInDurableObject(f.stub, instance => {
    expect(instance.getMcpClient(f.clientId)?.revoked_at_ms).toEqual(expect.any(Number));
  });
  const detail = await (await f.open("/admin/clients/" + encodeURIComponent(f.clientId))).text();
  expect(detail).toContain('/delete"');
  expect(detail).not.toContain('action="/admin/clients/client%3Atarget/revoke"');
  expect((await f.submit("delete")).status).toBe(303);
  const repeated = await f.submit("delete");
  expect(repeated.status).toBe(404);
  expect(await repeated.text()).toContain('aria-current="page" href="/admin/clients"');
  expect((await f.open("/admin/clients")).status).toBe(200);
});

it("deletion requires the current administrator and CSRF token", async () => {
  const f = await fixture(true);
  expect((await f.submit("delete", true, false)).status).toBe(303);
  expect((await f.submit("delete", false)).status).toBe(403);
  expect((await f.open("/admin/clients/" + encodeURIComponent(f.clientId) + "/delete")).status).toBe(405);
  expect((await f.internal("/auth/clients/" + encodeURIComponent(f.clientId) + "/unexpected", {}, "DELETE")).status).toBe(404);
  expect((await f.mcp()).status).toBe(200);
});

it.each(["delete", "revoke"] as const)("a failed %s keeps the client, session and console navigation available", async action => {
  const f = await fixture(false);
  f.failAction(action);
  const response = await f.submit(action);
  expect(response.status).toBe(503);
  expect(response.headers.get("set-cookie")).toBeNull();
  const body = await response.text();
  expect(body).toContain('<body class="ops-body">');
  expect(body).toContain('aria-current="page" href="/admin/clients"');
  expect(body).not.toContain('<body class="auth-body">');
  expect((await f.mcp()).status).toBe(200);
  expect((await f.open("/admin")).status).toBe(200);
  await runInDurableObject(f.stub, instance => {
    expect(instance.listClientRunnerOverrides(f.clientId)).toHaveLength(1);
  });
});

it.each(["/auth/clients/client%3Atarget", "/runners", "/auth/clients/client%3Atarget/runner-overrides"])("keeps failed %s reads distinct from absent clients or empty permissions", async path => {
  const f = await fixture(true);
  f.failRead(path);
  const response = await f.open("/admin/clients/" + encodeURIComponent(f.clientId));
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain('aria-current="page" href="/admin/clients"');
  expect(body).not.toContain('class="scope-editor-form"');
  expect(body).not.toContain("MCP client was not found.");
  expect(response.headers.get("set-cookie")).toBeNull();
  f.failRead();
  expect((await f.open("/admin/clients/" + encodeURIComponent(f.clientId))).status).toBe(200);
  expect((await f.mcp()).status).toBe(200);
});

it.each(["rename", "scopes", "active-runner"])("keeps invalid %s form submissions in the client console", async action => {
  const f = await fixture(true);
  const response = await f.submit(action);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('aria-current="page" href="/admin/clients"');
  expect((await f.mcp()).status).toBe(200);
});

it.each([
  ["missing scopes", { scopes: null }],
  ["unknown scope", { scopes: ["coding:all"] }],
  ["missing revocation timestamp", { revoked_at_ms: undefined }],
  ["missing identifier", { client_id: undefined }],
] as const)("does not render invalid client display data as editable permissions: %s", async (_label, invalid) => {
  const f = await fixture(true);
  const client = { client_id: f.clientId, label: "Target client", scopes: ["coding:read"],
    revoked_at_ms: null, last_used_at_ms: null, active_runner_id: null, ...invalid };
  for (const detail of [false, true]) {
    const suffix = detail ? "/" + encodeURIComponent(f.clientId) : "";
    f.failRead("/auth/clients" + suffix, detail ? client : { clients: [client] });
    const page = "/admin/clients" + suffix;
    const response = await f.open(page);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('class="scope-editor-form"');
    expect(body).not.toContain('action="/admin/clients/client%3Atarget/delete"');
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  f.failRead();
  expect((await f.open("/admin/clients/" + encodeURIComponent(f.clientId))).status).toBe(200);
  expect((await f.mcp()).status).toBe(200);
});

it("loads the Runner list independently of unavailable client storage", async () => {
  const f = await fixture(true);
  f.failRead("/auth/clients");
  const response = await f.open("/admin/runners");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("keep-runner");
});

it.each([
  ["/admin/clients", "/auth/clients"],
  ["/admin/runners", "/runners"],
  ["/admin", "/auth/clients"],
].flatMap(([page, dependency]) => [false, true].map(malformed => ({ page: page!, dependency: dependency!, malformed }))))("keeps $page read failures distinct from empty data (malformed: $malformed)", async ({ page, dependency, malformed }) => {
  const f = await fixture(true);
  f.failRead(dependency, malformed);
  const response = await f.open(page);
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).toContain('aria-current="page" href="' + page + '"');
  expect(body).toContain("data-admin-error");
  expect(body).not.toContain('class="metric-value"');
  expect(response.headers.get("set-cookie")).toBeNull();
  expect((await f.open("/admin/settings")).status).toBe(200);
  f.failRead();
  const recovered = await f.open(page);
  expect(recovered.status).toBe(200);
  expect(await recovered.text()).toContain(page === "/admin/runners" ? "keep-runner" : "Target client");
  expect((await f.mcp()).status).toBe(200);
});

it.each([false, true])("offers localized revoke and delete actions on list and details when computer access is %s", async native => {
  const f = await fixture(native);
  for (const path of ["/admin/clients", "/admin/clients/" + encodeURIComponent(f.clientId)]) {
    for (const locale of ["en", "zh-CN"]) {
      const response = await f.open(path + "?lang=" + locale);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain('action="/admin/clients/client%3Atarget/revoke"');
      expect(body).toContain('action="/admin/clients/client%3Atarget/delete"');
      expect(body).toContain("data-client-delete");
      expect(body).toContain('name="csrf_token"');
      expect(body).toContain(locale === "en" ? ">Delete</button>" : ">删除</button>");
      expect(body).toContain(locale === "en" ? ">Revoke</button>" : ">撤销</button>");
    }
  }
});
