import { adminScript } from "../admin/client-script.js";
import { adminStyles } from "../admin-styles.js";
import { escapeHtml } from "../admin/format.js";
import { html, redirect } from "./html-response.js";
import { languageSwitch } from "../admin/brand.js";
import { meshMarkSvg } from "../admin/brand.js";
import { adminDocument } from "../admin/layout.js";

/** Authenticated actions retain their console navigation without JavaScript. */
export function adminSectionError(status: number, message: string, section: "dashboard" | "runners" | "clients"): Response {
  const title = section === "runners" ? "Runners" : section === "clients" ? "AI connections" : "Dashboard";
  const path = section === "dashboard" ? "/admin" : "/admin/" + section;
  const response = html(adminDocument(title, `<section class="panel"><h1>${title}</h1><p class="warning" role="alert" data-admin-error>${escapeHtml(message)}</p><p><a class="button secondary" href="${path}">Return</a></p></section>`, section));
  return new Response(response.body, { status, headers: response.headers });
}

export function adminRunnerError(status: number, message: string): Response { return adminSectionError(status, message, "runners"); }
export function adminClientError(status: number, message: string): Response { return adminSectionError(status, message, "clients"); }

export function throttleError(retryAfterMs: number): Response {
  const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Invalid administrator password.</p><p class="muted">Please try again shortly.</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`);
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return new Response(response.body, { status: 403, headers });
}

export function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede" data-admin-error>${escapeHtml(message)}</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }

/** A redirect owns the unused upstream receipt; cleanup never replays a write. */
export function adminUpstreamRedirect(upstream: Response, location: string): Response {
  void upstream.body?.cancel().catch(() => undefined);
  return redirect(location);
}

/** A dependency outage is not evidence of invalid administrator input.
 * Discard the upstream body without exposing diagnostics or replaying writes. */
export function adminUpstreamError(upstream: Response, message: string, fallbackStatus = 400, render: (status: number, message: string) => Response = adminError): Response {
  void upstream.body?.cancel().catch(() => undefined);
  const status = upstream.status < 400 || upstream.status === 429 || upstream.status >= 500 ? 503 : upstream.status === 403 || upstream.status === 404 ? upstream.status : fallbackStatus;
  return render(status, message);
}

export function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }

export function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
