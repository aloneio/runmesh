// Audit-only tests: an isolated DO and disposable session, never production.
import { env, runInDurableObject, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { internalHeaders, randomBase64Url, sha256Hex, passwordVerifier } from "../src/security.js";
import { LOGIN_CSRF_COOKIE } from "../src/http/constants.js";
import { adminUpstreamError } from "../src/http/responses.js";
import { handleBrowserRunnerAction } from "../src/http/runner-actions.js";
import { beginRunnerPolicyMutation } from "../src/platform/runner-mutations.js";
import { cancelRunnerPolicyMutation } from "../src/platform/runner-mutations.js";
import { mutateRunnerPolicy } from "../src/http/runner-policy.js";
import { pushRunnerPolicy } from "../src/platform/runner-mutations.js";
import { deleteRunnerTransport } from "../src/platform/runner-mutations.js";
import { fenceRunnerTransport } from "../src/platform/runner-mutations.js";
import { revokeRunnerTransport } from "../src/platform/runner-mutations.js";
import { runnerMutationState } from "../src/platform/runner-state.js";
import { developmentDescriptor } from "../src/domain/release-selection.js";
import { FIXED_RELEASE_VERSION } from "../src/domain/release-config.js";
import { REVIEWED_RELEASE_VERSION } from "../src/generated-release.js";
import { registryDevelopmentReleaseCache } from "../src/http/release-cache.js";

async function fixture(registryName = `audit-admin-${crypto.randomUUID()}`) {
  const id = env.REGISTRY.idFromName(registryName), stub = env.REGISTRY.get(id);
  const session = randomBase64Url(), csrf = randomBase64Url();
  const hash = await sha256Hex(session), csrfHash = await sha256Hex(csrf), verifier = await passwordVerifier("synthetic-admin-password");
  await runInDurableObject(stub, instance => {
    const now = Date.now(); expect(instance.setupAdmin(verifier, now)).toBe(true);
    expect(instance.createAdminSession(hash, csrfHash, now + 60000, now, 1)).toBe(true);
  });
  const localEnv = { ...env, REGISTRY: { idFromName: () => id, get: () => stub } } as unknown as typeof env;
  const headers = { origin: "https://audit.test", cookie: `__Host-runmesh_admin_session=${session}; __Host-runmesh_admin_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" };
  return { stub, localEnv, hash, csrf, headers };
}

it("shares one development release refresh across Runner management and public downloads", async () => {
  // Real RunnerDO mutations resolve the production Registry name. Test storage
  // isolation keeps this binding disposable along with the authenticated session.
  const f = await fixture("registry"), runnerId = `release-scope-${crypto.randomUUID()}`;
  const form = () => new URLSearchParams({ csrf_token: f.csrf, runner_id: runnerId, display_name: "Release scope test", execution_mode: "dedicated_user" });
  const localEnv = { ...f.localEnv, RUNMESH_ENVIRONMENT: "development", RUNMESH_PUBLIC_ORIGIN: "https://audit.test", RUNMESH_SIGNED_RELEASE_AVAILABLE: "dev", RUNMESH_TEST_MODE: "" };
  const contexts: ExecutionContext[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const context = createExecutionContext(); contexts.push(context);
    const headers = new Headers(init?.headers); headers.set("host", "audit.test");
    return worker.fetch(new Request(`https://audit.test${path}`, { ...init, headers }), localEnv, context);
  };
  const [major, minor, patch] = FIXED_RELEASE_VERSION.split(".");
  const version = `${major}.${minor}.${Number(patch) + (REVIEWED_RELEASE_VERSION ? 1 : 0)}-dev.1`;
  const descriptor = developmentDescriptor({ tag_name: `v${version}`, draft: false, prerelease: true, immutable: true, published_at: "2026-09-16T08:00:00Z",
    assets: ["LICENSE", "NOTICE", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "manifest.json", "manifest.sig", "manifest.signature.json", "trust-keyring.json", `runmesh-runner-${version}.tgz`].map(name => ({ name })) });
  expect(descriptor).toBeDefined();
  // Seed the trusted storage port; signature verification has its own tests.
  await registryDevelopmentReleaseCache(localEnv).put(new Request("https://audit.test/cache-fixture"),
    Response.json({ schema_version: 1, verified_at_ms: Date.now() - 120_000, descriptor }));
  let finishRefresh!: (response: Response) => void;
  const pendingRefresh = new Promise<Response>(resolve => { finishRefresh = resolve; });
  const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(() => pendingRefresh);
  try {
    const publicRelease = await request("/runner/releases/dev");
    expect(publicRelease.status).toBe(200);
    expect(await publicRelease.json()).toMatchObject({ distributable: true, package_version: version });
    expect(upstream).toHaveBeenCalledOnce();
    for (const surface of ["create", "detail", "rotate", "enrollment"] as const) {
      const path = surface === "create" ? "/admin/runners" : `/admin/runners/${runnerId}${surface === "detail" ? "" : `/${surface}`}`;
      const body = form(); if (surface !== "create") body.set("expected_execution_mode", "dedicated_user");
      const response = await request(path, surface === "detail" ? { headers: f.headers } : { method: "POST", headers: f.headers, body });
      expect(response.status, surface).toBe(200);
      const page = await response.text();
      if (surface === "detail") expect(page).toContain(version);
      else { expect(page).toContain("One-command Runner setup"); expect(page).toContain("/runner/install.sh"); }
      expect(upstream, surface).toHaveBeenCalledOnce();
    }
    const installer = await request("/runner/install.sh");
    expect(installer.status).toBe(200); expect(await installer.text()).toContain(version);
    expect(upstream).toHaveBeenCalledOnce();
  } finally {
    finishRefresh(new Response("missing", { status: 404 }));
    try { await Promise.all(contexts.map(context => waitOnExecutionContext(context))); }
    finally { upstream.mockRestore(); }
  }
});

