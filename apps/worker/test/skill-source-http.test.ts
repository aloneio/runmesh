import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { CapabilitiesDOv1 } from "../src/capabilities-do.js";
import { handleCentralAdmin } from "../src/http/central.js";
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from "../src/http/constants.js";
import { makeSkillBundle } from "../src/domain/skills/bundle.js";
import { skillSourceUrl } from "../src/contracts/skill-source-values.js";
import { passwordVerifier, randomBase64Url, sha256Hex } from "../src/security.js";
import type { SkillSource } from "../src/contracts/skill-source.js";
import type { WorkerEnv } from "../src/platform/env.js";

const source: SkillSource = { repository: "https://github.com/example/skills", commit: "a".repeat(40), path: "" };
const skillText = "---\nname: imported\ndescription: A fixed source\n---\nRead the source.";
async function bundle(selected = source) {
  return (await makeSkillBundle({ skill_id: "imported", source: skillSourceUrl(selected), license: "",
    files: [{ path: "SKILL.md", text: skillText }] }, sha256Hex))!;
}

async function fixture() {
  const token = randomBase64Url(), csrf = randomBase64Url(), hash = await sha256Hex(token), csrfHash = await sha256Hex(csrf);
  const verifier = await passwordVerifier("source-http-fixture-administrator-password");
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  await runInDurableObject(registry, instance => {
    const now = Date.now(); instance.setupAdmin(verifier, now);
    expect(instance.createAdminSession(hash, csrfHash, now + 60_000, now, 1)).toBe(true);
  });
  const skillSource = vi.fn(async (_hash: string, _action: string, _input: unknown): Promise<unknown> => undefined);
  const inspectConnection = vi.fn(async (_hash: string, _input: unknown, _origin: string): Promise<unknown> => undefined);
  const port = { skillSource, inspectConnection, mutateProfile: vi.fn(), mutateCatalog: vi.fn(), connectionOAuth: vi.fn() };
  const get = vi.fn(() => port);
  const config = { ...env, CENTRAL_SKILLS_ENABLED: "1", CAPABILITIES: { idFromName: () => "central", get } } as unknown as WorkerEnv;
  const headers = { cookie: ADMIN_SESSION_COOKIE + "=" + token + "; " + ADMIN_CSRF_COOKIE + "=" + csrf,
    origin: "https://worker.test", "content-type": "application/json", "x-csrf-token": csrf };
  const request = (action: string, body: unknown = { source, expected_revision: 0 }, overrides: Partial<typeof headers> = {}, method = "POST") => {
    const request = new Request("https://worker.test/admin/central/skill-source/" + action,
      { method, headers: { ...headers, ...overrides }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return handleCentralAdmin(request, config, new URL(request.url));
  };
  const central = (path: string, body: unknown, overrides: Partial<typeof headers> = {}) => {
    const request = new Request("https://worker.test/admin/central/" + path,
      { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
    return handleCentralAdmin(request, config, new URL(request.url));
  };
  return { hash, csrfHash, registry, config, headers, request, central, skillSource, inspectConnection, port, get };
}

it("source HTTP requires the existing administrator session and same-origin CSRF before owner dispatch", async () => {
  const f = await fixture();
  for (const overrides of [{ cookie: "" }, { "x-csrf-token": "incorrect" }, { origin: "https://other.test" }])
    expect((await f.request("preview", undefined, overrides)).status).toBe(403);
  expect((await f.request("preview", undefined, {}, "GET")).status).toBe(400);
  expect((await f.request("preview?extra=1")).status).toBe(400);
  expect((await f.request("other")).status).toBe(400);
  expect(f.get).not.toHaveBeenCalled(); expect(f.skillSource).not.toHaveBeenCalled();
});

it("source HTTP projects verified previews and binds canonical source identity to the request", async () => {
  const f = await fixture(), content = await bundle();
  f.skillSource.mockResolvedValueOnce({ state: "previewed", source, bundle: { ...content, credential: "synthetic-private-value" },
    token: "synthetic-private-value" });
  const response = await f.request("preview", { source: { ...source, repository: source.repository + ".git/" }, expected_revision: 0 });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text(); expect(text).not.toContain("synthetic-private-value");
  expect(JSON.parse(text)).toEqual({ state: "previewed", source, bundle: content });
  expect(f.port.mutateProfile).not.toHaveBeenCalled(); expect(f.port.mutateCatalog).not.toHaveBeenCalled();

  const other = { ...source, path: "other" }, otherBundle = await bundle(other);
  for (const result of [
    { state: "previewed", source: other, bundle: otherBundle },
    { state: "previewed", source, bundle: otherBundle },
    { state: "previewed", source, bundle: { ...content, digest: "f".repeat(64) } },
  ]) {
    f.skillSource.mockResolvedValueOnce(result);
    const invalid = await f.request("preview"); expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({ error: { operation_state: "not_started" } });
  }
  expect(f.skillSource).toHaveBeenCalledTimes(4);
});

it("source HTTP strictly projects installation heads without reflecting owner-only fields", async () => {
  const f = await fixture(), content = await bundle();
  const head = { skill_id: "imported", revision: 5, staged_digest: content.digest, active_digest: content.digest, enabled: true };
  f.skillSource.mockResolvedValueOnce({ state: "written", head: { ...head, token: "synthetic-owner-secret", extra: { credential: "synthetic-owner-secret" } },
    credential: "synthetic-owner-secret" });
  const request = { source, expected_revision: 4, digest: content.digest };
  const response = await f.request("install", request); expect(response.status).toBe(200);
  const text = await response.text(); expect(text).not.toContain("synthetic-owner-secret");
  expect(JSON.parse(text)).toEqual({ state: "written", head });
  for (const change of [{ skill_id: "" }, { skill_id: "invalid/id" }, { revision: 4 }, { revision: 5.5 },
    { enabled: false }, { staged_digest: "f".repeat(64) }, { active_digest: "f".repeat(64) }]) {
    f.skillSource.mockResolvedValueOnce({ state: "written", head: { ...head, ...change } });
    const invalid = await f.request("install", request); expect(invalid.status).toBe(503);
    expect(await invalid.json()).toMatchObject({ error: { operation_state: "unknown" } });
  }
  expect(f.skillSource).toHaveBeenCalledTimes(8);
});

it("source HTTP distinguishes busy, capacity, conflict and unknown outcomes without replay", async () => {
  const f = await fixture(), content = await bundle(), request = { source, expected_revision: 2, digest: content.digest };
  for (const [result, status, code, operationState] of [
    [{ state: "busy" }, 429, "skill_source_busy", "not_started"],
    [{ state: "source_capacity" }, 429, "skill_source_capacity", "not_started"],
    [{ state: "capacity" }, 429, "skill_capacity", "not_started"],
    [{ state: "changed" }, 409, "skill_source_changed", "not_started"],
    [{ state: "unknown" }, 503, "central_result_unconfirmed", "unknown"],
  ] as const) {
    f.skillSource.mockResolvedValueOnce(result);
    const response = await f.request("install", request); expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, operation_state: operationState } });
  }
  f.skillSource.mockResolvedValueOnce({ state: "conflict", current_revision: 3, secret: "synthetic-private-value" });
  const conflict = await f.request("install", request); expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ state: "conflict", current_revision: 3 });
  expect(f.skillSource).toHaveBeenCalledTimes(6);
});

