import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { internalHeaders, runnerTokenVerifier } from "../src/security.js";

const secret = "test-internal-control-secret-not-for-production";
const token = "synthetic-runner-token-for-outage-tests";

it.each(["heartbeat-update", "heartbeat-read", "session", "auth", "nonce"])("returns retryable 503 instead of a false credential rejection on %s storage failure", async (boundary) => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`outage-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), runner = "outage-runner", session = "outage-session";
    const verifier = await runnerTokenVerifier(token, "test-runner-token-pepper-not-for-production");
    expect(instance.registerRunner(runner, verifier, now, undefined, "dedicated_user")).toBe(true);
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = ?, last_heartbeat_ms = ? WHERE runner_id = ?", session, now, runner);
    const identity = { epoch: fence.runner.connection_epoch, credential_version: fence.runner.credential_version, lifecycle_id: fence.lifecycle_id, session_id: session, now_ms: boundary === "heartbeat-update" ? now + 1 : now, require_online: true };
    const action = boundary.startsWith("heartbeat") ? "heartbeat" : boundary === "session" ? "session" : "auth";
    const path = `/runners/${runner}/${action}`;
    const body = JSON.stringify(action === "auth" ? { token } : identity);
    const request = async () => new Request(`https://registry.internal${path}`, { method: "POST", headers: await internalHeaders(secret, "POST", path, body), body });
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const fault = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql: string, ...args: any[]) => {
      const matches = boundary === "heartbeat-update" ? sql.startsWith("UPDATE runners SET state = 'online'")
        : boundary === "heartbeat-read" || boundary === "session" ? sql.startsWith("SELECT connection_epoch")
        : boundary === "nonce" ? sql.startsWith("INSERT INTO internal_request_nonces") : sql.startsWith("SELECT token_verifier");
      if (matches) throw new Error("PRIVATE_STORAGE_SENTINEL: quota exceeded");
      return original(sql, ...args);
    });
    try {
      const response = await instance.fetch(await request());
      expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("30");
      const text = await response.text(); expect(text).toContain("control_plane_unavailable"); expect(text).not.toContain("PRIVATE_STORAGE_SENTINEL");
    } finally { fault.mockRestore(); }
    // Recovery uses the same stored credential/session, with no re-enrollment.
    const recovered = await instance.fetch(await request()); expect(recovered.status).toBe(action === "auth" ? 200 : 204);
  });
});

it("continues rejecting true stale sessions and invalid credentials after the availability fix", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`outage-fences-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now(), runner = "fenced-runner";
    instance.registerRunner(runner, await runnerTokenVerifier(token, "test-runner-token-pepper-not-for-production"), now, undefined, "dedicated_user");
    const fence = instance.getRunnerExecutionState(runner)!;
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = 'current-session', last_heartbeat_ms = ? WHERE runner_id = ?", now, runner);
    for (const action of ["heartbeat", "session"]) {
      const path = `/runners/${runner}/${action}`;
      const body = JSON.stringify({ epoch: fence.runner.connection_epoch, credential_version: fence.runner.credential_version, lifecycle_id: fence.lifecycle_id, session_id: "stale-session", now_ms: now + 1 });
      const response = await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers: await internalHeaders(secret, "POST", path, body), body }));
      expect(response.status).toBe(409);
    }
    const path = `/runners/${runner}/auth`, body = JSON.stringify({ token: "definitely-invalid-credential" });
    expect((await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers: await internalHeaders(secret, "POST", path, body), body }))).status).toBe(401);
  });
});

it("distinguishes nonce replay from storage failure without scanning all nonce rows", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`outage-nonces-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now(), nonce = "a".repeat(64);
    const sql = vi.spyOn(state.storage.sql, "exec");
    try {
      expect(instance.consumeInternalNonce(nonce, now + 60000, now)).toBe(true);
      expect(instance.consumeInternalNonce(nonce, now + 60000, now)).toBe(false);
      expect(sql.mock.calls.every(([query]) => !query.startsWith("DELETE"))).toBe(true);
      expect(instance.consumeInternalNonce(nonce, now + 120000, now + 60001)).toBe(true);
    } finally { sql.mockRestore(); }
  });
});


it.each(["client-create", "client-rotate", "runner-add", "enrollment", "permissions"])("does not disguise %s SQL failure as a conflict or missing record", async (boundary) => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`mutation-outage-${crypto.randomUUID()}`));
  await runInDurableObject(stub, (instance, state) => {
    const now = Date.now();
    instance.registerRunner("r", "a".repeat(64), now, undefined, "dedicated_user");
    const client = { client_id: "c", label: "test", secret_verifier: "b".repeat(64), secret_prefix: "test", scopes: ["coding:read"] as const };
    instance.createMcpClient(client, now);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      if (/INSERT INTO mcp_clients|UPDATE mcp_clients SET secret_verifier|INSERT INTO runners|INSERT INTO runner_enrollments|UPDATE runners SET runner_permissions_json/.test(query)) throw new Error("daily rows_read limit exceeded");
      return original(query, ...args);
    });
    try {
      const operation = () => boundary === "client-create" ? instance.createMcpClient({...client, client_id:"new"}, now)
        : boundary === "client-rotate" ? instance.rotateMcpClient("c", "d".repeat(64), "next", now)
        : boundary === "runner-add" ? instance.addRunner("new-runner","test",now,undefined,"dedicated_user")
        : boundary === "enrollment" ? instance.createRunnerEnrollment("r", "z".repeat(43), "e".repeat(64), now)
        : instance.setRunnerPermissions("r", {read:true,edit:false,shell:false,job_control:false}, now);
      expect(operation).toThrow("daily rows_read limit exceeded");
    } finally { sql.mockRestore(); }
    expect(instance.getMcpClient("c")?.secret_version).toBe(1);
  });
});


