import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { RunnerDO } from "../src/runner-do.js";
import { createRunnerFromControlPlane } from "../src/http/runner-administration.js";
import { handleBrowserRunnerAction } from "../src/http/runner-actions.js";
import { sha256Hex } from "../src/security.js";

it.each(["warm", "reconstructed"] as const)("saves a valid first permission profile before Runner enrollment: %s", mode => saveProfile(mode, true));
it.each(["warm", "reconstructed"] as const)("rejects inconsistent permission choices before acquiring a Runner fence: %s", mode => saveProfile(mode, false));

async function saveProfile(mode: "warm" | "reconstructed", editAllowed: boolean) {
  const runnerId = "unregistered-policy-" + crypto.randomUUID();
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  const sessionHash = await sha256Hex("policy-session-" + crypto.randomUUID());
  await runInDurableObject(registry, instance => {
    instance.setupAdmin("synthetic-policy-admin", Date.now());
    expect(instance.createAdminSession(sessionHash, "c".repeat(64), Date.now() + 60_000, Date.now(), 1)).toBe(true);
  });
  const workerEnv = { ...env, adminSessionHash: sessionHash };
  const created = await createRunnerFromControlPlane(workerEnv, runnerId, {
    displayName: "Unregistered policy test", selection: { mode: "dedicated_user", confirmed: false },
    validity: { valid_from_ms: null, valid_until_ms: null }, ttlMs: undefined, window: undefined,
  });
  expect(created.state).toBe("completed");
  await expect(runInDurableObject(registry, instance => instance.getRunner(runnerId))).resolves.toMatchObject({
    state: "offline", credential_version: 0, desired_policy_revision: 1,
    runner_permissions: { read: true, edit: false, shell: false, job_control: false },
  });
  const submit = async (targetEnv: typeof workerEnv) => {
    const trace: Array<{ target: string; path: string; status: number }> = [];
    const observed = (target: string, namespace: typeof env.RUNNER) => ({
      idFromName: namespace.idFromName.bind(namespace),
      get: (id: DurableObjectId) => ({ fetch: async (request: Request) => {
        const response = await namespace.get(id).fetch(request);
        trace.push({ target, path: new URL(request.url).pathname.replace(runnerId, "runner"), status: response.status });
        return response;
      } }),
    });
    const tracedEnv = { ...targetEnv,
      RUNNER: observed("runner", targetEnv.RUNNER) as unknown as typeof env.RUNNER,
      REGISTRY: observed("registry", targetEnv.REGISTRY as unknown as typeof env.RUNNER) as unknown as typeof env.REGISTRY,
    };
    const form = new FormData();
    for (const [key, value] of Object.entries({ read: "true", edit: String(editAllowed), shell: "true", job_control: "true" })) form.set(key, value);
    const response = await handleBrowserRunnerAction(tracedEnv, form, "https://worker.test", runnerId, "permissions");
    try {
      expect(response.status, JSON.stringify(trace)).toBe(editAllowed ? 303 : 400);
      if (editAllowed) expect(response.headers.get("location")).toBe("/admin/runners/" + runnerId);
      else expect(trace).toEqual([]);
    } finally { await response.body?.cancel(); }
  };
  if (mode === "warm") await submit(workerEnv);
  else {
    const stub = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
    await runInDurableObject(stub, async (_existing, state) => {
      const runner = new RunnerDO(state, env);
      const binding = { idFromName: env.RUNNER.idFromName.bind(env.RUNNER), get: () => ({ fetch: (request: Request) => runner.fetch(request) }) } as unknown as typeof env.RUNNER;
      await submit({ ...workerEnv, RUNNER: binding });
    });
  }
  await expect(runInDurableObject(registry, instance => instance.getRunner(runnerId))).resolves.toMatchObject({
    state: "offline", credential_version: 0, desired_policy_revision: editAllowed ? 2 : 1, policy_status: "offline_pending",
    runner_permissions: { read: true, edit: editAllowed, shell: editAllowed, job_control: editAllowed },
  });
}

it.each(["workspace-create", "workspace-update"] as const)("rejects inconsistent %s permissions before any control-plane request", async action => {
  let calls = 0;
  const unavailable = { idFromName: () => { calls++; throw new Error("unexpected control-plane request"); } };
  const localEnv = { ...env, RUNNER: unavailable, REGISTRY: unavailable } as unknown as typeof env;
  const form = new FormData();
  for (const [key, value] of Object.entries({ workspace_id: "workspace", display_name: "Workspace", root_path: "/workspace",
    profile: "custom", enabled: "true", read: "true", edit: "false", shell: "true", job_control: "true" })) form.set(key, value);
  const response = await handleBrowserRunnerAction(localEnv, form, "https://worker.test", "runner", action);
  try { expect(response.status).toBe(400); expect(calls).toBe(0); }
  finally { await response.body?.cancel(); }
});
