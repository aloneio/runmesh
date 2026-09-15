import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { randomBase64Url, sha256Hex } from "../src/security.js";
import { catalogContract, MCP_CATALOG_SUMMARY } from "../src/mcp/catalog-contract.js";

type Tool = { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: unknown;
  annotations?: unknown; _meta?: Record<string, unknown> };

async function emittedTools(): Promise<Tool[]> {
  const secret = randomBase64Url();
  const verifier = await sha256Hex(secret);
  const clientId = `catalog-${crypto.randomUUID()}`;
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  await runInDurableObject(registry, instance => {
    expect(instance.createMcpClient({ client_id: clientId, label: "Isolated catalog regression", secret_verifier: verifier,
      secret_prefix: "test-only", scopes: ["coding:read"] }, Date.now())).toBeDefined();
  });
  try {
    const response = await SELF.fetch(`https://worker.test/${secret}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "catalog-check", method: "tools/list", params: {} }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.replaceAll("\r\n", "\n").split("\n\n").flatMap(event => {
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        return data ? [JSON.parse(data)] : [];
      }) : [JSON.parse(text)];
    const reply = messages.find(message => message.id === "catalog-check");
    expect(reply?.error).toBeUndefined();
    expect(reply?.result?.nextCursor).toBeUndefined();
    expect(Array.isArray(reply?.result?.tools)).toBe(true);
    return reply.result.tools as Tool[];
  } finally {
    await runInDurableObject(registry, instance => { instance.revokeMcpClient(clientId, Date.now()); });
  }
}

function withoutDialect(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return schema;
  const { $schema: _dialect, ...value } = schema as Record<string, unknown>;
  return value;
}

it("emits the complete source catalog through the authenticated HTTP MCP adapter", async () => {
  const actual = await emittedTools();
  const expected = catalogContract().tools;
  expect(actual.map(tool => tool.name).sort()).toEqual(expected.map(tool => tool.name).sort());
  for (const tool of expected) {
    const emitted = actual.find(candidate => candidate.name === tool.name)!;
    expect(emitted.description, tool.name).toBe(tool.description);
    expect(withoutDialect(emitted.inputSchema), tool.name).toEqual(withoutDialect(tool.inputSchema));
    expect(withoutDialect(emitted.outputSchema), tool.name).toEqual(withoutDialect(tool.outputSchema));
    expect(emitted.annotations, tool.name).toEqual(tool.annotations);
    expect(emitted._meta?.["io.runmesh/catalog"]).toEqual({ schema_version: 1, sha256: MCP_CATALOG_SUMMARY.sha256 });
  }
});

it("does not lose workspace_id on any Job action during SDK schema export", async () => {
  const tools = await emittedTools();
  const job = tools.find(tool => tool.name === "job")!;
  const branches = (job.inputSchema.oneOf ?? job.inputSchema.anyOf) as Array<{
    properties: Record<string, { const?: string; type?: string }>;
    required: string[]; additionalProperties: boolean;
  }>;
  for (const action of ["get", "logs", "cancel", "input"]) {
    const branch = branches.find(value => value.properties.action?.const === action)!;
    expect(branch, action).toBeDefined();
    expect(branch.properties.workspace_id, action).toMatchObject({ type: "string" });
    expect(branch.required, action).not.toContain("workspace_id");
    expect(branch.additionalProperties, action).toBe(false);
  }
});