function githubResponse(input: RequestInfo | URL): Response {
  const url = String(input), api = "https://api.github.com/repos/example/skills";
  if (url === api + "/git/commits/" + source.commit) return Response.json({ sha: source.commit, tree: { sha: "b".repeat(40) } });
  if (url === api + "/git/trees/" + "b".repeat(40) + "?recursive=1") return Response.json({ sha: "b".repeat(40), truncated: false,
    tree: [{ path: "SKILL.md", type: "blob", mode: "100644", sha: "c".repeat(40), size: new TextEncoder().encode(skillText).byteLength }] });
  if (url === "https://raw.githubusercontent.com/example/skills/" + source.commit + "/SKILL.md") return new Response(skillText);
  throw new Error("unexpected fixture URL");
}

async function realOwner(f: Awaited<ReturnType<typeof fixture>>) {
  const namespace = (env as unknown as { CAPABILITIES: DurableObjectNamespace<CapabilitiesDOv1> }).CAPABILITIES;
  const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
  let owner!: CapabilitiesDOv1;
  await runInDurableObject(stub, (_instance, state) => { owner = new CapabilitiesDOv1(state, { ...env, CENTRAL_SKILLS_ENABLED: "1" }); });
  const invoke = <T>(operation: (instance: CapabilitiesDOv1) => Promise<T>) => runInDurableObject(stub, () => operation(owner));
  f.skillSource.mockImplementation((hash, action, input) => invoke(instance => instance.skillSource(hash, action as "preview" | "install", input)));
  return { stub, owner, invoke };
}