it.each(["/admin/runners-extra", "/admin/runners-extra/r/delete", "/admin/runners//r/delete", "/admin/runners/r/delete/", "/internal/runners//r/rpc", "/internal/runners/r/rpc/"])("rejects a noncanonical Runner route before dispatch: %s", async path => {
  let mutations = 0;
  const localEnv = { ...env, RUNNER: { idFromName: () => { mutations++; return "r"; }, get: () => ({ fetch: () => new Response(null, { status: 204 }) }) } } as unknown as typeof env;
  const body = JSON.stringify({ runner_id: "r", confirmation: "r", execution_mode: "dedicated_user" });
  const headers = path.startsWith("/internal/") ? await internalHeaders(env.INTERNAL_CONTROL_SECRET!, "POST", path, body)
    : { Authorization: "Bearer " + env.ADMIN_TOKEN, "content-type": "application/json" };
  const response = await worker.fetch(new Request("https://audit.test" + path, { method: "POST", headers, body }), localEnv, {} as ExecutionContext);
  await response.body?.cancel(); expect(response.status).toBe(404); expect(mutations).toBe(0);
});

it("routes an encoded internal Runner ID while verifying the original signed URL", async () => {
  const names: string[] = [], bodies: string[] = [];
  const localEnv = { ...env, RUNNER: { idFromName: (name: string) => { names.push(name); return name; }, get: () => ({ fetch: async (request: Request) => {
    expect(new URL(request.url).pathname).toBe("/rpc"); bodies.push(await request.text()); return new Response(null, { status: 204 });
  } }) } } as unknown as typeof env;
  const path = "/internal/runners/runner%3Aencoded/rpc", body = JSON.stringify({ method: "fixture", params: {} });
  for (const correct of [false, true]) {
    const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET!, "POST", correct ? path : "/internal/runners/runner:encoded/rpc", body);
    const response = await worker.fetch(new Request("https://audit.test" + path, { method: "POST", headers, body }), localEnv, {} as ExecutionContext);
    expect(response.status).toBe(correct ? 204 : 404); await response.body?.cancel();
    expect(names.length).toBe(correct ? 1 : 0);
  }
  expect(names).toEqual(["runner:encoded"]); expect(bodies).toEqual([body]);
});

it.each(["r%2Fx", "r%253Ax", "r%", "r%00x"])("rejects unsafe encoded Runner routes without dispatching a mutation: %s", async segment => {
  const f = await fixture(); let mutations = 0;
  const localEnv = { ...f.localEnv, RUNNER: { idFromName: () => { mutations++; return "runner"; }, get: () => ({ fetch: () => new Response(null, { status: 204 }) }) } } as unknown as typeof env;
  for (const token of [false, true]) {
    const response = await worker.fetch(new Request("https://audit.test/admin/runners/" + segment + "/delete", {
      method: "POST", headers: token ? { Authorization: "Bearer " + env.ADMIN_TOKEN, "content-type": "application/json" } : f.headers,
      body: token ? JSON.stringify({ confirmation: "r:x" }) : new URLSearchParams({ csrf_token: f.csrf, confirmation: "r:x" }),
    }), localEnv, {} as ExecutionContext);
    expect(response.status).toBe(404); await response.body?.cancel();
  }
  expect(mutations).toBe(0);
});

