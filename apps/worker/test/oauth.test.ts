import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type RegisteredClient = { readonly client_id: string; readonly redirect_uris?: readonly string[] };
type TokenResponse = { readonly access_token: string; readonly token_type: string; readonly scope?: string };

const redirectUri = "http://127.0.0.1/callback";
const resource = "https://worker.test/mcp";

/** OAuthProvider owns code/token persistence; this exercises the real Worker endpoints. */
describe("local OAuth authorization-code acceptance", () => {
  it("performs DCR, S256 PKCE, CSRF/password/consent checks, code exchange, and scoped MCP access", async () => {
    const client = await register("oauth-full-matrix");
    const verifier = "verifier-for-full-local-pkce-test-0123456789";
    const challenge = await s256(verifier);
    const state = "state-full-local-matrix";
    const authorize = authorizationUrl(client.client_id, "coding:read coding:exec", state, challenge);

    const form = await SELF.fetch(authorize);
    expect(form.status).toBe(200);
    expect(form.headers.get("content-type")).toContain("text/html");
    const cookie = csrfCookie(form.headers.get("set-cookie"));
    const html = await form.text();
    expect(html).toContain("Owner password");
    expect(html).toContain("coding:read");
    expect(html).toContain("coding:exec");
    expect(html).not.toContain(env.MCP_OWNER_PASSWORD);
    const csrf = hidden(html, "csrf_token");

    const wrongPassword = await submitAuthorization(authorize, cookie, csrf, "wrong-password", "approve");
    expect(wrongPassword.status).toBe(403);
    expect(await wrongPassword.text()).toBe("Authorization denied");

    const denied = await submitAuthorization(authorize, cookie, csrf, env.MCP_OWNER_PASSWORD as string);
    expect(denied.status).toBe(302);
    const deniedLocation = new URL(denied.headers.get("location") as string);
    expect(deniedLocation.origin + deniedLocation.pathname).toBe(redirectUri);
    expect(deniedLocation.searchParams.get("error")).toBe("access_denied");
    expect(deniedLocation.searchParams.get("state")).toBe(state);

    const successfulForm = await SELF.fetch(authorizationUrl(client.client_id, "coding:read coding:exec", state, challenge));
    const successfulCookie = csrfCookie(successfulForm.headers.get("set-cookie"));
    const successfulHtml = await successfulForm.text();
    const successfulCsrf = hidden(successfulHtml, "csrf_token");
    const completed = await submitAuthorization(
      authorizationUrl(client.client_id, "coding:read coding:exec", state, challenge),
      successfulCookie,
      successfulCsrf,
      env.MCP_OWNER_PASSWORD as string,
      "approve",
    );
    expect(completed.status).toBe(302);
    const callback = new URL(completed.headers.get("location") as string);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("error")).toBeNull();
    const code = callback.searchParams.get("code");
    expect(code).toEqual(expect.any(String));

    const token = await exchange(client.client_id, code as string, verifier);
    expect(token.token_type.toLowerCase()).toBe("bearer");
    expect(token.scope).toContain("coding:read");
    expect(token.scope).toContain("coding:exec");

    const listed = await mcp(token.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const listedBody = await readJson(listed) as { result?: { tools?: readonly { name: string }[] } };
    expect(listedBody.result?.tools?.map((tool) => tool.name)).toContain("exec_start");

    const exec = await mcp(token.access_token, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exec_start", arguments: { runner_id: "oauth-no-runner", workspace_id: "workspace-1", command: "echo" } },
    });
    expect(exec.status).toBe(200);
    const execBody = await readJson(exec) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(execBody.result?.isError).toBe(true);
    expect(execBody.result?.structuredContent?.error?.code).toBe("runner_offline");
  });

  it("rejects a missing or mismatched CSRF cookie without attempting a grant", async () => {
    const client = await register("oauth-csrf-matrix");
    const verifier = "verifier-for-csrf-cookie-test-0123456789";
    const challenge = await s256(verifier);
    const authorize = authorizationUrl(client.client_id, "coding:read", "csrf-state", challenge);
    const form = await SELF.fetch(authorize);
    const csrf = hidden(await form.text(), "csrf_token");
    const missingCookie = await submitAuthorization(authorize, "", csrf, env.MCP_OWNER_PASSWORD as string, "approve");
    expect(missingCookie.status).toBe(403);
    const wrongCookie = await submitAuthorization(authorize, `${cookieName()}=wrong`, csrf, env.MCP_OWNER_PASSWORD as string, "approve");
    expect(wrongCookie.status).toBe(403);
  });

  it("issues independently scoped clients and enforces read versus exec scopes", async () => {
    const readClient = await issue("coding:read", "oauth-read-client");
    const execClient = await issue("coding:exec", "oauth-exec-client");

    const readList = await mcp(readClient.access_token, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "runner_list", arguments: {} } });
    expect(readList.status).toBe(200);
    const readExec = await mcp(readClient.access_token, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "exec_start", arguments: { runner_id: "none", workspace_id: "workspace-1", command: "echo" } } });
    const readExecBody = await readJson(readExec) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(readExecBody.result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });

    const execStart = await mcp(execClient.access_token, { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "exec_start", arguments: { runner_id: "none", workspace_id: "workspace-1", command: "echo" } } });
    const execBody = await readJson(execStart) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(execBody.result?.structuredContent?.error?.code).toBe("runner_offline");
  });
});

