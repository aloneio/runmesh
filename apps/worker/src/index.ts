import { createMcpHandler } from "agents/mcp/server";
import { createCodingMcpServer, type McpAuth } from "./mcp/server.js";
import { RegistryDO, type McpClientRecord, type VerifiedMcpClient } from "./registry.js";
import { RunnerDO, type WorkerEnv } from "./runner-do.js";
import type { CodingScope } from "./registry.js";
import {
  ADMIN_SESSION_TTL_MS,
  SETUP_CSRF_TTL_MS,
  bearerToken,
  constantTimeEqual,
  generateRunnerToken,
  internalHeaders,
  isSafeIdentifier,
  passwordVerifier,
  randomBase64Url,
  runnerTokenVerifier,
  sha256Hex,
  verifyInternalRequest,
  verifyPassword,
} from "./security.js";

export { RegistryDO, RunnerDO };

const MAX_ADMIN_BODY_BYTES = 16_384;
const ADMIN_SESSION_COOKIE = "__Host-rcr_admin_session";
const ADMIN_CSRF_COOKIE = "__Host-rcr_admin_csrf";
const SETUP_CSRF_COOKIE = "__Host-rcr_setup_csrf";
const LOGIN_CSRF_COOKIE = "__Host-rcr_login_csrf";
const MCP_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleRequest(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true, service: "remote-coding-runtime-worker" });
  if (isMcpPath(url.pathname)) return handleMcpSecret(request, env, url);
  if (url.pathname === "/mcp") return notFound();
  if (url.pathname.startsWith("/internal/runners/")) return forwardRunnerRpc(request, env, url);
  // The programmatic Runner control plane deliberately retains its independent
  // ADMIN_TOKEN Bearer credential; browser admin sessions never replace it.
  if (url.pathname.startsWith("/admin/runners")) return handleRunnerAdmin(request, env, url);
  if (url.pathname === "/" || url.pathname === "/setup" || url.pathname === "/login") return handleLanding(request, env, url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleBrowserAdmin(request, env, url);
  if (url.pathname === "/runner/connect") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const runnerId = url.searchParams.get("runner_id");
    if (runnerId === null || !isSafeIdentifier(runnerId)) return new Response("invalid runner_id", { status: 400 });
    const target = new URL(request.url); target.pathname = `/runner/${encodeURIComponent(runnerId)}`; target.search = "";
    return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request(target, request));
  }
  return notFound();
}

/** The URL segment is the only MCP credential. Authorization headers are ignored. */
async function handleMcpSecret(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const secret = parts[0];
  if (secret === undefined || !MCP_SECRET_RE.test(secret)) return notFound();
  const verified = await verifyMcpClient(env, await sha256Hex(secret));
  if (verified === undefined) return notFound();
  // createMcpHandler requires an exact /mcp route. Do not consume request.body
  // before cloning it: the SDK must receive the original JSON-RPC stream.
  const rewritten = new URL(request.url);
  rewritten.pathname = "/mcp";
  rewritten.search = "";
  const auth: McpAuth = {
    // AuthInfo needs an opaque token but no component needs the raw URL secret.
    token: verified.client_id,
    clientId: verified.client_id,
    scopes: [...verified.scopes],
    extra: { client_label: verified.label, secret_version: verified.secret_version },
  };
  const handler = createMcpHandler(
    () => createCodingMcpServer(env, auth),
    {
      route: "/mcp",
      // Safe identity only. The raw secret is intentionally absent.
      authContext: { props: { client_id: verified.client_id, client_label: verified.label, scopes: [...verified.scopes], secret_version: verified.secret_version } },
      legacy: "stateless",
    },
  );
  return handler.fetch(new Request(rewritten, request), { authInfo: auth });
}

function isMcpPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[1] === "mcp";
}

async function handleLanding(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const initialized = await registryGet(env, "/auth/status").then((response) => response.ok ? response.json() as Promise<{ initialized?: unknown }> : undefined);
  if (initialized?.initialized !== true) {
    if (url.pathname !== "/" && url.pathname !== "/setup") return notFound();
    if (request.method === "GET") return setupPage();
    if (request.method === "POST") return submitSetup(request, env);
    return methodNotAllowed("GET, POST");
  }
  if (url.pathname === "/setup") return new Response("already initialized", { status: 409, headers: htmlHeaders() });
  if (request.method === "GET") return loginPage();
  if (request.method === "POST") return submitLogin(request, env);
  return methodNotAllowed("GET, POST");
}