it("retains the authenticated console and session when a Runner deletion fence is unavailable", async () => {
  const f = await fixture(); let fences = 0;
  const localEnv = { ...f.localEnv, RUNNER: { idFromName: () => "runner", get: () => ({ fetch: () => { fences++; return new Response(null, { status: 503 }); } }) } } as unknown as typeof env;
  const response = await worker.fetch(new Request("https://audit.test/admin/runners/delete-unavailable/delete", {
    method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf, confirmation: "delete-unavailable" }),
  }), localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(fences).toBe(1);
  expect(response.headers.get("set-cookie")).toBeNull();
  const page = await response.text();
  expect(page).toContain('data-app-header'); expect(page).toContain('data-admin-error');
  expect(page).toContain('Could not start deleting the Runner. Try again.');
  expect(page).not.toContain('<body class="auth-body">');
  const next = await worker.fetch(new Request("https://audit.test/admin/runners", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(next.status).toBe(200); expect(next.headers.get("location")).toBeNull(); await next.body?.cancel();
});

it.each(["create", "rename", "rotate", "enrollment", "validity", "permissions", "version-policy", "emergency-lock", "workspace-create", "workspace-update", "workspace-delete", "history-settings"])("keeps invalid Runner %s forms inside the authenticated console", async action => {
  const f = await fixture();
  const path = action === "create" ? "/admin/runners" : "/admin/runners/form-test/" + action;
  const response = await worker.fetch(new Request("https://audit.test" + path, {
    method: "POST", headers: f.headers,
    body: new URLSearchParams({ csrf_token: f.csrf, runner_valid_days: "invalid", enrollment_ttl_ms: "invalid" }),
  }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(400); expect(response.headers.get("set-cookie")).toBeNull();
  const page = await response.text();
  expect(page).toContain('aria-current="page" href="/admin/runners"');
  expect(page).toContain("data-admin-error"); expect(page).not.toContain('<body class="auth-body">');
});

it.each(["create", "rotate", "enrollment", "rename", "version-policy"])("retains console navigation when Runner %s dependencies fail", async action => {
  const f = await fixture(), runnerId = "action-unavailable";
  const localEnv = { ...f.localEnv, REGISTRY: { idFromName: f.localEnv.REGISTRY.idFromName, get: () => ({ fetch: (request: Request) => {
    const path = new URL(request.url).pathname;
    return path === "/runners/" + runnerId || path === "/runners/" + runnerId + "/execution-state" || path === "/runners/" + runnerId + "/rename" || path === "/auth/runners/" + runnerId + "/version-policy"
      ? Promise.resolve(new Response("PRIVATE_FAILURE", { status: 503 })) : f.stub.fetch(request);
  } }) } } as unknown as typeof env;
  const path = action === "create" ? "/admin/runners" : "/admin/runners/" + runnerId + "/" + action;
  const response = await worker.fetch(new Request("https://audit.test" + path, { method: "POST", headers: f.headers,
    body: new URLSearchParams({ csrf_token: f.csrf, runner_id: runnerId, display_name: "Test Runner", execution_mode: "dedicated_user", expected_execution_mode: "dedicated_user", update_channel: "stable" }),
  }), localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("set-cookie")).toBeNull();
  const page = await response.text();
  expect(page).toContain('aria-current="page" href="/admin/runners"'); expect(page).not.toContain("PRIVATE_FAILURE");
  const recovered = await worker.fetch(new Request("https://audit.test/admin/runners", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(recovered.status).toBe(200); await recovered.body?.cancel();
});

it.each(["runner", "workspaces", "enrollment"].flatMap(part => [false, true].map(malformed => ({ part, malformed }))))("distinguishes unavailable Runner $part details from empty settings (malformed: $malformed)", async ({ part, malformed }) => {
  const f = await fixture(), runnerId = "detail-unavailable";
  await runInDurableObject(f.stub, instance => { expect(instance.registerRunner(runnerId, "synthetic", Date.now(), undefined, "dedicated_user")).toBe(true); });
  const paths: Record<string, string> = { runner: "/runners/" + runnerId, workspaces: "/auth/runners/" + runnerId + "/managed-workspaces", enrollment: "/auth/runners/" + runnerId + "/enrollments" };
  const localEnv = { ...f.localEnv, REGISTRY: { idFromName: f.localEnv.REGISTRY.idFromName, get: () => ({ fetch: (request: Request) =>
    new URL(request.url).pathname === paths[part] ? Promise.resolve(malformed ? Response.json({}) : new Response("PRIVATE_FAILURE", { status: 503 })) : f.stub.fetch(request),
  }) } } as unknown as typeof env;
  const response = await worker.fetch(new Request("https://audit.test/admin/runners/" + runnerId, { headers: f.headers }), localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("set-cookie")).toBeNull();
  const page = await response.text();
  expect(page).toContain('aria-current="page" href="/admin/runners"');
  expect(page).not.toContain("Runner was not found."); expect(page).not.toContain("PRIVATE_FAILURE");
  expect(page).not.toContain('action="/admin/runners/' + runnerId + '/workspace-create"');
  const recovered = await worker.fetch(new Request("https://audit.test/admin/runners/" + runnerId, { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(recovered.status).toBe(200); await recovered.body?.cancel();
});

it("keeps a confirmed missing Runner inside the console", async () => {
  const f = await fixture();
  const response = await worker.fetch(new Request("https://audit.test/admin/runners/missing-runner", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(404); expect(response.headers.get("set-cookie")).toBeNull();
  const page = await response.text();
  expect(page).toContain("Runner was not found."); expect(page).toContain('aria-current="page" href="/admin/runners"');
});

it.each(["history-settings", "mcp-calls"].flatMap(part => [false, true].map(malformed => ({ part, malformed }))))("keeps Runner management available when optional $part fails (malformed: $malformed)", async ({ part, malformed }) => {
  const f = await fixture(), runnerId = "optional-unavailable";
  await runInDurableObject(f.stub, instance => { expect(instance.registerRunner(runnerId, "synthetic", Date.now(), undefined, "dedicated_user")).toBe(true); });
  const localEnv = { ...f.localEnv, REGISTRY: { idFromName: f.localEnv.REGISTRY.idFromName, get: () => ({ fetch: (request: Request) =>
    new URL(request.url).pathname === "/runners/" + runnerId + "/" + part ? Promise.resolve(malformed ? Response.json({}) : new Response("PRIVATE_FAILURE", { status: 503 })) : f.stub.fetch(request),
  }) } } as unknown as typeof env;
  const response = await worker.fetch(new Request("https://audit.test/admin/runners/" + runnerId + "?history=audit", { headers: f.headers }), localEnv, {} as ExecutionContext);
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain('action="/admin/runners/' + runnerId + '/workspace-create"');
  expect(page).toContain(part === "history-settings" ? "History settings unavailable." : "Audit history unavailable.");
  expect(page).not.toContain("PRIVATE_FAILURE");
  if (part === "history-settings") expect(page).not.toContain('action="/admin/runners/' + runnerId + '/history-settings"');
});

it.each(["create", "rotate"] as const)("does not display an unconfirmed MCP %s credential", async action => {
  const f = await fixture(), original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  const path = action === "create" ? "/auth/clients" : "/auth/clients/test-client/rotate";
  const publicPath = action === "create" ? "/admin/clients" : "/admin/clients/test-client/rotate";
  for (const failure of [202, 503, "malformed", "wrong-client", "wrong-prefix", "revoked"] as const) {
    let attempts = 0;
    (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
      if (new URL(request.url).pathname !== path) return original(id).fetch(request);
      attempts++;
      if (typeof failure === "number") return new Response("PRIVATE_UPSTREAM_DIAGNOSTIC", { status: failure });
      if (failure === "malformed") return new Response("{");
      const input = await request.json() as Record<string, unknown>;
      return Response.json({ client_id: failure === "wrong-client" ? "other-client" : input.client_id ?? "test-client",
        secret_prefix: failure === "wrong-prefix" ? "mismatch" : input.secret_prefix,
        secret_version: 2, revoked_at_ms: failure === "revoked" ? Date.now() : null });
    } });
    const response = await worker.fetch(new Request(`https://audit.test${publicPath}`, {
      method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf, label: "Test client", scopes: "coding:read" }),
    }), f.localEnv, {} as ExecutionContext);
    expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
    const page = await response.text();
    expect(page).not.toMatch(/\/[A-Za-z0-9_-]{43}\/mcp/u); expect(page).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC");
    expect(attempts).toBe(1);
  }
});

it.each(["rename", "revoke", "scopes", "reset-runner", "override", "reset-override"] as const)("preserves unavailability and incomplete receipts for client %s", async action => {
  const f = await fixture(), original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  for (const status of [202, 503]) {
    let mutations = 0;
    (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
      if (!new URL(request.url).pathname.startsWith("/auth/clients/")) return original(id).fetch(request);
      mutations++; return new Response("PRIVATE_UPSTREAM_DIAGNOSTIC", { status });
    } });
    const response = await worker.fetch(new Request(`https://audit.test/admin/clients/test-client/${action}`, {
      method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf, label: "Test client", scopes: "coding:read", runner_id: "r", read: "true", edit: "false", shell: "false", job_control: "false" }),
    }), f.localEnv, {} as ExecutionContext);
    expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC"); expect(mutations).toBe(1);
  }
});

it.each([202, 429, 503, "malformed", "invalid-target"] as const)("does not call an enrollment code invalid when its lookup dependency returns %s", async failure => {
  const runnerGet = vi.fn(() => { throw new Error("Must not contact Runner before a valid lookup"); });
  const localEnv = { ...env, RUNNER: { ...env.RUNNER, get: runnerGet }, REGISTRY: {
    idFromName: () => "registry", get: () => ({ fetch: () => typeof failure === "number"
      ? Response.json({ runner_id: "test-runner" }, { status: failure })
      : new Response(failure === "malformed" ? "{" : JSON.stringify({ runner_id: "../invalid" })) }),
  } } as unknown as typeof env;
  const response = await worker.fetch(new Request("https://audit.test/runner/enroll", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_code: randomBase64Url(), runner_public_info: { platform: "linux", architecture: "x64", hostname: "test-host", runner_version: "0.1.4", protocol_version: 2 } }),
  }), localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("invalid enrollment");
  expect(runnerGet).not.toHaveBeenCalled();
});

