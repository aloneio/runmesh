import { message } from "../i18n/messages.js";
import type { AdminNotice, ControlNavSection } from "./view-models.js";
import { escapeHtml } from "./format.js";
import { adminStyles } from "../admin-styles.js";
import { meshMarkSvg, languageSwitch } from "./brand.js";
import { adminScript } from "./client-script.js";

export function controlHeader(active?: ControlNavSection): string {
  const nav = ([
    ["dashboard", "Dashboard", "/admin"],
    ["central", "Services &amp; Skills", "/admin/central"],
    ["clients", "AI connections", "/admin/clients"],
    ["runners", "Runners", "/admin/runners"],
    ["settings", "Settings", "/admin/settings"],
  ] as const).map(([key, label, href]) => `<a class="${active === key ? "active" : ""}"${active === key ? ' aria-current="page"' : ""} href="${href}">${label}</a>`).join("");
  return `<header class="app-header" data-app-header><div class="header-inner"><div class="header-left"><a class="brand" href="/admin" aria-label="Runmesh · Agent Control Plane">${meshMarkSvg("header-mesh-mark")}<span class="brand-copy"><span>Runmesh</span><small>${message("text.agent.control.plane", "en")}</small></span></a><nav class="control-nav" aria-label="Main navigation">${nav}</nav></div><div class="header-actions">${languageSwitch()}</div></div></header>`;
}

export function adminDocument(title: string, body: string, active: ControlNavSection, notices: readonly AdminNotice[] = []): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body class="ops-body"><a class="skip-link" href="#main-content">${message("text.skip.to.main.content", "en")}</a>${controlHeader(active)}<div class="shell"><main class="workspace" id="main-content" tabindex="-1">${renderAdminNotices(notices)}${body}</main></div>${adminScript()}</body></html>`;
}

export function renderAdminNotices(notices: readonly AdminNotice[]): string {
  if (notices.length === 0) return "";
  const list = notices.map((notice) => `<li><strong>${escapeHtml(notice.title)}</strong><span class="notice-message">${escapeHtml(notice.message)}</span>${notice.code === undefined ? "" : ` <span class="mono notice-code" data-no-i18n>${escapeHtml(notice.code)}</span>`}</li>`).join("");
  return `<dialog open class="feature-alert-dialog" aria-labelledby="feature-alert-title"><form method="dialog" class="feature-alert-card"><section class="page-heading feature-alert-heading"><div><p class="eyebrow">${message("text.control.plane.2", "en")}</p><h2 id="feature-alert-title">${message("text.some.control.plane.features.are.temporarily.paused", "en")}</h2><p class="lede">${message("text.the.console.remains.available.but.dependent.paths.will.stop.retrying.until.the.quota.recov", "en")}</p></div></section><ul class="warning diagnostic-warning-list feature-alert-list">${list}</ul><div class="top-actions dialog-actions"><button class="button secondary">${message("text.dismiss", "en")}</button></div></form></dialog>`;
}
