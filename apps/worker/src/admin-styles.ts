import { componentsStyles } from "./admin/styles/components.js";
import { surfacesStyles } from "./admin/styles/surfaces.js";
import { pagesStyles } from "./admin/styles/pages.js";
import { responsiveStyles } from "./admin/styles/responsive.js";
import { tablesStyles } from "./admin/styles/tables.js";

// Shared design tokens and application shell. Component modules are pure CSS.
export function adminStyles(): string { return `<style>
.central-start,.central-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:24px 0}
.central-start>div{padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.central-start p{margin:8px 0 0;color:var(--muted)}
.central-grid{grid-template-columns:1.2fr 1fr;align-items:start}
.central-tabs{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}
[data-central-product]{overflow-wrap:anywhere}
[data-central-product] form{display:grid;gap:16px}
[data-central-product] label{display:grid;gap:8px;margin:12px 0}
[data-central-product] .central-choice{display:flex;align-items:flex-start;gap:12px;padding:14px;border:1px solid var(--line);border-radius:10px}
[data-central-product] input[type=checkbox]{width:auto;flex:none;margin-top:4px}
.central-card{border-bottom:1px solid var(--line);padding:18px 0;overflow-wrap:anywhere}
.central-card:first-child{padding-top:4px}.central-card h3{margin:0 0 8px}
.central-card .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;width:100%;min-width:0}
[data-service-tools] h2{min-width:0;max-width:100%;overflow-wrap:anywhere}
[data-central-product] .central-card h3{text-transform:none;letter-spacing:normal}
[data-product-status]:not(:empty){padding:14px 18px;border:1px solid var(--line);border-radius:10px;background:var(--panel);white-space:pre-wrap}
[data-product-status][data-error=true]{border-color:#b91c1c;color:#b91c1c}
[data-central-product] pre{max-height:340px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
[data-central-product] [hidden]{display:none!important}.central-advanced{margin-top:32px}.central-advanced>summary{cursor:pointer}
@media(max-width:760px){.central-start,.central-grid{grid-template-columns:1fr}.central-tabs .button{flex:1}.central-start{gap:8px}}
/* Explicit admin navigation is rendered without cross-document fades. */
::view-transition-old(app-header),::view-transition-new(app-header){animation:none}
:root{
  color-scheme:light;
  --canvas:#f6f7f9;
  --rail-width:208px;
  --header-height:64px;
  --canvas-subtle:#eaedf1;
  --panel:#ffffff;
  --panel-card:#f8fafc;
  --panel-elevated:#ffffff;
  --panel-subtle:#f1f5f9;
  --surface-hover:#eef2f6;
  --header-bg:rgba(255,255,255,0.92);
  --header-hover:rgba(241,245,249,0.85);
  --grid-line:rgba(15,23,42,0.035);
  --focus-ring:rgba(253,74,5,0.22);
  --line:#e2e8f0;
  --line-light:#f1f5f9;
  --line-subtle:#cbd5e1;
  --ink:#0f172a;
  --ink-heading:#020617;
  --muted:#5e6c80;
  --muted-dark:#334155;
  --brand:#fd4a05;
  --brand-hover:#a9360a;
  --brand-dim:#c2410c;
  --brand-ink:#ffffff;
  --accent-gray:#f1f5f9;
  --accent-gray-hover:#e2e8f0;
  --danger:#dc2626;
  --danger-hover:#b91c1c;
  --danger-ink:#991b1b;
  --danger-bg:#fef2f2;
  --danger-panel:#fffafb;
  --danger-line:#fecaca;
  --warn:#a16207;
  --warn-bg:#fffbeb;
  --warn-line:#fde68a;
  --ok:#15803d;
  --ok-bg:#f0fdf4;
  --ok-line:#bbf7d0;
  --shadow-sm:0 1px 2px rgba(15,23,42,0.05);
  --shadow-md:0 4px 10px -2px rgba(15,23,42,0.08),0 2px 4px -2px rgba(15,23,42,0.04);
  --shadow-lg:0 12px 24px -4px rgba(15,23,42,0.09),0 4px 8px -4px rgba(15,23,42,0.04);
  --glow-subtle:0 0 0 1px rgba(15,23,42,0.05);
  --radius-sm:6px;
  --radius-md:8px;
  --radius-lg:14px;
  --radius-xl:16px;
  --font-sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;

  /* Auth / Login Page Layout (light only) */
  --auth-bg:#f8fafc;
  --auth-pane-bg:#ffffff;
  --auth-border:#e2e8f0;
  --auth-text:#0f172a;
  --auth-muted:#64748b;
  --auth-input-bg:#ffffff;
  --auth-input-border:#cbd5e1;
  --auth-input-focus:#fd4a05;
  --auth-btn-bg:#0f172a;
  --auth-btn-ink:#ffffff;
  --auth-btn-hover:#1e293b;
}
*{box-sizing:border-box}
html,body{min-height:100%}
body{
  margin:0;
  background-color:var(--canvas);
  color:var(--ink);
  font:14px/1.55 var(--font-sans);
  letter-spacing:-0.006em;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
.ops-body{position:relative;min-height:100vh;padding-left:var(--rail-width)}
.shell{
  max-width:1440px;
  margin:auto;
  padding:32px clamp(20px,3vw,48px) 64px;
  position:relative;
  z-index:1;
}
.admin-viewport{overflow-anchor:none;position:relative;max-width:1440px;margin:0 auto;min-height:160px;contain:layout;overflow-anchor:none}
.admin-page-container{display:none;min-height:inherit}
.admin-page-container.is-active{display:block;position:relative}
.admin-page-container.is-leaving{display:none}
.admin-preload-frame{position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none}
@media(prefers-reduced-motion:reduce){.admin-page-container{transition:none;transform:none}.admin-page-container.is-leaving{visibility:hidden}}
.workspace{padding-top:4px}

/* Persistent product navigation; page shells also live inside the SPA viewport. */
.app-header{position:sticky;top:0;z-index:100;min-height:var(--header-height);margin-left:calc(-1 * var(--rail-width));background:var(--panel);border-bottom:1px solid var(--line);view-transition-name:app-header}
.header-inner{min-height:var(--header-height);padding:0 24px;display:flex;align-items:center;justify-content:space-between;gap:20px}
.header-left{display:flex;align-items:center;min-width:0}
.brand{display:inline-flex;align-items:center;flex-shrink:0;color:var(--ink-heading);text-decoration:none}
.brand-copy{display:none}
.header-mesh-mark{display:block;width:160px;height:40px;flex-shrink:0}
.header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
.nav-rail{position:fixed;left:0;top:var(--header-height);bottom:0;width:var(--rail-width);padding:24px 14px;background:var(--panel);border-right:1px solid var(--line);overflow-y:auto}
.control-nav{display:flex;flex-direction:column;gap:6px;margin:0;padding:0}
.control-nav a{display:flex;align-items:center;gap:12px;min-height:44px;padding:10px 14px;border-radius:var(--radius-md);color:var(--muted-dark);font-size:14px;font-weight:550;text-decoration:none;transition:background-color .12s ease,color .12s ease}
.control-nav a:hover{background:var(--panel-subtle);color:var(--ink-heading)}
.control-nav a.active{background:#fff0e8;color:var(--brand-dim);font-weight:650}
.nav-icon{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

/* Language Switcher */
.language-switch{
  display:inline-flex;
  align-items:center;
  gap:2px;
  padding:2px;
  border:1px solid var(--line);
  border-radius:999px;
  background:var(--panel-elevated);
  box-shadow:var(--shadow-sm);
}
.language-switch a{
  min-width:36px;
  min-height:32px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:5px 10px;
  border-radius:999px;
  color:var(--muted);
  font-size:11px;
  font-weight:600;
  letter-spacing:0.02em;
  text-align:center;
  text-decoration:none;
  transition:all 0.12s ease;
}
.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.language-switch a[aria-current=true]{
  color:var(--brand-ink);
  background:var(--ink-heading);
}
.auth-body>.language-switch{
  position:fixed;
  top:20px;
  right:20px;
  z-index:20;
  background:rgba(255,255,255,0.92);
  border-color:var(--line);
  backdrop-filter:blur(8px);
}
.auth-body>.language-switch a{color:var(--muted)}
.auth-body>.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.auth-body>.language-switch a[aria-current=true]{color:var(--brand-ink);background:var(--brand-dim)}

${componentsStyles}${surfacesStyles}${pagesStyles}${responsiveStyles}${tablesStyles}</style>`; }