it.each([200, 202, 206])("never treats RunnerDO %s as a completed transport mutation", async status => {
  let calls = 0, cancellations = 0;
  const localEnv = { ...env, RUNNER: { idFromName: () => "runner", get: () => ({ fetch: () => {
    calls++; return new Response(new ReadableStream({ cancel() { cancellations++; } }), { status });
  } }) } } as unknown as typeof env;
  for (const operation of [fenceRunnerTransport, beginRunnerPolicyMutation, cancelRunnerPolicyMutation, pushRunnerPolicy]) {
    expect((await operation(localEnv, "r", "mutation")).status).toBe(503);
  }
  await expect(revokeRunnerTransport(localEnv, "r", "mutation")).rejects.toThrow("did not confirm completion");
  await expect(deleteRunnerTransport(localEnv, "r", "mutation")).rejects.toThrow("did not confirm completion");
  expect(calls).toBe(6); expect(cancellations).toBe(6);
});

it.each([202, 204])("requires a completed policy commit marker while preserving the outer accepted policy receipt (%s)", async status => {
  const paths: string[] = [];
  const localEnv = { ...env, RUNNER: { idFromName: () => "runner", get: () => ({ fetch: (request: Request) => {
    const path = new URL(request.url).pathname; paths.push(path);
    if (path === "/mark-policy-committed") return new Response(null, { status });
    return new Response(null, { status: path === "/policy" ? 503 : 204 });
  } }) }, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: (request: Request) =>
    Response.json(new URL(request.url).pathname.endsWith("/mutation-state")
      ? { mutation_committed: true, policy_status: "offline_pending", desired_revision: 1, desired_checksum: "a".repeat(64) }
      : { permissions: { read: true, edit: false, shell: false, job_control: false } }) }) },
  } as unknown as typeof env;
  const response = await mutateRunnerPolicy(localEnv, "r", { path: "/runners/r/permissions", method: "POST", payload: {} });
  expect(response.status).toBe(status === 204 ? 202 : 503);
  expect(paths).toEqual(status === 204 ? ["/begin-policy-mutation", "/mark-policy-committed", "/policy"] : ["/begin-policy-mutation", "/mark-policy-committed"]);
  await response.body?.cancel();
});

