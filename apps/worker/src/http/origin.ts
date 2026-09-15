import { resolvePublicOrigin } from "../installer.js";

/**
 * Resolve the origin used for browser-generated links and CSRF checks. Hosted
 * deployments must configure a canonical HTTPS origin; local development may
 * use HTTP only on an explicit loopback address so an arbitrary Host header
 * can never become a persisted credential endpoint.
 */
export function resolveConnectionOrigin(request: Request, configuredOrigin?: string): string {
  if (configuredOrigin !== undefined) return resolvePublicOrigin(request, configuredOrigin);
  let url: URL;
  try { url = new URL(request.url); } catch { throw new Error("request URL is malformed"); }
  if (url.protocol === "https:") return resolvePublicOrigin(request);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || !isLoopbackHostname(url.hostname)) throw new Error("an HTTPS or loopback HTTP origin is required");
  const hostHeader = request.headers.get("host");
  if (hostHeader !== null) {
    if (/^[\u0000-\u0020\u007f\\\/?#@]/u.test(hostHeader) || /[\u0000-\u0020\u007f\\\/?#@]/u.test(hostHeader)) throw new Error("request Host is malformed");
    let hostUrl: URL;
    try { hostUrl = new URL(`http://${hostHeader}`); } catch { throw new Error("request Host is malformed"); }
    if (hostUrl.username !== "" || hostUrl.password !== "" || hostUrl.pathname !== "/" || hostUrl.search !== "" || hostUrl.hash !== "" || !isLoopbackHostname(hostUrl.hostname) || normalizeHostname(hostUrl.hostname) !== normalizeHostname(url.hostname) || hostUrl.port !== url.port) throw new Error("request Host does not match the loopback origin");
  }
  return url.origin;
}

function normalizeHostname(value: string): string { return value.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); }

function isLoopbackHostname(value: string): boolean {
  const hostname = normalizeHostname(value);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function sameOrigin(request: Request, configuredOrigin?: string): boolean {
  let origin: string;
  try { origin = resolveConnectionOrigin(request, configuredOrigin); } catch { return false; }
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (candidate === null || candidate === "null") return true; // privacy browsers may submit Origin: null; the synchronizer token still remains mandatory.
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

export function configuredPublicOrigin(env: { RUNMESH_PUBLIC_ORIGIN?: string; RUNMESH_TEST_MODE?: string }): string | undefined {
  return env.RUNMESH_TEST_MODE === "1" ? undefined : env.RUNMESH_PUBLIC_ORIGIN;
}
