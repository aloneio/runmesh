import { MAX_MCP_BODY_BYTES } from "./constants.js";
import { discardMcpBody as discardBody } from "./mcp-errors.js";
import { MCP_SECRET_RE } from "./constants.js";
import type { McpAuth } from "../mcp/server.js";
import { mcpHttpError } from "./mcp-errors.js";
import { readCappedBytes } from "../body.js";
import { sha256Hex } from "../security.js";
import { verifyMcpClient } from "../application/mcp-identity.js";
import type { WorkerEnv } from "../platform/env.js";
import type { CentralRemote } from "../contracts/remote.js";
import { parseRemoteEgress } from "../contracts/remote-values.js";
import type { CentralSkills } from "../contracts/skills.js";
import type { CentralDirectory, CentralDirectoryReader } from "../contracts/catalog.js";
import type { CentralToolVisibility, CentralToolVisibilityReader } from "../contracts/capabilities.js";

/** The URL segment is the only MCP credential. Authorization headers are ignored. */
export async function handleMcpSecret(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (request.headers.has("x-runmesh-mcp-hop")) { await discardBody(request); return mcpHttpError(508, "MCP relay recursion rejected"); }
  const parts = url.pathname.split("/").filter(Boolean);
  const secret = parts[0];
  if (secret === undefined || !MCP_SECRET_RE.test(secret)) { await discardBody(request); return mcpHttpError(404, "Not found"); }
  const verified = await verifyMcpClient(env, await sha256Hex(secret)).catch(async error => { await discardBody(request); throw error; });
  if (verified === undefined) { await discardBody(request); return mcpHttpError(404, "Not found"); }
  // createMcpHandler requires an exact /mcp route. Do not consume request.body
  // before cloning it: the SDK must receive the original JSON-RPC stream.
  const rewritten = new URL(request.url);
  rewritten.pathname = "/mcp";
  rewritten.search = "";
  let forwarded: Request;
  let needsDirectory = false;
  let discoversProviders = false;
  if (request.method === "POST") {
    const body = await readCappedBytes(request, MAX_MCP_BODY_BYTES);
    if (body === undefined) return mcpHttpError(413, "request body too large");
    try {
      const rpc = JSON.parse(new TextDecoder().decode(body)) as { method?: string; params?: { name?: string } };
      discoversProviders = rpc?.method === "tools/list" || rpc?.method === "resources/list" || rpc?.method === "resources/templates/list";
      needsDirectory = env.CENTRAL_DIRECT_TOOLS_ENABLED === "1" && (rpc?.method === "tools/list" || (rpc?.method === "tools/call" && typeof rpc.params?.name === "string" && (rpc.params.name.startsWith("rm_") || rpc.params.name === "remote_status")));
    } catch { /* The SDK owns malformed JSON-RPC responses. */ }
    forwarded = new Request(rewritten, { method: request.method, headers: request.headers, body: body.buffer as ArrayBuffer });
  } else {
    forwarded = new Request(rewritten, request);
  }
  const auth: McpAuth = {
    // AuthInfo needs an opaque token but no component needs the raw URL secret.
    token: verified.client_id,
    clientId: verified.client_id,
    scopes: [...verified.scopes],
    extra: { client_label: verified.label, secret_version: verified.secret_version },
  };
  const [{ createMcpHandler }, { createCodingMcpServer }] = await Promise.all([
    import("agents/mcp/server"),
    import("../mcp/server.js"),
  ]);
  const remote = env.CAPABILITIES === undefined || parseRemoteEgress(env.CENTRAL_MCP_EGRESS) === undefined
    ? undefined : await import("../mcp/providers/remote.js");
  const skills = env.CAPABILITIES !== undefined && env.CENTRAL_SKILLS_ENABLED === "1"
    ? await import("../mcp/providers/skills.js") : undefined;
  const direct = remote !== undefined && env.CENTRAL_DIRECT_TOOLS_ENABLED === "1" ? await import("../mcp/providers/remote/direct.js") : undefined;
  let visibility: CentralToolVisibility | undefined;
  if (discoversProviders && (skills !== undefined || remote !== undefined)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralToolVisibilityReader;
      const observed = await Promise.race([owner.toolVisibility({ client_id: verified.client_id, secret_version: verified.secret_version }),
        new Promise<CentralToolVisibility>(resolve => { timer = setTimeout(() => resolve({ state: "unavailable" }), 6000); })]);
      if (observed?.state === "visible" && typeof observed.skill === "boolean" && typeof observed.remote === "boolean") visibility = observed;
    } catch { /* Central discovery fails closed without removing native tools. */ }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const publishSkills = skills !== undefined && (!discoversProviders || (visibility?.state === "visible" && visibility.skill));
  const publishRemote = remote !== undefined && (!discoversProviders || (visibility?.state === "visible" && visibility.remote));
  let directory: CentralDirectory | undefined;
  if (direct && publishRemote && needsDirectory) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const owner = env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralDirectoryReader;
      directory = await Promise.race([owner.listDirectory({ client_id: verified.client_id, secret_version: verified.secret_version }),
        new Promise<CentralDirectory>(resolve => { timer = setTimeout(() => resolve({ state: "unavailable" }), 6000); })]);
    } catch { directory = { state: "unavailable" }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const handler = createMcpHandler(
    () => {
      const server = createCodingMcpServer(env, auth);
      if (skills !== undefined && publishSkills) {
        const principal = { client_id: verified.client_id, secret_version: verified.secret_version };
        const owner = () => env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralSkills;
        skills.registerSkillTools(server, { list: query => owner().listSkills(principal, query), read: input => owner().readSkill(principal, input) });
      }
      if (remote !== undefined && publishRemote && env.CAPABILITIES !== undefined) {
        const principal = { client_id: verified.client_id, secret_version: verified.secret_version };
        // Resolving the DO is lazy; server construction and native-only calls
        // do not touch central state or initialize any upstream connection.
        const owner = () => env.CAPABILITIES!.get(env.CAPABILITIES!.idFromName("central")) as unknown as CentralRemote;
        remote.registerRemoteTools(server, { list: query => owner().listCatalog(principal, query), call: command => owner().callRemote(principal, command) });
        direct?.registerDirectRemoteTools(server, { list: query => owner().listCatalog(principal, query), call: command => owner().callRemote(principal, command) }, directory);
      }
      return server;
    },
    {
      route: "/mcp",
      // Safe identity only. The raw secret is intentionally absent.
      authContext: { props: { client_id: verified.client_id, client_label: verified.label, scopes: [...verified.scopes], secret_version: verified.secret_version } },
      legacy: "stateless",
    },
  );
  const response = await handler.fetch(forwarded, { authInfo: auth });
  // The MCP credential is carried in the request path.  Do not allow an SDK
  // response (or an intermediary) to cache that path or disclose it through
  // a referrer when a client follows a response link.  These headers also
  // keep the JSON/SSE endpoint from becoming an embeddable cross-origin
  // document if a future SDK response changes its content type.
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function isMcpPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[1] === "mcp";
}

export function requiresInternalControl(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/setup"
    || pathname === "/login"
    || pathname === "/runner/enroll"
    || pathname === "/runner/connect"
    || pathname === "/admin"
    || pathname.startsWith("/admin/")
    || isMcpPath(pathname);
}