it("source HTTP previews then installs through the real owner without publishing at preview time", async () => {
  const f = await fixture(), real = await realOwner(f);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async input => githubResponse(input));
  try {
    const preview = await f.request("preview"); expect(preview.status).toBe(200);
    const observed = await preview.json() as { bundle: { digest: string } };
    expect(await real.invoke(instance => instance.listSkillLibrary(f.hash))).toMatchObject({ state: "listed", skills: [] });
    const installed = await f.request("install", { source, expected_revision: 0, digest: observed.bundle.digest }); expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({ state: "written", head: { skill_id: "imported", revision: 1, active_digest: observed.bundle.digest, enabled: true } });
    expect(await real.invoke(instance => instance.listSkillLibrary(f.hash))).toMatchObject({ state: "listed", skills: [{ head: { skill_id: "imported" } }] });
    expect(network).toHaveBeenCalledTimes(6);
  } finally { network.mockRestore(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("source admission bounds each administrator and the owner, then releases slots after success or failure", async () => {
  const f = await fixture(), real = await realOwner(f), hashes = [f.hash, await sha256Hex("second-source-admin"), await sha256Hex("third-source-admin")];
  await runInDurableObject(f.registry, instance => {
    for (const hash of hashes.slice(1)) {
      const now = Date.now(); expect(instance.createAdminSession(hash, f.csrfHash, now + 60_000, now, 1)).toBe(true);
    }
  });
  const entered = [deferred(), deferred()], release = [deferred(), deferred()];
  const running: Promise<unknown>[] = [];
  let commits = 0, failNext = false;
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    if (String(input).includes("/git/commits/")) {
      const index = commits++;
      if (index < 2) { entered[index]!.resolve(); await release[index]!.promise; }
      if (failNext) { failNext = false; return new Response("fixture failure", { status: 500 }); }
    }
    return githubResponse(input);
  });
  try {
    await runInDurableObject(real.stub, async () => {
      const request = { source, expected_revision: 0 };
      const first = real.owner.skillSource(hashes[0]!, "preview", request);
      running.push(first);
      await entered[0]!.promise;
      expect(await real.owner.skillSource(hashes[0]!, "preview", request)).toEqual({ state: "busy" });
      expect(commits).toBe(1);
      const second = real.owner.skillSource(hashes[1]!, "preview", request);
      running.push(second);
      await entered[1]!.promise;
      expect(await real.owner.skillSource(hashes[2]!, "preview", request)).toEqual({ state: "busy" });
      expect(commits).toBe(2);
      release[0]!.resolve(); expect((await first).state).toBe("previewed");
      expect((await real.owner.skillSource(hashes[0]!, "preview", request)).state).toBe("previewed");
      failNext = true;
      expect(await real.owner.skillSource(hashes[0]!, "preview", request)).toEqual({ state: "unavailable" });
      expect((await real.owner.skillSource(hashes[0]!, "preview", request)).state).toBe("previewed");
      release[1]!.resolve(); expect((await second).state).toBe("previewed");
    });
  } finally { release.forEach(gate => gate.resolve()); await Promise.allSettled(running); network.mockRestore(); }
});

it("connection checks project only observed fields and never save, publish or start OAuth", async () => {
  const f = await fixture(), endpoint = "https://docs.example.com/mcp";
  const server = { protocol_version: "2026-07-28", capabilities: { tools: true, resources: true, prompts: false, tasks: false, apps: false } };
  f.inspectConnection.mockResolvedValueOnce({ state: "inspected", endpoint, server: { ...server, instructions: "synthetic-private-value",
    serverInfo: { token: "synthetic-private-value" } }, tools_count: 2, observed_at_ms: 1234, credential: "synthetic-private-value" });
  const response = await f.central("connection-check", { endpoint }); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: "inspected", endpoint, server, tools_count: 2, observed_at_ms: 1234 });
  expect(f.inspectConnection).toHaveBeenCalledWith(f.hash, { endpoint }, "https://worker.test");
  for (const mutate of [f.port.mutateProfile, f.port.mutateCatalog, f.port.connectionOAuth, f.skillSource]) expect(mutate).not.toHaveBeenCalled();
});

