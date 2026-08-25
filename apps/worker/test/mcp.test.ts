import { env, SELF } from "cloudflare:test";
import { resolveConfiguredStaticToken } from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("authenticated stateless MCP endpoint", () => {
  it("does not accept a static token when its explicit configuration is absent", () => {
    expect(resolveConfiguredStaticToken("test-mcp-static-token-not-for-production", undefined)).toBeNull();
    expect(resolveConfiguredStaticToken("wrong", "test-mcp-static-token-not-for-production")).toBeNull();
  });

  it("rejects unauthenticated calls with discovery challenge", async () => {
    const response = await SELF.fetch("https://worker.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("publishes OAuth discovery and compatibility registration endpoints", async () => {
    const metadata = await SELF.fetch("https://worker.test/.well-known/oauth-authorization-server");
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({ authorization_endpoint: "https://worker.test/authorize", token_endpoint: "https://worker.test/oauth/token", registration_endpoint: "https://worker.test/oauth/register" });
    const registration = await SELF.fetch("https://worker.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "test-client", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    });
    expect(registration.status).toBe(201);
    await expect(registration.json()).resolves.toMatchObject({ client_id: expect.any(String) });
  });
  it("uses the fenced static-token lane to initialize and list the exact catalog", async () => {
    const initialize = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(initialize.status).toBe(200);
    const initialized = await readMcp(initialize) as { result?: { protocolVersion?: string } };
    expect(initialized.result?.protocolVersion).toBeDefined();

    const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const body = await readMcp(listed) as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual([
      "runner_list", "runner_info", "workspace_list", "env_info", "fs_read", "fs_list", "fs_search", "fs_apply_patch",
      "exec_start", "exec_run", "job_get", "job_logs", "job_cancel", "job_input", "git_status", "git_diff",
    ]);
    const runners = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "runner_list", arguments: {} } });
    expect(runners.status).toBe(200);
    const runnerBody = await readMcp(runners) as { result?: { structuredContent?: { runners?: unknown[] } } };
    expect(runnerBody.result?.structuredContent?.runners).toEqual(expect.any(Array));
  });

  it("publishes truthful annotations, an object output schema, and structured result objects", async () => {
    const listed = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    const body = await readMcp(listed) as { result?: { tools?: { name: string; annotations?: Record<string, unknown>; outputSchema?: unknown }[] } };
    const tools = new Map(body.result?.tools?.map((tool) => [tool.name, tool]) ?? []);
    expect(tools.get("exec_start")).toMatchObject({ annotations: { openWorldHint: true, destructiveHint: false }, outputSchema: { type: "object" } });
    expect(tools.get("fs_apply_patch")).toMatchObject({ annotations: { destructiveHint: true } });
    expect(tools.get("job_cancel")).toMatchObject({ annotations: { destructiveHint: true } });
    const runners = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "runner_list", arguments: {} } });
    const result = await readMcp(runners) as { result?: { structuredContent?: unknown } };
    expect(typeof result.result?.structuredContent).toBe("object");
    expect(Array.isArray(result.result?.structuredContent)).toBe(false);
  });

  it("returns a structured runner_offline error from runner live-tool path", async () => {
    const response = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "env_info", arguments: { runner_id: "offline-runner" } } });
    expect(response.status).toBe(200);
    const body = await readMcp(response) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent?.error?.code).toBe("runner_offline");
  });

  async function readMcp(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as unknown;
    const data = text.split("\n").find((line) => line.trimStart().startsWith("data:"))?.trimStart().slice(5).trim();
    return data === undefined ? undefined : JSON.parse(data) as unknown;
  }

  async function mcp(body: unknown): Promise<Response> {
    return SELF.fetch("https://worker.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${env.MCP_STATIC_TOKEN}` },
      body: JSON.stringify(body),
    });
  }
});