it.each([202, 206, "oversized"] as const)("does not infer a committed mutation from a %s state observation", async failure => {
  const fetch = vi.fn(() => typeof failure === "number" ? Response.json({ mutation_committed: true }, { status: failure })
    : Response.json({ mutation_committed: true, padding: "x".repeat(16_384) }));
  const localEnv = { ...env, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch }) } } as unknown as typeof env;
  expect(await runnerMutationState(localEnv, "r", "mutation")).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce();
});

it.each([429, 500, 502, 503, 504])("SEC04 administrator mutation preserves dependency unavailability (%s)", async status => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
  const response = adminUpstreamError(upstream, "Runner permission profile could not be updated.");
  expect(response.status).toBe(503); expect(cancelled).toBe(true);
  expect(response.headers.get("location")).toBeNull(); expect(response.headers.get("set-cookie")).toBeNull();
  await response.body?.cancel();
});

it.each([[400, 400, 400], [404, 400, 404], [409, 409, 409]])("SEC04 administrator mutation preserves deterministic rejection %s", async (status, fallback, expected) => {
  const response = adminUpstreamError(new Response("PRIVATE_UPSTREAM_DIAGNOSTIC", { status }), "Runner permission profile could not be updated.", fallback);
  expect(response.status).toBe(expected); expect(await response.text()).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC");
});

it.each(["emergency-lock", "workspace-delete"] as const)("SEC04 %s does not misreport or replay a failed policy fence", async action => {
  const paths: string[] = [], registryGet = vi.fn(() => { throw new Error("Registry mutation must not be dispatched after a failed fence"); });
  const localEnv = { ...env, REGISTRY: { idFromName: env.REGISTRY.idFromName.bind(env.REGISTRY), get: registryGet }, RUNNER: {
    idFromName: env.RUNNER.idFromName.bind(env.RUNNER), get: () => ({ fetch: async (request: Request) => {
      paths.push(new URL(request.url).pathname); return new Response("PRIVATE_UPSTREAM_DIAGNOSTIC", { status: 503 });
    } }),
  } } as unknown as typeof env;
  const form = new FormData(); form.set("workspace_id", "w"); form.set("confirmation", action === "workspace-delete" ? "w" : "r");
  const response = await handleBrowserRunnerAction(localEnv, form, "https://audit.test", "r", action);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).not.toContain("PRIVATE_UPSTREAM_DIAGNOSTIC");
  expect(paths).toEqual(["/begin-policy-mutation"]); expect(registryGet).not.toHaveBeenCalled();
});