async function submitSetup(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid setup request.");
  if (!await verifyPreAuthCsrf(request, form, SETUP_CSRF_COOKIE)) return adminError(403, "Setup request was rejected.");
  const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Passwords must match and be at least 12 characters.");
  const verifier = await passwordVerifier(password);
  const response = await registryPost(env, "/auth/setup", { password_verifier: verifier });
  if (response.status === 409) return adminError(409, "This instance is already initialized.", [clearCookie(SETUP_CSRF_COOKIE)]);
  if (!response.ok) return adminError(503, "Setup could not be completed. Try again.");
  return redirect("/", [clearCookie(SETUP_CSRF_COOKIE)]);
}

async function submitLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid login request.");
  if (!await verifyPreAuthCsrf(request, form, LOGIN_CSRF_COOKIE)) return adminError(403, "Login request was rejected.");
  const password = form.get("password");
  if (typeof password !== "string") return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const settings = await registryGet(env, "/auth/settings");
  const body = settings.ok ? await json(settings) : undefined;
  const verifier = record(body)?.password_verifier;
  if (typeof verifier !== "string" || !await verifyPassword(password, verifier)) return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const rawSession = randomBase64Url(); const rawCsrf = randomBase64Url();
  const sessionResponse = await registryPost(env, "/auth/sessions", {
    session_hash: await sha256Hex(rawSession), csrf_hash: await sha256Hex(rawCsrf), expires_at_ms: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  if (!sessionResponse.ok) return adminError(503, "Login could not be completed. Try again.");
  return redirect("/admin", [sessionCookie(rawSession), csrfCookie(rawCsrf), clearCookie(LOGIN_CSRF_COOKIE)]);
}

async function handleBrowserAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const session = await adminSession(request, env);
  if (session === undefined) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  if (request.method === "GET" && url.pathname === "/admin") {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const response = await registryGet(env, "/auth/clients");
    const clients = response.ok ? ((record(await json(response))?.clients ?? []) as McpClientRecord[]) : [];
    return html(dashboard(clients, csrf));
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");
  const form = await formData(request);
  if (form === undefined || !await verifyAdminPost(request, form, session)) return adminError(403, "Administrative request was rejected.");
  if (url.pathname === "/admin/logout") {
    await registryPost(env, "/auth/sessions/logout", { session_hash: session.hash });
    return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  }
  if (url.pathname === "/admin/password") return changePassword(env, form);
  if (url.pathname === "/admin/clients") return createClient(env, form, request.url);
  const clientMatch = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke)$/.exec(url.pathname);
  if (clientMatch === null) return notFound();
  const clientId = clientMatch[1] as string; const action = clientMatch[2] as "rename" | "rotate" | "revoke";
  if (action === "rename") {
    const label = form.get("label");
    if (typeof label !== "string" || !validLabel(label)) return adminError(400, "Client name is invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rename`, { label });
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Client update failed.");
  }
  if (action === "revoke") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/revoke`, {});
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Client revoke failed.");
  }
  const secret = randomBase64Url();
  const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rotate`, { secret_verifier: await sha256Hex(secret), secret_prefix: secret.slice(0, 8) });
  if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Client rotation failed.");
  return html(secretCreatedPage("MCP client rotated", secretUrl(request.url, secret)));
}

async function changePassword(env: WorkerEnv, form: FormData): Promise<Response> {
  const current = form.get("current_password"); const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof current !== "string" || typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Password change is invalid.");
  const settings = await registryGet(env, "/auth/settings"); const verifier = record(settings.ok ? await json(settings) : undefined)?.password_verifier;
  if (typeof verifier !== "string" || !await verifyPassword(current, verifier)) return adminError(403, "Current administrator password is invalid.");
  const response = await registryPost(env, "/auth/password", { password_verifier: await passwordVerifier(password) });
  if (!response.ok) return adminError(503, "Password change could not be completed.");
  return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
}

