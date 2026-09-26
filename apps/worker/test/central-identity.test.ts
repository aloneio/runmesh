import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { internalHeaders, randomBase64Url, sha256Hex } from "../src/security.js";
import { projectReauthorization } from "../src/mcp/reauthorization.js";
import { verifyMcpClient } from "../src/application/mcp-identity.js";

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
async function request(path: string, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  return registry().fetch(new Request(`https://registry.internal${path}`, { method: "POST", body,
    headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body) }));
}
async function create(native_scopes: string[] = []) {
  const secret = randomBase64Url(), client_id = `central-${crypto.randomUUID()}`;
  const secret_verifier = await sha256Hex(secret);
  const response = await request("/auth/clients", { identity_version: 2, client_id, label: "Central identity regression",
    secret_verifier, secret_prefix: "test-only", native_scopes });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ schema_version: 2, client_id, label: "Central identity regression", secret_version: 1, native_scopes });
  return { secret, client_id, secret_verifier };
}
async function rpc(secret: string, method: string, params: unknown) {
  const response = await SELF.fetch(`https://worker.test/${secret}/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "central-test", method, params }) });
  expect(response.status).toBe(200);
  const text = await response.text();
  const replies = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.replaceAll("\r\n", "\n").split("\n\n").flatMap(event => {
      const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      return data ? [JSON.parse(data)] : [];
    }) : [JSON.parse(text)];
  return replies.find(reply => reply.id === "central-test");
}

it("W02 accepts central-only identity at the real HTTP boundary without any Runner", async () => {
  const client = await create();
  expect(await verifyMcpClient(env, client.secret_verifier)).toMatchObject({ client_id: client.client_id, scopes: [] });
  const listed = await rpc(client.secret, "tools/list", {});
  expect(listed.error).toBeUndefined();
  expect(listed.result.tools).toHaveLength(0);
  for (const [name, args] of [
    ["read", { workspace_id: "not-configured", path: "README.md" }],
    ["shell", { workspace_id: "not-configured", command: "echo never-dispatched" }],
  ] as const) {
    const reply = await rpc(client.secret, "tools/call", { name, arguments: args });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.structuredContent.error.code).toBe("insufficient_scope");
  }
  await runInDurableObject(registry(), instance => {
    expect(instance.effectiveWorkspaceList(client.client_id, "absent")).toBeUndefined();
    expect(instance.revalidateMcpClient(client.client_id, 1)).toBeUndefined();
  });
});

it("W02 keeps legacy admission nonempty and offers explicit versioned revalidation", async () => {
  const client = await create();
  expect((await request("/auth/mcp/verify", { secret_verifier: client.secret_verifier })).status).toBe(404);
  const current = await request("/auth/mcp/revalidate", { ...client, secret_version: 1, identity_version: 2 });
  expect(current.status).toBe(200);
  expect(projectReauthorization(await current.json(), { client_id: client.client_id, secret_version: 1 })).toEqual({ state: "allowed", scopes: [] });
  expect((await request("/auth/mcp/revalidate", { client_id: client.client_id, secret_version: 1, identity_version: 3 })).status).toBe(400);
});

it("W02 mixed identities preserve native scopes without granting central capabilities", async () => {
  const client = await create(["coding:read"]);
  expect(await verifyMcpClient(env, client.secret_verifier)).toEqual({ client_id: client.client_id,
    label: "Central identity regression", secret_version: 1, scopes: ["coding:read"] });
  const reply = await rpc(client.secret, "tools/call", { name: "shell", arguments: { workspace_id: "none", command: "echo denied" } });
  expect(reply.result.structuredContent.error.code).toBe("insufficient_scope");
});

it("W02 rotation and revocation fence versioned identities and their old credentials", async () => {
  const client = await create();
  await runInDurableObject(registry(), instance => {
    instance.rotateMcpClient(client.client_id, "a".repeat(64), "test-rotated", Date.now());
  });
  expect(await verifyMcpClient(env, client.secret_verifier)).toBeUndefined();
  expect((await request("/auth/mcp/revalidate", { client_id: client.client_id, secret_version: 1, identity_version: 2 })).status).toBe(404);
  expect((await request("/auth/mcp/revalidate", { client_id: client.client_id, secret_version: 2, identity_version: 2 })).status).toBe(200);
  await runInDurableObject(registry(), instance => { instance.revokeMcpClient(client.client_id, Date.now()); });
  expect((await request("/auth/mcp/revalidate", { client_id: client.client_id, secret_version: 2, identity_version: 2 })).status).toBe(404);
});

it.each(["[]", '"bad"', '{"schema_version":3,"native_scopes":[]}', '{"schema_version":2,"native_scopes":["admin"]}'])(
  "W02 malformed storage is not interpreted as an empty valid identity: %s", async encoded => {
    const client = await create();
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE mcp_clients SET scopes_json = ? WHERE client_id = ?", encoded, client.client_id);
    });
    expect(await verifyMcpClient(env, client.secret_verifier)).toBeUndefined();
    expect((await request("/auth/mcp/revalidate", { client_id: client.client_id, secret_version: 1, identity_version: 2 })).status).toBe(404);
  });

it("W02 unknown or conflicting identity representations never downgrade silently", () => {
  const expected = { client_id: "client-test", secret_version: 1 };
  expect(projectReauthorization({ ...expected, schema_version: 3, scopes: ["coding:exec"] }, expected)).toEqual({ state: "malformed" });
  expect(projectReauthorization({ ...expected, schema_version: 2, label: "Test", native_scopes: [], scopes: ["coding:exec"] }, expected)).toEqual({ state: "allowed", scopes: [] });
  expect(projectReauthorization({ ...expected, schema_version: 2, label: "Test", native_scopes: [], secret_version: 2 }, expected)).toEqual({ state: "denied" });
});