it("AUDIT-ADMIN: revoking a session while its POST body is held prevents later credential creation", async () => {
  const f = await fixture();
  let signalVerified!: () => void;
  const verified = new Promise<void>(resolve => { signalVerified = resolve; });
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const response = await original(id).fetch(request);
    if (new URL(request.url).pathname === "/auth/sessions/verify") signalVerified();
    return response;
  } });
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } });
  const pending = worker.fetch(new Request("https://audit.test/admin/clients", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([verified, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("audit fixture admission timeout")), 2000); })]);
    await runInDurableObject(f.stub, instance => {
      instance.logoutAdminSession(f.hash);
      expect(instance.verifyAdminSession(f.hash, Date.now())).toBeUndefined();
    });
    bodyController.enqueue(new TextEncoder().encode(new URLSearchParams({ csrf_token: f.csrf, label: "audit-after-revocation", scopes: "coding:exec" }).toString()));
    bodyController.close();
    const response = await pending;
    await response.body?.cancel();
    const created = await runInDurableObject(f.stub, instance => instance.listMcpClients().filter(client => client.label === "audit-after-revocation").length);
    console.log(JSON.stringify({ audit: "admin_pending_revocation", response_status: response.status, new_credentials_created: created }));
    expect(created).toBe(0);
  } finally { if (timer !== undefined) clearTimeout(timer); }
});

it("AUDIT-ADMIN: a session dependency outage is not a sign-out", async () => {
  const f = await fixture();
  (f.localEnv.REGISTRY as any).get = () => ({ fetch: () => Response.json({ error: "synthetic dependency unavailable" }, { status: 503 }) });
  const response = await worker.fetch(new Request("https://audit.test/admin", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  console.log(JSON.stringify({ audit: "admin_session_outage", status: response.status, cleared_session: (response.headers.get("set-cookie") ?? "").includes("Max-Age=0") }));
  await response.body?.cancel(); expect(response.status).toBe(503);
});

it("AUDIT-ADMIN: password settings outage is not an incorrect current password", async () => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => new URL(request.url).pathname === "/auth/settings" ? Response.json({ error: "synthetic dependency unavailable" }, { status: 503 }) : original(id).fetch(request) });
  const body = new URLSearchParams({ csrf_token: f.csrf, current_password: "synthetic-admin-password", password: "new-synthetic-admin-password", confirm_password: "new-synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/admin/password", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  const html = await response.text();
  console.log(JSON.stringify({ audit: "admin_password_settings_outage", status: response.status, claimed_wrong_password: html.includes("Current administrator password is invalid.") }));
  expect(response.status).toBe(503);
});

it.each(["revoke", "rotate-password"])("SEC01 rechecks %s at the signed Registry write, after the final page check", async action => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let mutationChecked = false;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/auth/clients" && request.method === "POST") {
      expect(url.searchParams.get("admin_session")).toBe(f.hash);
      await runInDurableObject(f.stub, instance => {
        if (action === "revoke") instance.logoutAdminSession(f.hash);
        else instance.changeAdminPassword("synthetic-rotated-verifier", Date.now());
      });
      mutationChecked = true;
    }
    return original(id).fetch(request);
  } });
  const body = new URLSearchParams({ csrf_token: f.csrf, label: "late-revocation", scopes: "coding:exec" });
  const response = await worker.fetch(new Request("https://audit.test/admin/clients", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  await response.body?.cancel();
  expect(mutationChecked).toBe(true); expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await runInDurableObject(f.stub, instance => instance.listMcpClients())).toHaveLength(0);
});

it.each([429, 500, 502, 503, 504, "malformed", "oversized"])("SEC04 preserves session cookies when its dependency returns %s", async failure => {
  const f = await fixture();
  (f.localEnv.REGISTRY as any).get = () => ({ fetch: () => typeof failure === "number" ? new Response("synthetic failure", { status: failure }) : new Response(failure === "malformed" ? "{" : "x".repeat(17000)) });
  const response = await worker.fetch(new Request("https://audit.test/admin", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("set-cookie")).toBeNull();
  await response.body?.cancel();
});

it.each([401, 403, 404])("SEC04 an actual session denial %s still signs out", async status => {
  const f = await fixture();
  (f.localEnv.REGISTRY as any).get = () => ({ fetch: () => new Response("denied", { status }) });
  const response = await worker.fetch(new Request("https://audit.test/admin", { headers: f.headers }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  await response.body?.cancel();
});

it("SEC04 bounds a stalled authorization body and cancels its reader", async () => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  let signal: AbortSignal | undefined, cancelled = false;
  const result = await boundedJsonResponse(async value => { signal = value; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }, 10);
  expect(result).toBeUndefined(); expect(signal?.aborted).toBe(true); expect(cancelled).toBe(true);
});

it.each([200, 202, 401, 403, 404, 429, 500, 502, 503, 504, "transport"])("SEC04 logout does not acknowledge an unconfirmed revocation (%s)", async failure => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let attempts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/sessions/logout") return original(id).fetch(request);
    attempts++;
    if (failure === "transport") throw new Error("synthetic transport failure");
    return new Response("synthetic revocation failure", { status: failure as number });
  } });
  const response = await worker.fetch(new Request("https://audit.test/admin/logout", { method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf }) }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull(); expect(attempts).toBe(1);
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeDefined();
});

