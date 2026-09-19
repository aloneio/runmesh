import { MAX_MCP_BODY_BYTES } from "./constants.js";
import { discardBody } from "./request.js";
import { MCP_SECRET_RE } from "./constants.js";
import type { McpAuth } from "../mcp/server.js";
import { notFound } from "./responses.js";
import { publicInstallerHeaders } from "./distribution.js";
import { readCappedBytes } from "../body.js";
import { sha256Hex } from "../security.js";
import { verifyMcpClient } from "../application/mcp-identity.js";
import type { WorkerEnv } from "../platform/env.js";

/** The URL segment is the only MCP credential. Authorization headers are ignored. */
export async function handleMcpSecret(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const secret = parts[0];
  if (secret === undefined || !MCP_SECRET_RE.test(secret)) { await discardBody(request); return notFound(); }
  const verified = await verifyMcpClient(env, await sha256Hex(secret)).catch(async error => { await discardBody(request); throw error; });
  if (verified === undefined) { await discardBody(request); return notFound(); }
  // createMcpHandler requires an exact /mcp route. Do not consume request.body
  // before cloning it: the SDK must receive the original JSON-RPC stream.
  const rewritten = new URL(request.url);
  rewritten.pathname = "/mcp";
  rewritten.search = "";
  let forwarded: Request;
  if (request.method === "POST") {
    const body = await readCappedBytes(request, MAX_MCP_BODY_BYTES);
    if (body === undefined) return new Response("request body too large", { status: 413, headers: publicInstallerHeaders("text/plain; charset=utf-8") });
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
  const handler = createMcpHandler(
    () => createCodingMcpServer(env, auth),
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
