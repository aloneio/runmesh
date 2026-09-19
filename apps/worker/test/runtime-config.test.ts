import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { resolveRuntimeConfiguration } from "../src/runtime-config.js";
import { REVIEWED_RELEASE_VERSION } from "../src/generated-release.js";
import worker, { RegistryDOv2, runnerReleaseDescriptor } from "../src/index.js";

function portableEnv() {
  return { ...env, WORKER_ID: undefined, RUNMESH_TEST_MODE: undefined, RUNMESH_ENVIRONMENT: undefined,
    ADMIN_TOKEN: undefined, RUNMESH_PUBLIC_ORIGIN: undefined, RUNMESH_SIGNED_RELEASE_AVAILABLE: undefined,
    RUNMESH_AUDIT_BACKEND: undefined, RUNMESH_JOB_HISTORY_BACKEND: undefined };
}
function request(path: string, host = "portable.customer.workers.dev") {
  return new Request(`https://${host}${path}`, { headers: { host } });
}

it("new production needs only stable server secrets, not owner-specific domains or backend switches", async () => {
  const input = portableEnv(); const resolved = resolveRuntimeConfiguration(input, request("/health"));
  expect(resolved.RUNMESH_PUBLIC_ORIGIN).toBe("https://portable.customer.workers.dev");
  expect(resolved.RUNMESH_SIGNED_RELEASE_AVAILABLE).toBe(REVIEWED_RELEASE_VERSION);
  expect(resolved.RUNMESH_AUDIT_BACKEND).toBe("d1");
  expect(resolved.RUNMESH_JOB_HISTORY_BACKEND).toBe("d1");
  expect(resolved.INTERNAL_CONTROL_SECRET).toBe(input.INTERNAL_CONTROL_SECRET);
  expect(resolved.RUNNER_TOKEN_PEPPER).toBe(input.RUNNER_TOKEN_PEPPER);
  expect(resolved.ADMIN_TOKEN).toBeUndefined();
  expect(input.RUNMESH_PUBLIC_ORIGIN).toBeUndefined();
  const response = await worker.fetch(request("/health"), input, {} as ExecutionContext);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ worker_id: "worker-production", runtime_configuration: { schema: "minimal-v1", manual_public_origin_required: false }, job_history: { backend: "packed_d1" } });
});

it("development selects only the signed dev discovery lane while test, unknown and explicit emergency disables stay closed", () => {
  const development = resolveRuntimeConfiguration({ ...portableEnv(), RUNMESH_ENVIRONMENT: "development" }, request("/"));
  expect(development.RUNMESH_SIGNED_RELEASE_AVAILABLE).toBe("dev");
  expect(runnerReleaseDescriptor(development)).toMatchObject({ channel: "stable", distributable: false });
  for (const extra of [{ RUNMESH_TEST_MODE: "1" }, { WORKER_ID: "worker-test" }, { RUNMESH_SIGNED_RELEASE_AVAILABLE: "" }, { RUNMESH_ENVIRONMENT: "invalid" }]) {
    expect(resolveRuntimeConfiguration({ ...portableEnv(), ...extra }, request("/")).RUNMESH_SIGNED_RELEASE_AVAILABLE).toBe("");
  }
  expect(resolveRuntimeConfiguration({ RUNMESH_SIGNED_RELEASE_AVAILABLE: "wrong-version" }).RUNMESH_SIGNED_RELEASE_AVAILABLE).toBe("wrong-version");
  expect(resolveRuntimeConfiguration({ RUNMESH_PUBLIC_ORIGIN: "" }, request("/")).RUNMESH_PUBLIC_ORIGIN).toBe("");
});

it("malformed authorities, mismatched Host and forwarded headers cannot select a bootstrap origin", () => {
  const input = portableEnv();
  const wrongHost = new Request("https://portable.customer.workers.dev/runner/install.sh", { headers: { host: "attacker.invalid", "x-forwarded-host": "attacker.invalid" } });
  expect(resolveRuntimeConfiguration(input, wrongHost).RUNMESH_PUBLIC_ORIGIN).toBeUndefined();
  const forwarded = new Request("https://portable.customer.workers.dev/runner/install.sh", { headers: { host: "portable.customer.workers.dev", "x-forwarded-host": "attacker.invalid" } });
  expect(resolveRuntimeConfiguration(input, forwarded).RUNMESH_PUBLIC_ORIGIN).toBe("https://portable.customer.workers.dev");
  expect(resolveRuntimeConfiguration(input, new Request("http://localhost:8787/", { headers: { host: "localhost:8787" } })).RUNMESH_PUBLIC_ORIGIN).toBeUndefined();
  expect(resolveRuntimeConfiguration(input, new Request("https://portable.customer.workers.dev/" )).RUNMESH_PUBLIC_ORIGIN).toBeUndefined();
});

