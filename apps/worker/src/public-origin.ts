const ORIGIN_MAX_LENGTH = 2_048;
const DNS_LABEL = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;

function safeHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || hostname.endsWith(".")) return false;
  if (IPV6.test(hostname)) return hostname.includes(":") && hostname.length <= 127;
  if (IPV4.test(hostname)) return hostname.split(".").every((part) => Number(part) <= 255);
  return hostname.split(".").every((label) => DNS_LABEL.test(label));
}

/**
 * Parse and canonicalize a public HTTPS origin supplied by deployment config
 * or a request.  WHATWG URL parsing intentionally accepts several characters
 * in host strings (for example `https://x.test';id;#`); those characters are
 * not valid in a deployment authority and would be dangerous when copied into
 * shell/PowerShell templates, so validate the normalized hostname as well as
 * the URL components.
 */
export function canonicalPublicOrigin(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ORIGIN_MAX_LENGTH || /[\u0000-\u0020\u007f\\%?#]/.test(value)) {
    throw new Error("installer origin is malformed");
  }
  // An origin is not a path.  Permit the conventional trailing slash, but do
  // not silently discard a path supplied by a proxy or environment variable.
  if (!/^https:\/\/[^/]+\/?$/i.test(value)) throw new Error("installer origin must be an HTTPS origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("installer origin is malformed"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || !safeHostname(url.hostname)) {
    throw new Error("installer origin must be HTTPS without credentials, path, query, or fragment");
  }
  if (url.port !== "" && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65_535)) throw new Error("installer origin has an invalid port");
  return url.origin;
}

/**
 * Resolve the origin that may be embedded in a hosted installer. A configured
 * RUNMESH_PUBLIC_ORIGIN remains the canonical fallback, while a valid HTTPS
 * request whose URL and Host agree is also accepted as the active custom
 * Worker domain. This lets Cloudflare custom domains work without adding each
 * hostname to a deployment variable. Throwing is intentional so callers can
 * return a generic 400/421 response rather than rendering a script from
 * attacker-controlled authority data.
 */
export function resolvePublicOrigin(request: Request, configuredOrigin?: string): string {
  let requestUrl: URL;
  try { requestUrl = new URL(request.url); } catch { throw new Error("request URL is malformed"); }
  // A configured public origin may be used behind an internal HTTP reverse
  // proxy. The request authority is still checked via Host when available,
  // but its scheme is never copied into a generated public URL.
  if (requestUrl.username !== "" || requestUrl.password !== "") throw new Error("request URL must not contain credentials");
  const configured = configuredOrigin === undefined ? undefined : canonicalPublicOrigin(configuredOrigin);
  const hostHeader = request.headers.get("host");
  const hostOrigin = hostHeader === null ? undefined : canonicalPublicOrigin(`https://${hostHeader}`);
  let requestOrigin: string | undefined;
  try { requestOrigin = requestUrl.protocol === "https:" ? canonicalPublicOrigin(requestUrl.origin) : undefined; } catch { requestOrigin = undefined; }
  if (configured !== undefined) {
    // A reverse proxy may expose an internal request URL while preserving the
    // configured public Host. Keep that supported.
    if (hostOrigin === configured) return configured;
    // Cloudflare supplies the routed hostname in both the request URL and
    // Host. Treat that matching HTTPS authority as the active custom domain.
    if (requestOrigin !== undefined && hostOrigin === requestOrigin) return requestOrigin;
    throw new Error("request Host does not match a configured or routed public origin");
  }
  if (requestOrigin === undefined) throw new Error("request origin is not a valid public HTTPS origin");
  if (hostOrigin !== undefined && hostOrigin !== requestOrigin) throw new Error("request Host does not match the request origin");
  return requestOrigin;
}
