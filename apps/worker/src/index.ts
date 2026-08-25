import { AuthorizationError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { createCodingMcpServer, MCP_SUPPORTED_SCOPES, type McpAuth } from "./mcp/server.js";
import { RegistryDO } from "./registry.js";
import { RunnerDO, type WorkerEnv } from "./runner-do.js";
import {
  bearerToken,
  constantTimeEqual,
  generateRunnerToken,
  internalHeaders,
  isSafeIdentifier,
  runnerTokenVerifier,
  verifyInternalRequest,
} from "./security.js";

export { RegistryDO, RunnerDO };

const MAX_ADMIN_BODY_BYTES = 16_384;
const MAX_AUTH_FORM_BYTES = 16_384;
const OWNER_ID = "mcp-owner";
const CSRF_COOKIE = "__Host-mcp_authorize_csrf";

/**
 * The provider owns OAuth 2.1, PKCE, metadata, DCR, and optional CIMD. Only
 * `/mcp` is protected here; the existing runner/admin/health routes remain in
 * the default handler with their original authorization controls.
 */
const oauth = new OAuthProvider<WorkerEnv>({
  apiHandlers: { "/mcp": { fetch: handleMcp } },
  defaultHandler: { fetch: handleDefault },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [...MCP_SUPPORTED_SCOPES],
  resourceMetadata: {
    scopes_supported: [...MCP_SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Remote coding runtime MCP",
  },
  // CIMD is preferred by current MCP clients. DCR remains as a compatibility
  // fallback for clients that have not implemented CIMD yet.
  clientIdMetadataDocumentEnabled: true,
  // Fenced compatibility lane: it is unavailable unless an operator supplies
  // MCP_STATIC_TOKEN (e.g. local Vitest/Miniflare development). It still goes
  // through OAuthProvider and yields a full scoped auth context for MCP.
  resolveExternalToken: async ({ token, env }) => resolveConfiguredStaticToken(token, env.MCP_STATIC_TOKEN),
});

export function resolveConfiguredStaticToken(token: string, configuredToken: string | undefined): { props: Record<string, unknown> } | null {
  if (configuredToken === undefined || configuredToken.length === 0 || !constantTimeEqual(token, configuredToken)) return null;
  return { props: { user_id: "static-test", client_id: "static-test", scopes: [...MCP_SUPPORTED_SCOPES], static_test_token: true } };
}

export default oauth;

async function handleMcp(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
  const props = safeProps((ctx as ExecutionContext & { props?: unknown }).props);
  const token = bearerToken(request) ?? "";
  const scopes = Array.isArray(props.scopes) ? props.scopes.filter((scope): scope is string => typeof scope === "string" && (MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope)) : [];
  // OAuthProvider has already validated this token. The explicit AuthInfo is
  // passed to the SDK v2 handler so every tool receives standard scope metadata.
  const auth: McpAuth = {
    token,
    clientId: typeof props.client_id === "string" ? props.client_id : typeof props.user_id === "string" ? props.user_id : "oauth-client",
    scopes,
    props,
  };
  const handler = createMcpHandler(
    () => createCodingMcpServer(env, auth),
    { route: "/mcp", authContext: { props }, legacy: "stateless" },
  );
  return handler.fetch(request, { authInfo: auth });
}

async function handleDefault(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/authorize") return handleAuthorization(request, env);
  if (url.pathname === "/health") return Response.json({ ok: true, service: "remote-coding-runtime-worker" });
  if (url.pathname.startsWith("/internal/runners/")) return forwardRunnerRpc(request, env, url);
  if (url.pathname.startsWith("/admin/runners")) return handleAdmin(request, env, url);
  if (url.pathname === "/runner/connect") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const runnerId = url.searchParams.get("runner_id");
    if (runnerId === null || !isSafeIdentifier(runnerId)) return new Response("invalid runner_id", { status: 400 });
    const target = new URL(request.url);
    target.pathname = `/runner/${encodeURIComponent(runnerId)}`;
    target.search = "";
    return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request(target, request));
  }
  return new Response("Not found", { status: 404 });
}

