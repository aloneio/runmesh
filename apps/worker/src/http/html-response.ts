import { randomBase64Url } from "../security.js";
import { adminScript } from "../admin/client-script.js";

export function html(value: string, cookies: readonly string[] = []): Response {
  const headers = htmlHeaders(); const nonce = randomBase64Url(16);
  // Authorize only the exact application-owned script, never every script
  // found in rendered HTML. Arbitrary injected tags must not receive a nonce.
  const document = value.replaceAll(adminScript(), () => adminScript(nonce));
  headers.set("content-security-policy", (headers.get("content-security-policy") as string).replace("script-src 'none'", `script-src 'nonce-${nonce}'`));
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(document, { headers });
}

export function htmlHeaders(): Headers { return new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }); }

export function redirect(location: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); headers.set("location", location); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(null, { status: 303, headers }); }

export function credentialHeaders(contentType: string): Headers { const headers = htmlHeaders(); headers.set("content-type", contentType); return headers; }
