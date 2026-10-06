import { message } from "../i18n/messages.js";
import type { AdminNotice, ControlNavSection } from "../contracts/admin-views.js";
import { escapeHtml } from "./format.js";
import { adminStyles } from "../admin-styles.js";
import { meshMarkSvg, languageSwitch } from "./brand.js";
import { adminScript } from "./client-script.js";

export function controlHeader(active?: ControlNavSection): string {
  const icons: Record<ControlNavSection, string> = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    central: '<path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(1 0) scale(.9)"/>',
    clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
    runners: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m-5-12 3 3-3 3m6 0h4"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--panel)"/><circle cx="15" cy="17" r="3" fill="var(--panel)"/>',
  };
  const nav = ([
    ["dashboard", "Dashboard", "/admin"],
    ["central", "MCP &amp; Skill", "/admin/central"],
    ["clients", "AI connections", "/admin/clients"],
    ["runners", "Runners", "/admin/runners"],
    ["settings", "Settings", "/admin/settings"],
  ] as const).map(([key, label, href]) => `<a class="${active === key ? "active" : ""}"${active === key ? ' aria-current="page"' : ""} href="${href}"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[key]}</svg><span>${label}</span></a>`).join("");
  return `<header class="app-header" data-app-header><div class="header-inner"><div class="header-left"><a class="brand" href="/admin" aria-label="Runmesh · Agent Control Plane">${meshMarkSvg("header-mesh-mark")}<span class="brand-copy"><span>Runmesh</span><small>${message("text.agent.control.plane", "en")}</small></span></a></div><div class="header-actions">${languageSwitch()}</div></div><div class="nav-rail"><nav class="control-nav" aria-label="Main navigation">${nav}</nav></div></header>`;
}

export function adminDocument(title: string, body: string, active: ControlNavSection, notices: readonly AdminNotice[] = []): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="ops-body"><a class="skip-link" href="#main-content">${message("text.skip.to.main.content", "en")}</a>${controlHeader(active)}<div class="shell"><main class="workspace" id="main-content" tabindex="-1">${renderAdminNotices(notices)}${body}</main></div>${adminScript()}</body></html>`;
}

export function renderAdminNotices(notices: readonly AdminNotice[]): string {
  if (notices.length === 0) return "";
  const list = notices.map((notice) => `<li><strong>${escapeHtml(notice.title)}</strong><span class="notice-message">${escapeHtml(notice.message)}</span>${notice.code === undefined ? "" : ` <span class="mono notice-code" data-no-i18n>${escapeHtml(notice.code)}</span>`}</li>`).join("");
  return `<dialog open class="feature-alert-dialog" aria-labelledby="feature-alert-title"><form method="dialog" class="feature-alert-card"><section class="page-heading feature-alert-heading"><div><p class="eyebrow">${message("text.control.plane.2", "en")}</p><h2 id="feature-alert-title">${message("text.some.control.plane.features.are.temporarily.paused", "en")}</h2><p class="lede">${message("text.the.console.remains.available.but.dependent.paths.will.stop.retrying.until.the.quota.recov", "en")}</p></div></section><ul class="warning diagnostic-warning-list feature-alert-list">${list}</ul><div class="top-actions dialog-actions"><button class="button secondary">${message("text.dismiss", "en")}</button></div></form></dialog>`;
}