/** GET renders a password + explicit consent form; POST is the only grant path. */
async function handleAuthorization(request: Request, env: WorkerEnv): Promise<Response> {
  if (env.MCP_OWNER_PASSWORD === undefined || env.MCP_OWNER_PASSWORD.length === 0) {
    return new Response("MCP owner authorization is not configured", { status: 503 });
  }
  let oauthRequest;
  try {
    oauthRequest = request.method === "POST"
      ? await parsePostedAuthorization(request, env)
      : await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return authorizationErrorResponse(error);
  }
  if (request.method === "GET") {
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (client === null) return new Response("Unknown OAuth client", { status: 400 });
    const csrf = crypto.randomUUID();
  return new Response(renderAuthorizationForm(request.url, client.clientName ?? oauthRequest.clientId, oauthRequest.scope, csrf), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "set-cookie": `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
      },
    });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });

  const form = await request.formData();
  const csrf = form.get("csrf_token");
  const password = form.get("password");
  const consent = form.get("consent");
  if (typeof csrf !== "string" || typeof password !== "string" || !constantTimeEqual(csrf, cookieValue(request, CSRF_COOKIE) ?? "") || !constantTimeEqual(password, env.MCP_OWNER_PASSWORD)) {
    return new Response("Authorization denied", { status: 403, headers: { "set-cookie": clearCsrfCookie() } });
  }
  if (consent !== "approve") return deniedAuthorization(oauthRequest.redirectUri, oauthRequest.state, oauthRequest.issuer);
  const grantedScopes = oauthRequest.scope.filter((scope) => (MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope));
  const completed = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthRequest,
    userId: OWNER_ID,
    metadata: { authorization: "owner-password-consent" },
    scope: grantedScopes,
    props: { user_id: OWNER_ID, client_id: oauthRequest.clientId, scopes: grantedScopes },
  });
  return new Response(null, { status: 302, headers: { location: completed.redirectTo, "set-cookie": clearCsrfCookie(), "cache-control": "no-store" } });
}

async function parsePostedAuthorization(request: Request, env: WorkerEnv) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_AUTH_FORM_BYTES)) throw new Error("authorization form too large");
  const form = await request.clone().formData();
  const url = new URL(request.url);
  for (const field of ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"] as const) {
    const value = form.get(field);
    if (typeof value === "string") url.searchParams.set(field, value);
  }
  for (const resource of form.getAll("resource")) if (typeof resource === "string") url.searchParams.append("resource", resource);
  return env.OAUTH_PROVIDER.parseAuthRequest(new Request(url, { method: "GET" }));
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) return new Response("Invalid authorization request", { status: 400 });
  if (error.redirectUri === undefined) return new Response(error.description, { status: 400 });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state !== undefined) redirect.searchParams.set("state", error.state);
  if (error.issuer !== undefined) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}
function deniedAuthorization(redirectUri: string, state: string, issuer?: string): Response {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", "Owner consent was not granted");
  redirect.searchParams.set("state", state);
  if (issuer !== undefined) redirect.searchParams.set("iss", issuer);
  return new Response(null, { status: 302, headers: { location: redirect.toString(), "set-cookie": clearCsrfCookie(), "cache-control": "no-store" } });
}
function renderAuthorizationForm(url: string, clientName: string, scopes: readonly string[], csrf: string): string {
  const source = new URL(url);
  // Preserve only OAuth parameters. Never reflect arbitrary query keys into the
  // consent form (in particular, a caller must not pre-fill `consent`).
  const oauthFields = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"];
  const fields = oauthFields.flatMap((name) => source.searchParams.getAll(name).map((value) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)).join("");
  return `<!doctype html><meta charset="utf-8"><title>Authorize Remote Coding Runtime</title><h1>Authorize Remote Coding Runtime</h1><p><strong>${escapeHtml(clientName)}</strong> requests:</p><ul>${scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("") || "<li>No scopes requested</li>"}</ul><form method="post" action="/authorize">${fields}<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Owner password <input name="password" type="password" autocomplete="current-password" required></label><label><input name="consent" type="checkbox" value="approve" required> I approve this client and these scopes</label><button type="submit">Authorize</button></form>`;
}
function cookieValue(request: Request, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`).exec(request.headers.get("cookie") ?? "");
  return match?.[1];
}
function clearCsrfCookie(): string { return `${CSRF_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }
function safeProps(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function forwardRunnerRpc(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method !== "POST" || segments.length !== 4 || segments[0] !== "internal" || segments[1] !== "runners" || segments[3] !== "rpc" || !isSafeIdentifier(segments[2] ?? "")) return new Response("not found", { status: 404 });
  const body = await request.text();
  if (!await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body)) return new Response("not found", { status: 404 });
  const runnerId = segments[2] as string;
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/rpc", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}

async function handleAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isAdminRequest(request, env)) return new Response("unauthorized", { status: 401 });
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.RUNNER_TOKEN_PEPPER === undefined) {
    return new Response("admin control plane is not configured", { status: 503 });
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const runnerId = segments[2];
  const action = segments[3];
  if (segments.length === 2 && request.method === "POST") {
    const input = await readAdminBody(request);
    const id = typeof input?.runner_id === "string" && isSafeIdentifier(input.runner_id) ? input.runner_id : undefined;
    if (id === undefined) return Response.json({ error: "runner_id must be a safe identifier" }, { status: 400 });
    return registerRunner(env, id, input);
  }
  if (runnerId === undefined || !isSafeIdentifier(runnerId) || action === undefined || segments.length !== 4 || request.method !== "POST") return new Response("not found", { status: 404 });
  if (action === "rotate") return registerRunner(env, runnerId, await readAdminBody(request));
  if (action === "revoke") {
    const response = await registryRequest(env, runnerId, "/revoke", "POST", "{}");
    if (!response.ok) return new Response("registry unavailable", { status: 502 });
    await closeRunnerSockets(env, runnerId);
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}

async function registerRunner(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const supplied = input?.token;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.length < 32 || supplied.length > 512 || /\s/.test(supplied))) {
    return Response.json({ error: "token must be 32-512 non-whitespace characters" }, { status: 400 });
  }
  const token = typeof supplied === "string" ? supplied : generateRunnerToken();
  const pepper = env.RUNNER_TOKEN_PEPPER;
  if (pepper === undefined) return new Response("admin control plane is not configured", { status: 503 });
  const verifier = await runnerTokenVerifier(token, pepper);
  const response = await registryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: verifier }));
  if (!response.ok) return new Response("registry unavailable", { status: 502 });
  await closeRunnerSockets(env, runnerId);
  return Response.json({ runner_id: runnerId, token });
}

async function closeRunnerSockets(env: WorkerEnv, runnerId: string): Promise<void> {
  const body = "{}";
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/revoke", body);
  await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", { method: "POST", headers, body }));
}
function isAdminRequest(request: Request, env: WorkerEnv): boolean {
  const token = bearerToken(request);
  return token !== undefined && env.ADMIN_TOKEN !== undefined && constantTimeEqual(token, env.ADMIN_TOKEN);
}
async function registryRequest(env: WorkerEnv, runnerId: string, action: string, method: string, body: string): Promise<Response> {
  const path = `/runners/${encodeURIComponent(runnerId)}${action}`;
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET as string, method, path, body);
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method, body, headers }));
}
async function readAdminBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) return undefined;
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_ADMIN_BODY_BYTES) return undefined;
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