it.each([['busy', 429], ['operation_timed_out', 503], ['dependency_unavailable', 503]] as const)("connection check %s keeps its HTTP failure category", async (code, status) => {
  const f = await fixture();
  f.inspectConnection.mockResolvedValueOnce({ state: 'unavailable', code, message: 'PRIVATE_PROVIDER_DETAIL' });
  const response = await f.central('connection-check', { endpoint: 'https://docs.example.com/mcp' });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code: 'remote_' + code, operation_state: 'not_started' } });
  expect(f.inspectConnection).toHaveBeenCalledTimes(1);
  for (const mutate of [f.port.mutateProfile, f.port.mutateCatalog, f.port.connectionOAuth]) expect(mutate).not.toHaveBeenCalled();
});

it("connection checks require CSRF, reject malformed observations and return a minimal authorization-required result", async () => {
  const f = await fixture(), endpoint = "https://docs.example.com/mcp";
  for (const overrides of [{ cookie: "" }, { "x-csrf-token": "incorrect" }, { origin: "https://other.test" }])
    expect((await f.central("connection-check", { endpoint }, overrides)).status).toBe(403);
  expect(f.inspectConnection).not.toHaveBeenCalled();
  f.inspectConnection.mockResolvedValueOnce({ state: "inspected", endpoint,
    server: { protocol_version: "2026-07-28", capabilities: { tools: true, resources: false, prompts: false, tasks: false, apps: false } },
    tools_count: null, observed_at_ms: 1234 });
  expect((await f.central("connection-check", { endpoint })).status).toBe(503);
  f.inspectConnection.mockResolvedValueOnce({ state: "authorization_required", token: "synthetic-private-value", authorization_url: "https://untrusted.example/login" });
  const required = await f.central("connection-check", { endpoint }); expect(required.status).toBe(200);
  expect(await required.json()).toEqual({ state: "authorization_required" });
  f.inspectConnection.mockResolvedValueOnce({ state: "unavailable", code: "synthetic-private-value" });
  const failed = await f.central("connection-check", { endpoint }); expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: { code: "central_unavailable", operation_state: "not_started" } });
  expect(f.inspectConnection).toHaveBeenCalledTimes(3);
  for (const mutate of [f.port.mutateProfile, f.port.mutateCatalog, f.port.connectionOAuth]) expect(mutate).not.toHaveBeenCalled();
});

it("registry HTTP keeps encoded placeholders and declared variables configuration-only without echoing secrets", async () => {
  const f = await fixture();
  const entry = { name: "io.example/docs", version: "1.0.0", remotes: [
    { type: "streamable-http", url: "https://mcp.example.com/mcp" },
    { type: "streamable-http", url: "https://mcp.example.com/%7Bworkspace%7D/mcp" },
    { type: "streamable-http", url: "https://mcp.example.com/%7bworkspace%7d/mcp" },
    { type: "streamable-http", url: "https://mcp.example.com/mcp", variables: { workspace: { default: "synthetic-private-value", isSecret: true } } },
    { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "synthetic-private-value" }] },
  ] };
  const response = await f.central("registry-preview", { entry }); expect(response.status).toBe(200);
  const text = await response.text(); expect(text).not.toContain("synthetic-private-value");
  const result = JSON.parse(text) as { remotes: { mode: string; headers: string[] }[]; digest: string; observed_at_ms: number };
  expect(result.remotes.map(remote => remote.mode)).toEqual(["connect", "configure", "configure", "configure", "configure"]);
  expect(result.remotes[4]!.headers).toEqual(["Authorization"]);
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/u); expect(result.observed_at_ms).toBeGreaterThan(0);
  expect(f.get).not.toHaveBeenCalled(); expect(f.port.mutateProfile).not.toHaveBeenCalled(); expect(f.port.mutateCatalog).not.toHaveBeenCalled();
});
