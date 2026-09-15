import { adminScript } from "../admin/client-script.js";
import { adminStyles } from "../admin-styles.js";
import { escapeHtml } from "../admin/format.js";
import { html } from "./html-response.js";
import { languageSwitch } from "../admin/brand.js";
import { meshMarkSvg } from "../admin/brand.js";

export function throttleError(retryAfterMs: number): Response {
  const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">Invalid administrator password.</p><p class="muted">Please try again shortly.</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`);
  const headers = new Headers(response.headers);
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return new Response(response.body, { status: 403, headers });
}

export function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="auth-body">${languageSwitch()}<main class="auth-shell"><section class="auth-card error-card"><div class="secret-brand-row">${meshMarkSvg("error-mesh-mark")}<span class="brand-name">Runmesh</span></div><p class="brand-kicker">Runmesh</p><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><p class="lede">${escapeHtml(message)}</p><p><a class="button secondary" href="/">Return</a></p></section></main>${adminScript()}</body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }

export function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }

export function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
