import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { createRunnerFromControlPlane, registerRunnerFromControlPlane } from "../src/http/runner-administration.js";
import { internalHeaders, randomBase64Url, sha256Hex } from "../src/security.js";

const creation = {
  displayName: "Session recovery", selection: { mode: "dedicated_user" as const, confirmed: false },
  validity: { valid_from_ms: null, valid_until_ms: null }, ttlMs: undefined, window: undefined,
};

async function fixture(action: "create" | "register", fault: "session" | "unavailable" | "lost-response") {
  const runnerId = "creation-recovery-" + crypto.randomUUID();
  const registryId = env.REGISTRY.idFromName("registry"), registry = env.REGISTRY.get(registryId);
  const transport = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
  await runInDurableObject(registry, owner => { owner.setupAdmin("synthetic-recovery-verifier", Date.now()); });
  const session = async () => {
    const hash = await sha256Hex(randomBase64Url());
    await runInDurableObject(registry, owner => {
      const now = Date.now(); expect(owner.createAdminSession(hash, "c".repeat(64), now + 60_000, now, 1)).toBe(true);
    });
    return hash;
  };
  const expired = await session();
  const target = `/runners/${runnerId}${action === "create" ? "/add" : ""}`;
  const cancellations: Record<string, unknown>[] = [];
  let rejectWrite = true, rejectedStatus: number | undefined;
  const localEnv = { ...env, REGISTRY: { idFromName: () => registryId, get: () => ({ fetch: async (request: Request) => {
    if (rejectWrite && request.method === (action === "create" ? "POST" : "PUT") && new URL(request.url).pathname === target) {
      rejectWrite = false;
      if (fault === "unavailable") return new Response("registry unavailable", { status: 503 });
      if (fault === "lost-response") throw new Error("Registry response lost");
      await runInDurableObject(registry, owner => { owner.logoutAdminSession(expired); });
      const response = await registry.fetch(request); rejectedStatus = response.status; return response;
    }
    return registry.fetch(request);
  } }) }, RUNNER: { idFromName: () => runnerId, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/cancel-policy-mutation") cancellations.push(await request.clone().json() as Record<string, unknown>);
    return transport.fetch(request);
  } }) } } as unknown as typeof env;
  const submit = (adminSessionHash: string) => action === "create"
    ? createRunnerFromControlPlane({ ...localEnv, adminSessionHash }, runnerId, creation)
    : registerRunnerFromControlPlane({ ...localEnv, adminSessionHash }, runnerId, "a".repeat(32), env.RUNNER_TOKEN_PEPPER, "dedicated_user");
  const transportRequest = async (path: string, input?: Record<string, unknown>) => {
    const method = input === undefined ? "GET" : "POST", body = input === undefined ? "" : JSON.stringify(input);
    const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, method, path, body);
    return transport.fetch(new Request("https://runner.internal" + path, { method, headers, ...(input === undefined ? {} : { body }) }));
  };
  const admission = async () => (await transportRequest("/admission-state")).json() as Promise<Record<string, unknown>>;
  return { runnerId, registry, expired, session, submit, cancellations, admission, transportRequest, rejectedStatus: () => rejectedStatus };
}

it.each(["create", "register"] as const)("releases a rejected %s owner and allows the same Runner ID with a fresh session", async action => {
  const f = await fixture(action, "session");
  expect(await f.submit(f.expired)).toMatchObject({ state: "failed", reason: "write", cause: "denied" });
  expect(f.rejectedStatus()).toBe(403);
  expect(await runInDurableObject(f.registry, owner => owner.getRunner(f.runnerId))).toBeUndefined();
  expect(f.cancellations).toEqual([expect.objectContaining({ confirmed_write_rejection: true })]);
  expect(await f.admission()).toMatchObject({ fenced: true, mutationId: null, mutationPhase: "idle" });
  expect(await f.submit(await f.session())).toMatchObject({ state: "completed" });
  expect(await runInDurableObject(f.registry, owner => owner.getRunner(f.runnerId))).toBeDefined();
});

it.each([
  ["create", "unavailable"], ["create", "lost-response"],
  ["register", "unavailable"], ["register", "lost-response"],
] as const)("retains the missing Runner owner after %s has an unknown %s write", async (action, fault) => {
  const f = await fixture(action, fault);
  expect(await f.submit(f.expired)).toMatchObject({ state: "failed", reason: "commit" });
  expect(f.cancellations.every(input => input.confirmed_write_rejection === undefined)).toBe(true);
  expect(await runInDurableObject(f.registry, owner => owner.getRunner(f.runnerId))).toBeUndefined();
  const before = await f.admission();
  expect(before).toMatchObject({ fenced: true, mutationPhase: "precommit", mutationId: expect.any(String) });
  for (const input of [
    { mutation_id: before.mutationId },
    { mutation_id: before.mutationId, confirmed_write_rejection: "true" },
    { mutation_id: "another-owner", confirmed_write_rejection: true },
  ]) {
    const response = await f.transportRequest("/cancel-policy-mutation", input);
    expect(response.status).toBe(409); await response.body?.cancel();
  }
  expect(await f.admission()).toEqual(before);
  expect(await f.submit(await f.session())).toMatchObject({ state: "failed", reason: "fence" });
  expect(await f.admission()).toEqual(before);
});

it.each(["create", "register"] as const)("releases status-only %s receipts without waiting for cleanup or replaying writes", async action => {
  for (const fault of ["read", "fence", "write", "evidence"] as const) {
    const receipts: Response[] = [], cancelled: string[] = [], calls: string[] = [];
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const receipt = (name: string, status: number) => {
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(name)); },
        cancel() { cancelled.push(name); return cleanup; },
      }), { status });
      receipts.push(response); return response;
    };
    const localEnv = { ...env,
      REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: (request: Request) => {
        const path = new URL(request.url).pathname; calls.push(request.method + " " + path);
        if (path.endsWith("/mutation-state")) return Response.json({ mutation_committed: false });
        if (request.method === "GET") return receipt("read", fault === "read" ? 503 : 200);
        return receipt("write", fault === "write" ? 503 : 200);
      } }) },
      RUNNER: { idFromName: () => "runner", get: () => ({ fetch: (request: Request) => {
        const path = new URL(request.url).pathname; calls.push(request.method + " " + path);
        return path === "/begin-policy-mutation" && fault === "fence" ? receipt("fence", 503) : new Response(null, { status: 204 });
      } }) },
    } as unknown as typeof env;
    try {
      const result = action === "create" ? await createRunnerFromControlPlane(localEnv, "r", creation)
        : await registerRunnerFromControlPlane(localEnv, "r", "a".repeat(32), env.RUNNER_TOKEN_PEPPER, "dedicated_user");
      expect(result.state).toBe("failed");
      expect(cancelled).toEqual(fault === "read" ? ["read"] : fault === "fence" ? ["read", "fence"] : ["read", "write"]);
      expect(calls.filter(call => call === (action === "create" ? "POST /runners/r/add" : "PUT /runners/r"))).toHaveLength(fault === "read" || fault === "fence" ? 0 : 1);
    } finally {
      finishCleanup(); await Promise.all(receipts.map(response => response.body?.cancel().catch(() => undefined)));
    }
  }
}, 2_000);
