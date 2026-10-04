import type { UiLocale } from "../contracts/locale.js";
import { message } from "../i18n/messages.js";
import { adminStyles } from "../admin-styles.js";
import { controlHeader } from "./layout.js";
import { escapeHtml } from "./format.js";

/** Fixed presentation only; callback parameters never enter this document. */
export function oauthLandingDocument(locale: UiLocale): string {
  const copy = {
    title: message("oauth.callback.title", locale),
    pending: message("oauth.callback.pending", locale),
    failed: message("oauth.callback.failed", locale),
    restart: message("oauth.callback.restart", locale),
    unconfirmed: message("oauth.callback.unconfirmed", locale),
    cancelled: message("oauth.callback.cancelled", locale),
    back: message("oauth.callback.back", locale),
  };
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(copy.title)} · Runmesh</title>${adminStyles()}</head><body class="ops-body secret-result-body">${controlHeader("central")}<main class="shell secret-result-shell" id="main-content"><section class="auth-card secret-card" data-oauth-callback aria-busy="true" aria-labelledby="oauth-title" data-failed="${escapeHtml(copy.failed)}" data-restart="${escapeHtml(copy.restart)}" data-unconfirmed="${escapeHtml(copy.unconfirmed)}" data-cancelled="${escapeHtml(copy.cancelled)}"><p class="brand-kicker">Runmesh</p><h1 id="oauth-title">${escapeHtml(copy.title)}</h1><p class="lede" id="status" role="status" aria-live="polite">${escapeHtml(copy.pending)}</p><div class="secret-actions"><a class="button secondary" href="/admin/central">${escapeHtml(copy.back)}</a></div></section></main></body></html>`;
}
