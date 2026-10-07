import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { SkillCleanupPlan, SkillLifecycleAction, SkillLifecycleResult, SkillVersionHistory } from "../src/contracts/skill-lifecycle.js";
import type { WorkerEnv } from "../src/platform/env.js";

async function fixture() {
  const token = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(token), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("skill-lifecycle-http-fixture-password");
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  await runInDurableObject(registry, instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  const configured: WorkerEnv = { ...env, CENTRAL_SKILLS_ENABLED: "1" };
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
  let owner!: CapabilitiesDOv1;
  await runInDurableObject(stub, (_instance, state) => { owner = new CapabilitiesDOv1(state, configured); });
  const invoke = <T>(operation: (instance: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => operation(owner));
  const port = { skillLifecycle: (sessionHash: string, id: string, action: SkillLifecycleAction, input: unknown): Promise<SkillLifecycleResult> =>
    invoke(instance => instance.skillLifecycle(sessionHash, id, action, input)) };
  const config = { ...configured, CAPABILITIES: { idFromName: () => "central", get: () => port } } as unknown as WorkerEnv;
  const headers = { cookie: ADMIN_SESSION_COOKIE + "=" + token + "; " + ADMIN_CSRF_COOKIE + "=" + csrf,
    origin: "https://worker.test", "content-type": "application/json", "x-csrf-token": csrf };
  const request = (path: string, body?: unknown, override: Partial<typeof headers> = {}) => {
    const value = new Request("https://worker.test/admin/central/skills/maintenance/" + path,
      { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...override }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return handleCentralAdmin(value, config, new URL(value.url));
  };
  const install = (index: number) => invoke(instance => instance.installSkill(hash, { expected_revision: index,
    files: [{ path: "SKILL.md", text: "---\nname: maintenance\ndescription: Skill maintenance\n---\nVersion " + index }] }));
  return { request, install, port, invoke, hash };
}

it("the administrator HTTP flow lists, compares, retains, previews and cleans exact Skill versions", async () => {
  const f = await fixture(), first = await f.install(0), second = await f.install(1);
  expect(first.state).toBe("written"); expect(second.state).toBe("written");
  if (first.state !== "written" || second.state !== "written") throw new Error("fixture installation failed");
  const old = first.head.staged_digest, current = second.head.staged_digest;
  const response = await f.request("versions"); expect(response.status).toBe(200);
  const text = await response.text(), history = JSON.parse(text) as SkillVersionHistory;
  expect(text).not.toContain("Version 0"); expect(history.capacity.skill_versions).toBe(2);
  expect(history.head.revision).toBe(2);
  const comparison = await f.request("compare", { before: old, after: current }); expect(comparison.status).toBe(200);
  expect(await comparison.json()).toMatchObject({ state: "compared", files: [{ path: "SKILL.md", change: "modified", truncated: false }] });
  const retained = await f.request("retention", { digest: old, pinned: true, expected_revision: 2 }); expect(retained.status).toBe(200);
  expect(await retained.json()).toMatchObject({ state: "retained", head: { revision: 3 }, digest: old, pinned: true });
  expect((await f.request("cleanup-preview", { digests: [old], expected_revision: 3 })).status).toBe(409);
  expect((await f.request("retention", { digest: old, pinned: false, expected_revision: 3 })).status).toBe(200);
  const preview = await f.request("cleanup-preview", { digests: [old], expected_revision: 4 }); expect(preview.status).toBe(200);
  const { plan } = await preview.json() as { plan: SkillCleanupPlan };
  const command = { fingerprint: plan.fingerprint, expected_revision: 4, confirm: true };
  const cleaned = await f.request("cleanup", command); expect(cleaned.status).toBe(200);
  expect(await cleaned.json()).toMatchObject({ state: "cleaned", head: { revision: 5 }, deleted_digests: [old], capacity: { skill_versions: 1 } });
  expect((await f.request("cleanup", command)).status).toBe(409);
  expect((await f.request("compare", { before: old, after: current })).status).toBe(404);
});

it("Skill lifecycle endpoints require the existing administrator session, same-origin CSRF and exact path contract", async () => {
  const f = await fixture(); await f.install(0);
  expect((await f.request("versions", undefined, { cookie: "" })).status).toBe(403);
  expect((await f.request("retention", { digest: "a".repeat(64), pinned: true, expected_revision: 1 }, { "x-csrf-token": "wrong" })).status).toBe(403);
  expect((await f.request("cleanup-preview", { digests: ["a".repeat(64)], expected_revision: 1 }, { origin: "https://other.test" })).status).toBe(403);
  expect((await f.request("versions?after=unbounded")).status).toBe(400);
  expect((await f.request("versions", {})).status).toBe(400);
  expect((await f.request("cleanup")).status).toBe(400);
  expect((await f.request("cleanup", { fingerprint: "a".repeat(64), expected_revision: 1, confirm: false })).status).toBe(400);
  const history = await (await f.request("versions")).json() as SkillVersionHistory;
  expect(history.head.revision).toBe(1);
});

it("the HTTP boundary rejects incomplete or mismatched lifecycle receipts without reporting a mutation as confirmed", async () => {
  const f = await fixture(); await f.install(0);
  const history = await (await f.request("versions")).json() as SkillVersionHistory;
  f.port.skillLifecycle = async () => ({ ...history, versions: [] });
  expect((await f.request("versions")).status).toBe(503);
  f.port.skillLifecycle = async () => ({ state: "retained", head: history.head, digest: history.head.staged_digest, pinned: true });
  const failed = await f.request("retention", { digest: history.head.staged_digest, pinned: true, expected_revision: 1 });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ error: { operation_state: "unknown" } });
  f.port.skillLifecycle = async () => ({ state: "unknown" });
  const unknown = await f.request("cleanup", { fingerprint: "a".repeat(64), expected_revision: 1, confirm: true });
  expect(await unknown.json()).toMatchObject({ error: { code: "skill_lifecycle_unknown", operation_state: "unknown" } });
});
