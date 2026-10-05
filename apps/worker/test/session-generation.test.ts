import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { internalHeaders, passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";

it.each(["/auth/settings", "/auth/sessions"])("rejects an in-flight old-password login when rotation overlaps %s", async (boundary) => {
  const id = env.REGISTRY.idFromName(`session-generation-${crypto.randomUUID()}`);
  const stub = env.REGISTRY.get(id);
  const oldPassword = "synthetic-old-regression-password";
  const newPassword = "synthetic-new-regression-password";
  const oldVerifier = await passwordVerifier(oldPassword);
  const nextVerifier = await passwordVerifier(newPassword);
  const priorHash = await sha256Hex(randomBase64Url());
  const csrfHash = await sha256Hex(randomBase64Url());
  await runInDurableObject(stub, (instance) => {
    expect(instance.setupAdmin(oldVerifier, Date.now())).toBe(true);
    expect(instance.createAdminSession(priorHash, csrfHash, Date.now() + 60_000, Date.now(), 1)).toBe(true);
  });
  let rotated = false;
  const rotate = async () => {
    rotated = true;
    await runInDurableObject(stub, (instance) => {
      expect(instance.changeAdminPassword(nextVerifier, Date.now())).toBe(true);
      expect(instance.verifyAdminSession(priorHash, Date.now())).toBeUndefined();
    });
  };
  const namespace = {
    idFromName: () => id,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (!rotated && boundary === "/auth/sessions" && path === boundary) await rotate();
      const response = await stub.fetch(request);
      if (!rotated && boundary === "/auth/settings" && path === boundary) await rotate();
      return response;
    } }),
  };
  const localEnv = { ...env, REGISTRY: namespace, RUNMESH_TEST_MODE: "1" } as unknown as typeof env;
  const request = (password: string) => {
    const csrf = randomBase64Url();
    return new Request("https://regression.example/login", {
      method: "POST",
      headers: { origin: "https://regression.example", cookie: `__Host-runmesh_login_csrf=${csrf}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, csrf_token: csrf }),
    });
  };
  const raced = await worker.fetch(request(oldPassword), localEnv, {} as ExecutionContext);
  expect(rotated).toBe(true);
  expect(raced.status).toBe(403);
  expect(raced.headers.get("set-cookie") ?? "").not.toContain("__Host-runmesh_admin_session=");
  expect((await worker.fetch(request(oldPassword), localEnv, {} as ExecutionContext)).status).toBe(403);
  const normal = await worker.fetch(request(newPassword), localEnv, {} as ExecutionContext);
  expect(normal.status).toBe(303);
  const token = /__Host-runmesh_admin_session=([^;]+)/.exec(normal.headers.get("set-cookie") ?? "")?.[1];
  expect(token).toBeDefined();
  const sessionHash = await sha256Hex(token as string);
  expect(await runInDurableObject(stub, (instance) => instance.verifyAdminSession(sessionHash, Date.now()) !== undefined)).toBe(true);
});

it("rejects stale, missing, and malformed generations after consecutive rotations", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`session-cas-${crypto.randomUUID()}`));
  const verifier = await passwordVerifier("synthetic-rotation-regression-password");
  await runInDurableObject(stub, (instance) => {
    const now = Date.now();
    expect(instance.setupAdmin(verifier, now)).toBe(true);
    expect(instance.changeAdminPassword(verifier, now + 1)).toBe(true);
    expect(instance.changeAdminPassword(verifier, now + 2)).toBe(true);
    for (const generation of [0, 1, 2, NaN, 1.5]) {
      expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 60_000, now + 3, generation)).toBe(false);
    }
    expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 60_000, now + 3, 3)).toBe(true);
    expect(instance.verifyAdminSession("a".repeat(64), now + 3)).toBeDefined();
  });
});

it.each(["permissions", "revoke", "rotate", "enrollment"] as const)("releases the %s fence when its Registry write rejects an expired admin session", async action => {
  const runnerId = "session-mutation-" + crypto.randomUUID(), id = env.REGISTRY.idFromName("registry");
  const registry = env.REGISTRY.get(id), transport = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
  const verifier = await passwordVerifier("synthetic-fence-session-password");
  const before = await runInDurableObject(registry, owner => {
    const now = Date.now(); owner.setupAdmin(verifier, now);
    owner.registerRunner(runnerId, "a".repeat(64), now, undefined, "dedicated_user");
    return owner.getRunnerExecutionState(runnerId);
  });
  const session = async () => {
    const raw = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(raw), csrfHash = await sha256Hex(csrf);
    await runInDurableObject(registry, owner => {
      const now = Date.now(); expect(owner.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
    });
    return { raw, csrf, hash };
  };
  const expired = await session();
  let rejectWrite = true, rejection: number | undefined;
  const target = action === "permissions" ? `/auth/runners/${runnerId}/permissions`
    : `/runners/${runnerId}/${action === "enrollment" ? "enrollments" : action}`;
  const transportCalls: string[] = [];
  const registryNamespace = { idFromName: () => id, get: () => ({ fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (rejectWrite && request.method === "POST" && url.pathname === target) {
      rejectWrite = false;
      await runInDurableObject(registry, owner => { owner.logoutAdminSession(expired.hash); });
      const response = await registry.fetch(request); rejection = response.status; return response;
    }
    return registry.fetch(request);
  } }) };
  const localEnv = { ...env, REGISTRY: registryNamespace, RUNNER: { idFromName: () => runnerId, get: () => ({ fetch: (request: Request) => {
    transportCalls.push(new URL(request.url).pathname); return transport.fetch(request);
  } }) } } as unknown as typeof env;
  const submit = async (credentials: Awaited<ReturnType<typeof session>>, selected: string) => worker.fetch(new Request(`https://mutation.test/admin/runners/${runnerId}/${selected}`, {
    method: "POST", headers: { origin: "https://mutation.test", cookie: `${ADMIN_SESSION_COOKIE}=${credentials.raw}; ${ADMIN_CSRF_COOKIE}=${credentials.csrf}` },
    body: new URLSearchParams({ csrf_token: credentials.csrf, confirmation: runnerId, expected_execution_mode: "dedicated_user",
      read: "true", edit: "false", shell: "false", job_control: "false" }),
  }), localEnv, {} as ExecutionContext);
  const denied = await submit(expired, action);
  expect(rejection).toBe(403); expect(denied.status).toBe(403);
  expect(await runInDurableObject(registry, owner => owner.getRunnerExecutionState(runnerId))).toEqual(before);
  expect(transportCalls).toContain("/cancel-policy-mutation");
  expect(await runInDurableObject(registry, owner => owner.verifyAdminSession(expired.hash, Date.now()))).toBeUndefined();
  const path = "/admission-state", headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", path, "");
  const admission = await transport.fetch(new Request("https://runner.internal" + path, { headers }));
  expect(await admission.json()).toMatchObject({ mutationId: null, mutationPhase: "idle" });
  const fresh = await session();
  expect((await submit(fresh, "permissions")).status).toBe(303);
});