it("SEC04 successful logout revokes the server session before clearing cookies", async () => {
  const f = await fixture();
  const response = await worker.fetch(new Request("https://audit.test/admin/logout", { method: "POST", headers: f.headers, body: new URLSearchParams({ csrf_token: f.csrf }) }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeUndefined();
});

it("SEC04 bounds empty response chunks even when they consume no byte budget", async () => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls <= 4096) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  expect(await boundedJsonResponse(async () => new Response(stream), 5000, 2)).toBeUndefined();
  expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(1026);
});

it("SEC04 accepts occasional empty chunks and fragmented UTF-8 within the byte budget", async () => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  const value = { value: "中文😀" }, bytes = new TextEncoder().encode(JSON.stringify(value));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) { controller.enqueue(new Uint8Array()); controller.enqueue(Uint8Array.of(byte)); }
    controller.close();
  } });
  expect(await boundedJsonResponse(async () => new Response(stream), 5000, bytes.length)).toEqual({ status: 200, value });
});

it.each([200, 201, 202, 206, 401, 403, 404, 429, 500, 503, "transport"])("SEC04 login requires a completed session-creation receipt (%s)", async failure => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  let attempts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/sessions") return original(id).fetch(request);
    attempts++;
    if (failure === "transport") throw new Error("synthetic session receipt failure");
    return new Response("synthetic unconfirmed session", { status: failure });
  } });
  const headers = { ...f.headers, cookie: `${LOGIN_CSRF_COOKIE}=${f.csrf}` };
  const body = new URLSearchParams({ csrf_token: f.csrf, password: "synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/", { method: "POST", headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull(); expect(attempts).toBe(1);
  await response.body?.cancel();
});

it("SEC04 a completed login persists its session before issuing browser cookies", async () => {
  const f = await fixture();
  const headers = { ...f.headers, cookie: `${LOGIN_CSRF_COOKIE}=${f.csrf}` };
  const body = new URLSearchParams({ csrf_token: f.csrf, password: "synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/", { method: "POST", headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/admin");
  expect(response.headers.get("set-cookie")).toContain("__Host-runmesh_admin_session=");
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, (_instance, state) => state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM admin_sessions").one().total)).toBe(2);
});

it.each([200, 201, 202, 206, 401, 403, 404, 409, 429, 500, 503, "transport"])("SEC04 password change requires a completed mutation receipt (%s)", async failure => {
  const f = await fixture();
  const original = f.localEnv.REGISTRY.get.bind(f.localEnv.REGISTRY);
  const previous = await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier());
  let attempts = 0;
  (f.localEnv.REGISTRY as any).get = (id: DurableObjectId) => ({ fetch: (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/password") return original(id).fetch(request);
    attempts++;
    if (failure === "transport") throw new Error("synthetic password receipt failure");
    return new Response("synthetic unconfirmed password", { status: failure });
  } });
  const body = new URLSearchParams({ csrf_token: f.csrf, current_password: "synthetic-admin-password", password: "new-synthetic-admin-password", confirm_password: "new-synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/admin/password", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(503); expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull(); expect(attempts).toBe(1);
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier())).toBe(previous);
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeDefined();
});

it("SEC04 a completed password change revokes the old server session", async () => {
  const f = await fixture();
  const previous = await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier());
  const body = new URLSearchParams({ csrf_token: f.csrf, current_password: "synthetic-admin-password", password: "new-synthetic-admin-password", confirm_password: "new-synthetic-admin-password" });
  const response = await worker.fetch(new Request("https://audit.test/admin/password", { method: "POST", headers: f.headers, body }), f.localEnv, {} as ExecutionContext);
  expect(response.status).toBe(303); expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  await response.body?.cancel();
  expect(await runInDurableObject(f.stub, instance => instance.adminPasswordVerifier())).not.toBe(previous);
  expect(await runInDurableObject(f.stub, instance => instance.verifyAdminSession(f.hash, Date.now()))).toBeUndefined();
});

it.each([401, 403, 404, 503])("SEC04 an expired status observation (%s) is unavailable, not a fresh denial", async status => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  let clock = 0, signal: AbortSignal | undefined;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const response = await boundedJsonResponse(async input => { signal = input; clock = 10; return new Response("synthetic late status", { status }); }, 10);
    expect(response).toBeUndefined(); expect(signal?.aborted).toBe(true);
  } finally { now.mockRestore(); }
});


