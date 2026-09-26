import { message } from "../i18n/messages.js";
import { controlHeader } from "./layout.js";
import { passwordToggle } from "./forms.js";
import { escapeHtml } from "./format.js";
import { adminStyles } from "../admin-styles.js";
import { languageSwitch, brandLogo, meshVisualGraphic } from "./brand.js";
import { adminScript } from "./client-script.js";

export function authEntryDocument(kind: "login" | "setup", csrf: string): string {
  const setup = kind === "setup";
  const brandHeadline = setup ? "Set up Runmesh" : "Runner &amp; MCP Control Plane";
  const brandDescription = setup
    ? "Create your administrator master password to begin managing distributed runtimes and MCP clients."
    : "Coordinate distributed Runner tools, persistent jobs, and MCP client connections.";
  const title = setup ? "Runmesh · Agent Control Plane setup" : "Runmesh · Agent Control Plane login";
  const form = setup
    ? `<div class="input-group"><label for="password">${message("auth.password", "en")}</label><div class="password-input-wrap"><input id="password" type="password" name="password" autocomplete="new-password" required minlength="12">${passwordToggle()}</div></div><div class="input-group"><label for="confirm_password">${message("auth.confirmPassword", "en")}</label><div class="password-input-wrap"><input id="confirm_password" type="password" name="confirm_password" autocomplete="new-password" required minlength="12">${passwordToggle()}</div></div>`
    : `<div class="input-group"><label for="admin_password">${message("text.admin.password", "en")}</label><div class="password-input-wrap"><input id="admin_password" type="password" name="password" autocomplete="current-password" required>${passwordToggle()}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${title}</title>${adminStyles()}</head><body class="auth-body login-entry-body">${languageSwitch()}<div class="login-layout"><aside class="login-brand-pane"><div class="login-brand-header"><a class="login-brand-title-wrap" href="/" aria-label="Runmesh · Agent Control Plane">${brandLogo("login-brand-logo")}</a><p class="brand-kicker">${message("text.runmesh.control.plane", "en")}</p><h2 class="login-brand-headline">${brandHeadline}</h2><p class="login-brand-desc">${brandDescription}</p></div>${meshVisualGraphic()}</aside><main class="login-form-pane"><div class="login-form-container"><div class="auth-header-mobile"><a class="login-brand-title-wrap" href="/" aria-label="Runmesh · Agent Control Plane">${brandLogo("login-brand-logo")}</a></div><div class="login-title-group"><p class="brand-kicker">Runmesh</p><h1>${setup ? "Welcome to Runmesh" : "Runmesh"}</h1><p class="subtitle">${message("text.agent.control.plane", "en")}</p><p class="login-invite">${setup ? "Create administrator password" : "Enter the Runmesh control plane"}</p></div><form method="post" action="/${setup ? "setup" : "login"}" class="login-form stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">${form}<button class="login-submit-btn">${setup ? "Initialize" : "Login"}</button></form></div></main></div>${adminScript()}</body></html>`;
}

export function secretCreatedPage(title: string, url: string, clientId?: string): string {
  const next = clientId === undefined ? "" : `<section class="central-next-step"><h2>Choose what this connection can use</h2><p>Copy your connection URL first. Then select the approved services and Skills for this AI client.</p><a class="button" href="/admin/central?client=${encodeURIComponent(clientId)}">Choose services and Skills</a><p class="muted">In your AI client, add a remote MCP connection and paste the URL. Refresh its tools after saving access.</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="ops-body secret-result-body"><a class="skip-link" href="#main-content">${message("text.skip.to.main.content", "en")}</a>${controlHeader("clients")}<main class="shell secret-result-shell" id="main-content" tabindex="-1"><section class="auth-card secret-card"><p class="brand-kicker">Runmesh</p><h1>${escapeHtml(title)}</h1><p class="lede">${message("text.copy.this.url.now.it.will.not.be.shown.again", "en")}</p><code>${escapeHtml(url)}</code><div class="secret-actions"><button type="button" class="button" data-copy="${escapeHtml(url)}">${message("text.copy.mcp.url", "en")}</button><a class="button secondary" href="/admin/clients">${message("text.back.to.clients", "en")}</a></div>${next}</section></main>${adminScript()}</body></html>`;
}