async function createClient(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const label = form.get("label"); const scopes = selectedScopes(form);
  if (typeof label !== "string" || !validLabel(label) || scopes === undefined) return adminError(400, "Client name or scopes are invalid.");
  const secret = randomBase64Url();
  const clientId = `client-${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await registryPost(env, "/auth/clients", {
    client_id: clientId, label, scopes, secret_verifier: await sha256Hex(secret), secret_prefix: secret.slice(0, 8),
  });
  if (!response.ok) return adminError(response.status === 409 ? 409 : 503, "Client could not be created.");
  return html(secretCreatedPage("MCP client created", secretUrl(baseUrl, secret)));
}

async function adminSession(request: Request, env: WorkerEnv): Promise<{ hash: string; csrf_hash: string } | undefined> {
  const raw = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (raw === undefined || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
  const hash = await sha256Hex(raw);
  const response = await registryPost(env, "/auth/sessions/verify", { session_hash: hash });
  const csrfHash = record(response.ok ? await json(response) : undefined)?.csrf_hash;
  return typeof csrfHash === "string" && /^[0-9a-f]{64}$/.test(csrfHash) ? { hash, csrf_hash: csrfHash } : undefined;
}
async function verifyAdminPost(request: Request, form: FormData, session: { csrf_hash: string }): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, ADMIN_CSRF_COOKIE);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie) && constantTimeEqual(await sha256Hex(supplied), session.csrf_hash);
}
async function verifyPreAuthCsrf(request: Request, form: FormData, name: string): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, name);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie);
}
function sameOrigin(request: Request): boolean {
  const origin = new URL(request.url).origin;
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (candidate === null) return true; // non-browser form clients still need SameSite + CSRF token.
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

function setupPage(): Response { const csrf = randomBase64Url(); return html(`<!doctype html><title>Remote Coding Runtime setup</title><main><h1>Welcome to Remote Coding Runtime</h1><p>Create administrator password</p><form method="post" action="/setup"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Password <input type="password" name="password" autocomplete="new-password" required minlength="12"></label><label>Confirm password <input type="password" name="confirm_password" autocomplete="new-password" required minlength="12"></label><button>Initialize</button></form></main>`, [`${SETUP_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]); }
function loginPage(): Response { const csrf = randomBase64Url(); return html(`<!doctype html><title>Remote Coding Runtime login</title><main><h1>Remote Coding Runtime</h1><form method="post" action="/login"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Admin password <input type="password" name="password" autocomplete="current-password" required></label><button>Login</button></form></main>`, [`${LOGIN_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]); }
function dashboard(clients: readonly McpClientRecord[], csrf: string): string {
  const rows = clients.map((client) => `<tr><td>${escapeHtml(client.label)}</td><td><code>${escapeHtml(client.secret_prefix)}…</code></td><td>${escapeHtml(client.scopes.join(", "))}</td><td>${client.revoked_at_ms === null ? "Active" : "Revoked"}</td><td>${escapeHtml(time(client.last_used_at_ms))}</td><td><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" maxlength="256"><button>Rename</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button>Rotate</button></form><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button>Revoke</button></form>` : ""}</td></tr>`).join("") || "<tr><td colspan=6>No MCP clients.</td></tr>";
  return `<!doctype html><title>Remote Coding Runtime admin</title><main><h1>Remote Coding Runtime</h1><h2>MCP Clients</h2><table><thead><tr><th>Name</th><th>Key prefix</th><th>Scopes</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table><h2>Create MCP Client</h2><form method="post" action="/admin/clients"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Name <input name="label" maxlength="256" required></label>${scopeCheckboxes()}<button>Create</button></form><h2>Change password</h2><form method="post" action="/admin/password"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Current password <input type="password" name="current_password" required></label><label>New password <input type="password" name="password" minlength="12" required></label><label>Confirm password <input type="password" name="confirm_password" minlength="12" required></label><button>Change password</button></form><form method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button>Logout</button></form></main>`;
}
function scopeCheckboxes(): string { return ["coding:read", "coding:write", "coding:exec"].map((scope) => `<label><input type="checkbox" name="scopes" value="${scope}" checked> ${scope}</label>`).join(""); }
function secretCreatedPage(title: string, url: string): string { return `<!doctype html><title>${escapeHtml(title)}</title><main><h1>${escapeHtml(title)}</h1><p>Copy this URL now. It will not be shown again.</p><code>${escapeHtml(url)}</code><p><a href="/admin">Back to admin</a></p></main>`; }
function secretUrl(base: string, secret: string): string { const url = new URL(base); url.pathname = `/${secret}/mcp`; url.search = ""; return url.toString(); }
function selectedScopes(form: FormData): CodingScope[] | undefined { const values = form.getAll("scopes"); const scopes = values.filter((value): value is CodingScope => value === "coding:read" || value === "coding:write" || value === "coding:exec"); return scopes.length === values.length && scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : undefined; }
function validPassword(password: string): boolean { return password.length >= 12 && password.length <= 1_024; }
function validLabel(label: string): boolean { return label.trim().length > 0 && label.length <= 256; }

async function forwardRunnerRpc(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method !== "POST" || segments.length !== 4 || segments[0] !== "internal" || segments[1] !== "runners" || segments[3] !== "rpc" || !isSafeIdentifier(segments[2] ?? "")) return notFound();
  const body = await request.text();
  if (!await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body)) return notFound();
  const runnerId = segments[2] as string; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/rpc", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}

async function handleRunnerAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isRunnerAdminRequest(request, env)) return new Response("unauthorized", { status: 401 });
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.RUNNER_TOKEN_PEPPER === undefined) return new Response("admin control plane is not configured", { status: 503 });
  const segments = url.pathname.split("/").filter(Boolean); const runnerId = segments[2]; const action = segments[3];
  if (segments.length === 2 && request.method === "POST") {
    const input = await readAdminBody(request); const id = typeof input?.runner_id === "string" && isSafeIdentifier(input.runner_id) ? input.runner_id : undefined;
    if (id === undefined) return Response.json({ error: "runner_id must be a safe identifier" }, { status: 400 });
    return registerRunner(env, id, input);
  }
  if (runnerId === undefined || !isSafeIdentifier(runnerId) || action === undefined || segments.length !== 4 || request.method !== "POST") return notFound();
  if (action === "rotate") return registerRunner(env, runnerId, await readAdminBody(request));
  if (action === "revoke") { const response = await runnerRegistryRequest(env, runnerId, "/revoke", "POST", "{}"); if (!response.ok) return new Response("registry unavailable", { status: 502 }); await closeRunnerSockets(env, runnerId); return new Response(null, { status: 204 }); }
  return notFound();
}
async function registerRunner(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const supplied = input?.token;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.length < 32 || supplied.length > 512 || /\s/.test(supplied))) return Response.json({ error: "token must be 32-512 non-whitespace characters" }, { status: 400 });
  const token = typeof supplied === "string" ? supplied : generateRunnerToken(); const pepper = env.RUNNER_TOKEN_PEPPER;
  if (pepper === undefined) return new Response("admin control plane is not configured", { status: 503 });
  const response = await runnerRegistryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: await runnerTokenVerifier(token, pepper) }));
  if (!response.ok) return new Response("registry unavailable", { status: 502 });
  await closeRunnerSockets(env, runnerId); return Response.json({ runner_id: runnerId, token });
}
async function closeRunnerSockets(env: WorkerEnv, runnerId: string): Promise<void> { const body = "{}"; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/revoke", body); await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", { method: "POST", headers, body })); }
function isRunnerAdminRequest(request: Request, env: WorkerEnv): boolean { const token = bearerToken(request); return token !== undefined && env.ADMIN_TOKEN !== undefined && constantTimeEqual(token, env.ADMIN_TOKEN); }
async function runnerRegistryRequest(env: WorkerEnv, runnerId: string, action: string, method: string, body: string): Promise<Response> { const path = `/runners/${encodeURIComponent(runnerId)}${action}`; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET as string, method, path, body); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method, body, headers })); }