it("bounds explicitly parsed denial receipts without broadening default authorization", async () => {
  const { boundedJsonReceipt, boundedJsonResponse } = await import("../src/bounded-json.js");
  const denied = () => Response.json({ ok: false }, { status: 403 });
  expect(await boundedJsonResponse(async () => denied())).toEqual({ status: 403 });
  expect(await boundedJsonReceipt(async () => denied(), [200, 403])).toEqual({ status: 403, value: { ok: false } });
});
it("a pre-cancelled observation never starts a request", async () => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  const parent = new AbortController(), fetchResponse = vi.fn(async () => Response.json({ ok: true }));
  parent.abort();
  expect(await boundedJsonResponse(fetchResponse, 5000, 16384, parent.signal)).toBeUndefined();
  expect(fetchResponse).not.toHaveBeenCalled();
});
it("parent cancellation settles ignored aborts without cancelling another observation", async () => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  const parent = new AbortController(), independentParent = new AbortController(), cancel = vi.fn();
  let finish!: (response: Response) => void, finishIndependent!: (response: Response) => void;
  let cancelledSignal: AbortSignal | undefined, independentSignal: AbortSignal | undefined;
  const pending = boundedJsonResponse(signal => { cancelledSignal = signal; return new Promise(resolve => { finish = resolve; }); }, 5000, 16384, parent.signal);
  const independent = boundedJsonResponse(signal => { independentSignal = signal; return new Promise(resolve => { finishIndependent = resolve; }); }, 5000, 16384, independentParent.signal);
  parent.abort();
  const cancelledBeforeCompletion = cancelledSignal?.aborted, independentBeforeCompletion = independentSignal?.aborted;
  finishIndependent(Response.json({ ok: true }));
  const result = await pending;
  finish(new Response(new ReadableStream({ cancel })));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(result).toBeUndefined();
  expect(cancelledBeforeCompletion).toBe(true);
  expect(independentBeforeCompletion).toBe(false);
  expect(await independent).toEqual({ status: 200, value: { ok: true } });
  expect(independentParent.signal.aborted).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(["complete", "cancel"])("a bounded observation removes its parent listener after %s", async outcome => {
  const { boundedJsonResponse } = await import("../src/bounded-json.js");
  const parent = new AbortController();
  const added = vi.spyOn(parent.signal, "addEventListener"), removed = vi.spyOn(parent.signal, "removeEventListener");
  try {
    const pending = boundedJsonResponse(async () => { if (outcome === "cancel") parent.abort(); return Response.json({ ok: true }); }, 5000, 16384, parent.signal);
    expect(await pending).toEqual(outcome === "cancel" ? undefined : { status: 200, value: { ok: true } });
    expect(added).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledExactlyOnceWith("abort", added.mock.calls[0]?.[1]);
    expect(parent.signal.aborted).toBe(outcome === "cancel");
  } finally { added.mockRestore(); removed.mockRestore(); }
});
it("a bounded observation cancels a late response even when fetch ignores abort", async () => {
  const { boundedJsonReceipt } = await import("../src/bounded-json.js");
  let finish: ((response: Response) => void) | undefined, signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  const result = await boundedJsonReceipt(input => { signal = input; return new Promise(resolve => { finish = resolve; }); }, [200], 10);
  expect(result).toBeUndefined(); expect(signal?.aborted).toBe(true);
  finish!(response);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(cancel).toHaveBeenCalledTimes(1);
});
it.each([200, 403, 409])("an unfinished explicitly parsed HTTP %s body cannot exhaust the observation deadline", async status => {
  const { boundedJsonReceipt } = await import("../src/bounded-json.js");
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel });
  expect(await boundedJsonReceipt(async () => new Response(stream, { status }), [200, 403, 409], 10)).toBeUndefined();
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("bounded receipt storage copies reused stream buffers and accepts fragmented valid JSON", async () => {
  const { boundedJsonReceipt } = await import("../src/bounded-json.js");
  const encoded = new TextEncoder().encode('{"ok":true,"text":"中文😀"}');
  let offset = 0;
  const reused = new Uint8Array(1);
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === encoded.length) { controller.close(); return; }
    reused[0] = encoded[offset++]!; controller.enqueue(reused);
  } }, { highWaterMark: 0 });
  expect(await boundedJsonReceipt(async () => new Response(body), [200], 5000, encoded.length)).toEqual({ status: 200, value: { ok: true, text: "中文😀" } });
});