it("origin is per request, never cached across custom domains or inferred from an internal DO URL", () => {
  const input = portableEnv();
  expect(resolveRuntimeConfiguration(input, request("/", "one.example.com")).RUNMESH_PUBLIC_ORIGIN).toBe("https://one.example.com");
  expect(resolveRuntimeConfiguration(input, request("/", "two.example.com")).RUNMESH_PUBLIC_ORIGIN).toBe("https://two.example.com");
  expect(resolveRuntimeConfiguration(input).RUNMESH_PUBLIC_ORIGIN).toBeUndefined();
});

it("production losing D1 never silently redirects optional history into core DO writes", () => {
  expect(resolveRuntimeConfiguration({ RUNMESH_ENVIRONMENT: "production" })).toMatchObject({ RUNMESH_AUDIT_BACKEND: "d1", RUNMESH_JOB_HISTORY_BACKEND: "d1" });
  expect(resolveRuntimeConfiguration({ RUNMESH_ENVIRONMENT: "development" })).toMatchObject({ RUNMESH_AUDIT_BACKEND: "sqlite", RUNMESH_JOB_HISTORY_BACKEND: "sqlite" });
  expect(resolveRuntimeConfiguration({ RUNMESH_AUDIT_BACKEND: "sqlite", RUNMESH_JOB_HISTORY_BACKEND: "sqlite", HISTORY_DB: {} })).toMatchObject({ RUNMESH_AUDIT_BACKEND: "sqlite", RUNMESH_JOB_HISTORY_BACKEND: "sqlite" });
});

it("version metadata replaces duplicated text vars without inventing branch or commit", () => {
  expect(resolveRuntimeConfiguration({ CF_VERSION_METADATA: { tag: `main:${"a".repeat(40)}` } })).toMatchObject({ RUNMESH_DEPLOYMENT_BRANCH: "main", RUNMESH_DEPLOYMENT_COMMIT: "a".repeat(40) });
  for (const tag of ["", "v0.1.3", "feature:a", "main:bad"]) expect(resolveRuntimeConfiguration({ CF_VERSION_METADATA: { tag } }).RUNMESH_DEPLOYMENT_COMMIT).toBeUndefined();
});

it("configuration lookup creates no database reads or background work", () => {
  const prepare = vi.fn(() => { throw new Error("no storage allowed"); });
  for (let i = 0; i < 1000; i++) resolveRuntimeConfiguration({ HISTORY_DB: { prepare } }, request("/health"));
  expect(prepare).not.toHaveBeenCalled();
});

it("minimal production can present browser setup without an ADMIN_TOKEN", async () => {
  const input = portableEnv();
  const id = env.REGISTRY.idFromName(`minimal-setup-${crypto.randomUUID()}`); const registry = env.REGISTRY.get(id);
  const scope = { ...input, REGISTRY: { idFromName: () => id, get: () => registry } } as unknown as typeof env;
  const response = await worker.fetch(request("/setup"), scope, {} as ExecutionContext);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("__Host-runmesh_setup_csrf");
  await runInDurableObject(registry, (instance) => { expect(instance.getRunner("does-not-exist")).toBeUndefined(); });
});

it("minimal Registry construction initializes both optional history clients and preserves existing data", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`minimal-constructor-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    instance.registerRunner("preserved", "synthetic-verifier", Date.now(), undefined, "dedicated_user");
    const before = instance.getRunnerExecutionState("preserved");
    const next = new RegistryDOv2(state, portableEnv());
    expect(next.getRunnerExecutionState("preserved")).toEqual(before);
    const clients = next as unknown as { packedJobs?: unknown; externalAudit?: unknown };
    expect(clients.packedJobs).toBeDefined();
    expect(clients.externalAudit).toBeDefined();
  });
});