async function verifyMcpClient(env: WorkerEnv, secretVerifier: string): Promise<VerifiedMcpClient | undefined> { const response = await registryPost(env, "/auth/mcp/verify", { secret_verifier: secretVerifier }); const body = response.ok ? record(await json(response)) : undefined; if (body === undefined || typeof body.client_id !== "string" || typeof body.label !== "string" || typeof body.secret_version !== "number" || !Array.isArray(body.scopes) || body.scopes.some((scope) => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) return undefined; return { client_id: body.client_id, label: body.label, secret_version: body.secret_version, scopes: body.scopes as CodingScope[] }; }
async function registryGet(env: WorkerEnv, path: string): Promise<Response> { const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "GET", path, ""); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { headers })); }
async function registryPost(env: WorkerEnv, path: string, payload: Record<string, unknown>): Promise<Response> { const body = JSON.stringify(payload); const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", path, body); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body })); }
async function formData(request: Request): Promise<FormData | undefined> { const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) return undefined; try { const form = await request.formData(); let size = 0; for (const [key, value] of form) { if (typeof value !== "string") return undefined; size += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength; } return size <= MAX_ADMIN_BODY_BYTES ? form : undefined; } catch { return undefined; } }
async function readAdminBody(request: Request): Promise<Record<string, unknown> | undefined> { const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) return undefined; const body = await request.text(); if (new TextEncoder().encode(body).byteLength > MAX_ADMIN_BODY_BYTES) return undefined; try { const value = JSON.parse(body) as unknown; return record(value); } catch { return undefined; } }
function cookieValue(request: Request, name: string): string | undefined { const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const match = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`).exec(request.headers.get("cookie") ?? ""); return match?.[1]; }
function sessionCookie(value: string): string { return `${ADMIN_SESSION_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }
function csrfCookie(value: string): string { return `${ADMIN_CSRF_COOKIE}=${value}; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }
function clearCookie(name: string): string { return `${name}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`; }
function html(value: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(value, { headers }); }
function htmlHeaders(): Headers { return new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }); }
function redirect(location: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); headers.set("location", location); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(null, { status: 303, headers }); }
function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><title>Remote Coding Runtime</title><main><h1>Remote Coding Runtime</h1><p>${escapeHtml(message)}</p><p><a href="/">Return</a></p></main>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }
function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }
function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }
function time(value: number | null): string { return value === null ? "Never" : new Date(value).toISOString(); }
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