it("authorization-only request replays recheck live credentials without allocating nonce rows", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`auth-query-cost-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now();
    instance.createMcpClient({ client_id: "c", label: "test", secret_verifier: "c".repeat(64), secret_prefix: "test", scopes: ["coding:read"] }, now);
    instance.verifyMcpClient("c".repeat(64), now);
    const queries = [
      ["/auth/mcp/verify", { secret_verifier: "c".repeat(64) }],
      ["/auth/mcp/revalidate", { client_id: "c", secret_version: 1 }],
      ["/auth/mcp/authorize-rpc", { client_id: "c", secret_version: 1, runner_id: "missing", method: "job.get", job_id: "j", workspace_id: "w" }],
      ["/runners/missing/mcp-authorization", { client_id: "c", secret_version: 1, method: "job.get", job_id: "j", workspace_id: "w" }],
    ] as const;
    const spy = vi.spyOn(state.storage.sql, "exec");
    try {
      for (const [path, input] of queries) {
        const body = JSON.stringify(input);
        const request = new Request(`https://registry.internal${path}`, { method: "POST", body, headers: await internalHeaders(secret, "POST", path, body) });
        const expected = path.endsWith("verify") || path.endsWith("revalidate") ? 200 : 403;
        expect((await instance.fetch(request.clone())).status).toBe(expected);
        expect((await instance.fetch(request.clone())).status).toBe(expected);
        // Missing all proof headers must remain fail-closed.
        expect((await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body }))).status).toBe(404);
      }
      expect(spy.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO internal_request_nonces"))).toBe(false);
    } finally { spy.mockRestore(); }
    const path = "/auth/mcp/revalidate", body = JSON.stringify({client_id:"c",secret_version:1});
    const request = new Request(`https://registry.internal${path}`, {method:"POST",body,headers:await internalHeaders(secret,"POST",path,body)});
    expect((await instance.fetch(request.clone())).status).toBe(200);
    instance.revokeMcpClient("c", now + 1);
    expect((await instance.fetch(request.clone())).status).toBe(404);
    // True mutation replay fencing is unchanged.
    const nonce = "d".repeat(64);
    expect(instance.consumeInternalNonce(nonce, now + 60000, now)).toBe(true);
    expect(instance.consumeInternalNonce(nonce, now + 60000, now)).toBe(false);
  });
});

it("persists the verified development release descriptor behind the authenticated Registry boundary", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`dev-release-cache-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance) => {
    const path = "/distribution/dev-runner-release";
    const descriptor = { channel: "dev", distributable: true, package_version: "0.1.4-dev.0" };
    const newer = { schema_version: 1, verified_at_ms: Date.now(), descriptor };
    const newerBody = JSON.stringify(newer);
    const write = new Request(`https://registry.internal${path}`, { method: "POST", body: newerBody, headers: await internalHeaders(secret, "POST", path, newerBody) });
    expect((await instance.fetch(write)).status).toBe(204);

    const readHeaders = await internalHeaders(secret, "GET", path, "");
    const read = await instance.fetch(new Request(`https://registry.internal${path}`, { headers: readHeaders }));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual(newer);

    const older = { ...newer, verified_at_ms: newer.verified_at_ms - 1_000, descriptor: { ...descriptor, package_version: "0.1.4-dev.99" } };
    const olderBody = JSON.stringify(older);
    expect((await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body: olderBody, headers: await internalHeaders(secret, "POST", path, olderBody) }))).status).toBe(204);
    const equalTimestamp = { ...newer, descriptor: { ...descriptor, package_version: "0.1.4-dev.98" } };
    const equalBody = JSON.stringify(equalTimestamp);
    expect((await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body: equalBody, headers: await internalHeaders(secret, "POST", path, equalBody) }))).status).toBe(204);
    const afterOlder = await instance.fetch(new Request(`https://registry.internal${path}`, { headers: await internalHeaders(secret, "GET", path, "") }));
    expect(await afterOlder.json()).toEqual(newer);

    const invalidBody = JSON.stringify({ schema_version: 1, verified_at_ms: Date.now(), descriptor: null });
    expect((await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body: invalidBody, headers: await internalHeaders(secret, "POST", path, invalidBody) }))).status).toBe(400);
    expect((await instance.fetch(new Request(`https://registry.internal${path}`))).status).toBe(404);
  });
});