async function register(name: string): Promise<RegisteredClient> {
  const response = await SELF.fetch("https://worker.test/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  });
  expect(response.status).toBe(201);
  const client = await response.json() as RegisteredClient;
  expect(client.client_id).toEqual(expect.any(String));
  return client;
}

async function issue(scope: string, name: string): Promise<TokenResponse> {
  const client = await register(name);
  const verifier = `verifier-${name}-0123456789abcdef`;
  const challenge = await s256(verifier);
  const authorize = authorizationUrl(client.client_id, scope, `state-${name}`, challenge);
  const form = await SELF.fetch(authorize);
  const cookie = csrfCookie(form.headers.get("set-cookie"));
  const csrf = hidden(await form.text(), "csrf_token");
  const completed = await submitAuthorization(authorize, cookie, csrf, env.MCP_OWNER_PASSWORD as string, "approve");
  expect(completed.status).toBe(302);
  const code = new URL(completed.headers.get("location") as string).searchParams.get("code");
  return exchange(client.client_id, code as string, verifier);
}

function authorizationRequest(clientId: string, scope: string, state: string, challenge: string): URLSearchParams {
  return new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state, code_challenge: challenge, code_challenge_method: "S256", resource });
}

function authorizationUrl(clientId: string, scope: string, state: string, challenge: string): string {
  return `https://worker.test/authorize?${authorizationRequest(clientId, scope, state, challenge).toString()}`;
}

async function submitAuthorization(url: string, cookie: string, csrf: string, password: string, consent?: string): Promise<Response> {
  const form = authorizationRequest(new URL(url).searchParams.get("client_id") as string, new URL(url).searchParams.get("scope") as string, new URL(url).searchParams.get("state") as string, new URL(url).searchParams.get("code_challenge") as string);
  form.set("csrf_token", csrf);
  form.set("password", password);
  if (consent !== undefined) form.set("consent", consent);
  const posted = new URL(url);
  posted.search = "";
  return SELF.fetch(posted.toString(), { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form });
}

async function exchange(clientId: string, code: string, verifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource });
  const response = await SELF.fetch("https://worker.test/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  expect(response.status).toBe(200);
  const token = await response.json() as TokenResponse;
  expect(token.access_token).toEqual(expect.any(String));
  return token;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function csrfCookie(setCookie: string | null): string {
  expect(setCookie).toContain("__Host-mcp_authorize_csrf=");
  return (setCookie as string).split(";", 1)[0] as string;
}
function cookieName(): string { return "__Host-mcp_authorize_csrf"; }
function hidden(html: string, name: string): string {
  const match = new RegExp(`<input[^>]+name="${name}"[^>]+value="([^"]+)"`).exec(html);
  expect(match?.[1]).toEqual(expect.any(String));
  return match?.[1] as string;
}
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as unknown;
  const data = text.split("\n").find((line) => line.trimStart().startsWith("data:"))?.trimStart().slice(5).trim();
  if (data === undefined) throw new Error(`MCP response did not contain data: ${text}`);
  return JSON.parse(data) as unknown;
}
async function mcp(token: string, body: unknown): Promise<Response> {
  return SELF.fetch("https://worker.test/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
}
