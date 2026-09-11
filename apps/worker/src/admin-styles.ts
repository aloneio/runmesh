// Static stylesheet for the admin console.
//
// Extracted verbatim from index.ts so the request-handling module stays navigable.
// The template is a pure constant: it contains no interpolations, so it captures
// nothing from its former scope.

export function adminStyles(): string { return `<style>
@view-transition{navigation:auto}
::view-transition-old(app-header),::view-transition-new(app-header){animation:none}
:root{
  color-scheme:light;
  --canvas:#f4f6f8;
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
  --muted:#64748b;
  --muted-dark:#334155;
  --brand:#fd4a05;
  --brand-hover:#e03e00;
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
  --warn:#d97706;
  --warn-bg:#fffbeb;
  --warn-line:#fde68a;
  --ok:#16a34a;
  --ok-bg:#f0fdf4;
  --ok-line:#bbf7d0;
  --shadow-sm:0 1px 2px rgba(15,23,42,0.05);
  --shadow-md:0 4px 10px -2px rgba(15,23,42,0.08),0 2px 4px -2px rgba(15,23,42,0.04);
  --shadow-lg:0 12px 24px -4px rgba(15,23,42,0.09),0 4px 8px -4px rgba(15,23,42,0.04);
  --glow-subtle:0 0 0 1px rgba(15,23,42,0.05);
  --radius-sm:6px;
  --radius-md:8px;
  --radius-lg:12px;
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
  background-image:
    radial-gradient(1200px 600px at 50% -10%, rgba(253,74,5,0.04) 0%, transparent 60%),
    linear-gradient(180deg, var(--panel-card) 0%, var(--canvas) 100%);
  background-attachment:fixed;
  color:var(--ink);
  font:14px/1.55 var(--font-sans);
  letter-spacing:-0.006em;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
body::before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size:32px 32px;
  mask-image:linear-gradient(180deg, #000 0%, rgba(0,0,0,0.4) 40%, transparent 80%);
  z-index:0;
}
.ops-body{position:relative;min-height:100vh}
.shell{
  max-width:1440px;
  margin:auto;
  padding:24px 32px 64px;
  position:relative;
  z-index:1;
}
.admin-viewport{position:relative;max-width:1440px;margin:0 auto;min-height:160px;contain:layout;overflow-anchor:none}
.admin-page-container{position:absolute;inset:0;min-height:inherit;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(5px);will-change:opacity,transform;transition:opacity 160ms ease,transform 180ms ease,visibility 0s linear 180ms}
.admin-page-container.is-active{position:relative;opacity:1;visibility:visible;pointer-events:auto;transform:none;transition-delay:0s}
.admin-page-container.is-leaving{position:absolute;inset:0;visibility:visible;opacity:0;pointer-events:none;transform:translateY(-3px);z-index:0}
.admin-preload-frame{position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none}
@media(prefers-reduced-motion:reduce){.admin-page-container{transition:none;transform:none}.admin-page-container.is-leaving{visibility:hidden}}
.workspace{padding-top:4px}

/* Header & Control Navigation */
.app-header{
  position:sticky;
  top:0;
  z-index:100;
  height:57px;
  min-height:64px;
  view-transition-name:app-header;
  background:var(--panel);
  /* Keep the header on one composited layer while pages and command tabs
     replace their content. This avoids a translucent backdrop repaint flash. */
  isolation:isolate;
  contain:layout paint;
  transform:translateZ(0);
  backface-visibility:hidden;
  border-bottom:1px solid var(--line);
  box-shadow:var(--shadow-sm);
}
.header-inner{
  max-width:1440px;
  margin:auto;
  padding:0 32px;
  height:56px;
  min-height:56px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:24px;
}
.header-left{
  display:flex;
  align-items:center;
  gap:24px;
  min-width:0;
}
.brand{
  color:var(--ink-heading);
  font-size:15px;
  font-weight:700;
  letter-spacing:0.01em;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  gap:10px;
  flex-shrink:0;
}
.brand-copy{display:none}
.brand-copy span{font-size:15px;font-weight:700;letter-spacing:-0.01em;color:var(--ink-heading)}
.brand-copy small{
  margin:2px 0 0;
  font-size:11px;
  font-weight:600;
  letter-spacing:0.06em;
  text-transform:uppercase;
  color:var(--muted);
}
.header-mesh-mark{
  display:block;
  width:160px;
  height:40px;
  min-width:160px;
  min-height:40px;
  flex-shrink:0;
}
.control-nav{
  display:flex;
  gap:3px;
  margin:0;
  padding:3px;
  background:var(--panel-subtle);
  border:1px solid var(--line-light);
  border-radius:var(--radius-md);
  width:fit-content;
}
.control-nav a{
  padding:5px 12px;
  color:var(--muted-dark);
  text-decoration:none;
  border-radius:var(--radius-sm);
  font-weight:600;
  font-size:13px;
  letter-spacing:0.01em;
  transition:all 0.12s ease;
  white-space:nowrap;
}
.control-nav a:hover{color:var(--ink-heading);background:var(--header-hover)}
.control-nav a.active{
  color:var(--brand-ink);
  background:var(--ink-heading);
  box-shadow:var(--shadow-sm);
}
.header-actions{
  display:flex;
  align-items:center;
  gap:10px;
  flex-shrink:0;
}

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
  min-width:32px;
  padding:3px 8px;
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

/* Typography & Headings */
h1,h2,h3{
  line-height:1.25;
  margin:0 0 8px;
  color:var(--ink-heading);
  letter-spacing:-0.02em;
}
h1{font-size:22px;font-weight:700}
h2{font-size:16px;font-weight:650;letter-spacing:-0.01em}
h3{font-size:12px;color:var(--muted-dark);text-transform:uppercase;letter-spacing:0.06em;font-weight:650}
.page-heading{
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:24px;
  margin-bottom:20px;
}
.eyebrow,.brand-kicker{
  color:var(--muted);
  font-size:11px;
  font-weight:650;
  letter-spacing:0.06em;
  text-transform:uppercase;
  margin:0 0 4px;
}
.lede,.muted,.subtitle{color:var(--muted)}
.lede,.subtitle{margin:0 0 10px;max-width:64ch;font-size:13.5px;line-height:1.55}
.font-11{font-size:11px!important}
.font-12{font-size:12px!important}
.font-16{font-size:16px!important}

/* Detail Header */
.detail-header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:20px;
  margin-bottom:20px;
  padding:16px 20px;
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  box-shadow:var(--shadow-sm);
}
.detail-title-group{
  display:flex;
  flex-direction:column;
  gap:3px;
}
.detail-title-row{
  display:flex;
  align-items:center;
  gap:10px;
  flex-wrap:wrap;
}
.detail-title{
  font-size:20px;
  font-weight:700;
  margin:0;
  color:var(--ink-heading);
}
.detail-id{
  font-size:13px;
  color:var(--muted);
  margin:0;
}
.detail-header-actions{
  display:flex;
  align-items:center;
  gap:10px;
}

/* Metrics Dashboard Grid */
.metrics{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
  margin-bottom:20px;
}
.metric,.panel,.auth-card,.enrollment-dialog{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius-lg);
  box-shadow:var(--shadow-sm);
  position:relative;
}
.metric{
  padding:14px 16px 13px;
  overflow:hidden;
  background:var(--panel);
  border-color:var(--line);
  transition:border-color 0.15s ease,box-shadow 0.15s ease;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
}
.metric:hover{
  border-color:var(--line-subtle);
  box-shadow:var(--shadow-md);
}
.metric-label,.metric span:first-child{
  display:block;
  color:var(--muted);
  font-size:11px;
  font-weight:650;
  letter-spacing:0.04em;
  text-transform:uppercase;
  margin-bottom:6px;
}
.metric-value,.metric strong{
  font-size:22px;
  font-weight:700;
  letter-spacing:-0.02em;
  color:var(--ink-heading);
  display:block;
}
.metric-meta{
  display:inline-flex;
  align-items:center;
  gap:5px;
  margin-top:6px;
  font-size:12px;
  color:var(--muted);
}
.mono-truncate{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:16px!important;
}

/* Panels & Layout Grids */
.grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:20px}
.panel{
  padding:18px 20px;
  margin-bottom:20px;
  background:var(--panel);
}
.danger-panel{
  border-color:var(--danger-line);
  background:var(--danger-panel);
}
.section-title{
  display:flex;
  justify-content:space-between;
  gap:14px;
  align-items:center;
  margin-bottom:14px;
  padding-bottom:4px;
}
.section-title h2{margin:0}
.section-title a{
  color:var(--muted-dark);
  font-weight:600;
  font-size:13px;
  text-decoration:none;
  transition:color 0.12s ease;
}
.section-title a:hover{color:var(--ink-heading);text-decoration:underline}

/* Add Panels */
.add-panel{
  background:var(--panel-card);
  border:1px solid var(--line);
}
.form-grid.add-form-grid,.form-grid.add-client-grid{
  display:flex;
  align-items:flex-end;
  gap:12px;
  flex-wrap:wrap;
}
.form-grid.add-form-grid > label,.form-grid.add-client-grid > label:not(.check){flex:1 1 200px}
.add-client-grid fieldset{flex:2 1 300px}
.form-submit-wrap{
  display:flex;
  align-items:flex-end;
  margin-bottom:1px;
}
.full-width-submit{
  width:100%;
  margin-top:8px;
}
.form-grid .full-width-submit{grid-column:1 / -1}
.full-width-submit button{width:100%}

/* Tables & Data Rows */
.table-wrap{
  overflow-x:auto;
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  background:var(--panel);
}
.table-wrap::after{
  content:"Scroll horizontally to see more";
  display:none;
  padding:6px 10px;
  color:var(--muted);
  font-size:11px;
  border-top:1px solid var(--line-light);
  background:var(--panel-card);
}
html[lang="zh-CN"] .table-wrap::after{content:"左右滑动查看更多"}
table,.data-table{border-collapse:collapse;width:100%;min-width:760px;font-size:13.5px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line-light);vertical-align:middle}
th{
  color:var(--muted-dark);
  font-size:11px;
  font-weight:650;
  text-transform:uppercase;
  letter-spacing:0.05em;
  background:var(--panel-card);
  border-bottom:1px solid var(--line);
}
tbody tr{transition:background-color 0.12s ease}
tbody tr:hover{background:var(--surface-hover)}
tr:last-child td{border-bottom:0}
.table-primary-cell{
  display:flex;
  flex-direction:column;
  gap:2px;
}
.strong{font-weight:650;color:var(--ink-heading);text-decoration:none}
a.strong:hover{color:var(--brand-hover);text-decoration:underline}
.sub-id,small{display:block;color:var(--muted);font-size:12px;font-family:var(--font-mono)}
.num-cell{font-variant-numeric:tabular-nums;font-weight:600}
.time-cell{font-family:var(--font-mono);font-size:12px;color:var(--muted)}
.platform-tag{
  display:inline-block;
  padding:2px 7px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-sm);
  font-size:11.5px;
  font-family:var(--font-mono);
  color:var(--muted-dark);
}
.routing-badge{
  display:inline-block;
  padding:2px 8px;
  background:var(--accent-gray);
  border:1px solid var(--line-subtle);
  border-radius:var(--radius-sm);
  font-size:12px;
  font-weight:600;
  color:var(--ink-heading);
}
.runner-selection-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.runner-selection-form{
  display:flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
  margin:0;
}
.runner-selection-form select{min-width:150px;max-width:100%;height:30px;padding:3px 8px;font-size:12px}
.runner-selection-form .check{font-size:11px;white-space:nowrap}
.runner-selection-form button{height:30px}

/* Action Groups & Forms */
.action-btn-group{
  display:inline-flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
}
.actions{
  width:360px;
  min-width:360px;
  vertical-align:top;
}
.actions .action-btn-group{
  display:flex;
  align-items:stretch;
  flex-direction:column;
  gap:6px;
  min-width:0;
}
.actions .action-btn-group > *{min-width:0}
.actions .action-btn-group > a.button{align-self:flex-start}
.actions .inline-action-form{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:center;
  width:100%;
  min-width:0;
}
.actions .inline-action-form > input:not([type=hidden]){min-width:0;max-width:none;width:100%}
.actions .execution-mode-inline{
  min-width:0;
  width:100%;
  flex-wrap:wrap;
}
.actions .execution-mode-inline .privileged-host-warning{display:none!important}
.actions .execution-mode-inline .check{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.actions .execution-mode-inline .check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inline-action-form{
  display:inline-flex;
  align-items:center;
  gap:6px;
  margin:0;
}
.inline-action-form input{
  padding:3px 8px;
  font-size:12px;
  height:28px;
  max-width:140px;
}
.execution-mode-inline{
  display:inline-flex;
  align-items:center;
  gap:5px;
  padding:4px 6px;
  min-width:230px;
  position:relative;
  background:var(--panel-card);
}
.execution-mode-inline legend{font-size:10px}
.execution-mode-inline label:not(.check){
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  gap:4px;
  font-size:11px;
  white-space:nowrap;
}
.execution-mode-inline select{
  height:27px;
  padding:2px 5px;
  font-size:11px;
  max-width:190px;
}
.execution-mode-inline .check{
  margin:0;
  font-size:11px;
  white-space:nowrap;
}
.execution-mode-inline .check span{display:inline}
.execution-mode-inline .privileged-host-warning{
  position:absolute;
  z-index:5;
  width:min(440px,80vw);
  margin:30px 0 0;
  padding:7px 9px;
  font-size:11px;
  line-height:1.35;
}
.danger-action label{
  font-size:11.5px;
  color:var(--muted-dark);
  font-weight:500;
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  gap:4px;
}
.danger-action input{
  max-width:110px;
  border-color:var(--danger-line);
}

/* Client Detail Overrides & Scopes */
.mode-pill{
  display:inline-block;
  padding:2px 7px;
  border-radius:999px;
  font-size:11.5px;
  font-weight:600;
}
.mode-pill.global{background:var(--panel-card);border:1px solid var(--line);color:var(--muted-dark)}
.mode-pill.custom{background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn)}
.override-form-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  width:100%;
}
.perm-selects-wrap{
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}
.perm-select-label{
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  gap:5px;
  font-size:12px;
  font-weight:600;
  color:var(--muted-dark);
}
.perm-select-label select{
  padding:2px 6px;
  font-size:12px;
  height:26px;
  border-radius:var(--radius-sm);
}
.override-actions{
  display:flex;
  align-items:center;
  gap:6px;
  flex-shrink:0;
}
.active-scopes-box{
  padding:10px 12px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  margin-bottom:14px;
}
.active-scopes-box .scope-line{margin:4px 0 0}
.scope-help{font-size:13px;line-height:1.6;margin:0 0 14px;max-width:72ch}
.scope-tags{
  display:flex;
  gap:4px;
  flex-wrap:wrap;
}
.scope-pill{
  display:inline-block;
  padding:1px 6px;
  background:var(--panel-subtle);
  border:1px solid var(--line-light);
  border-radius:var(--radius-sm);
  font-size:11.5px;
  font-family:var(--font-mono);
  color:var(--ink);
}
.scope-selector-row{
  display:flex;
  gap:12px;
  align-items:center;
  flex-wrap:wrap;
}
.scope-editor-form{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:end;
  gap:12px;
}
.scope-fieldset{
  flex:1;
  min-width:0;
  background:var(--panel-card);
}

/* Card Lists */
.card-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  text-decoration:none;
  padding:8px 10px;
  border-radius:var(--radius-md);
  margin:0 -10px;
  transition:background-color 0.12s ease;
}
.card-row:hover{background:var(--accent-gray)}
.card-row-main{
  display:flex;
  flex-direction:column;
  gap:3px;
  min-width:0;
}
.card-row-sub{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-size:12px;
  color:var(--muted);
}
.meta-separator{color:var(--line-subtle)}
.platform-meta,.client-runner-meta{font-size:12px}
.card-row-aside{
  display:flex;
  align-items:center;
  color:var(--muted);
}
.row-arrow{
  font-size:14px;
  transition:transform 0.12s ease;
}
.card-row:hover .row-arrow{
  transform:translateX(3px);
  color:var(--brand);
}

/* Buttons */
.button,button{
  appearance:none;
  border:1px solid var(--ink-heading);
  background:var(--ink-heading);
  border-radius:var(--radius-md);
  color:var(--brand-ink);
  cursor:pointer;
  font:inherit;
  font-size:13px;
  font-weight:600;
  letter-spacing:0.01em;
  padding:6px 14px;
  text-decoration:none;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  transition:all 0.14s ease;
  min-height:34px;
  white-space:nowrap;
}
.button:hover,button:hover{
  background:var(--brand-hover);
  border-color:var(--brand-hover);
}
.button.secondary,button.secondary{
  background:var(--panel-elevated);
  color:var(--ink);
  border-color:var(--line-subtle);
}
.button.secondary:hover,button.secondary:hover{
  background:var(--accent-gray);
  border-color:var(--muted-dark);
  color:var(--ink-heading);
}
.button.small,button.small{
  font-size:12px;
  font-weight:600;
  padding:3px 8px;
  min-height:28px;
  border-radius:var(--radius-sm);
}
.button.copied,button.copied{
  background:var(--ok);
  border-color:var(--ok);
  color:var(--brand-ink);
}
.danger{
  color:var(--brand-ink)!important;
  border-color:var(--danger)!important;
  background:var(--danger)!important;
}
.danger:hover{
  background:var(--danger-hover)!important;
  border-color:var(--danger-hover)!important;
  box-shadow:0 0 0 2px var(--danger-line)!important;
}

/* Badges, Status Dots & Status Pills */
.badge,.job-status{
  border-radius:999px;
  display:inline-flex;
  align-items:center;
  gap:5px;
  font-size:11.5px;
  font-weight:600;
  padding:2px 8px;
  text-transform:capitalize;
  letter-spacing:0.02em;
  border:1px solid transparent;
  line-height:1.2;
}
.status-dot{
  width:6px;
  height:6px;
  border-radius:50%;
  display:inline-block;
  flex-shrink:0;
}
.status-dot.online,.job-status.running .status-dot,.job-status.succeeded .status-dot,.job-status.completed .status-dot{background:#16a34a}
.status-dot.offline,.status-dot.unknown,.job-status.unknown .status-dot{background:#9ca3af}
.status-dot.stale,.status-dot.pending,.job-status.queued .status-dot,.job-status.cancelling .status-dot{background:#d97706}
.status-dot.invalid,.job-status.failed .status-dot,.job-status.cancelled .status-dot,.job-status.interrupted .status-dot{background:#dc2626}
.badge.online,.job-status.running{
  background:var(--ok-bg);
  color:var(--ok);
  border-color:var(--ok-line);
}
.badge.offline{
  background:var(--accent-gray);
  color:var(--muted-dark);
  border-color:var(--line);
}
.badge.stale,.badge.pending,.job-status.queued,.job-status.cancelling{
  background:var(--warn-bg);
  color:var(--warn);
  border-color:var(--warn-line);
}
.badge.invalid,.job-status.failed,.job-status.cancelled,.job-status.interrupted{
  background:var(--danger-bg);
  color:var(--danger);
  border-color:var(--danger-line);
}
.job-status.succeeded,.job-status.completed{
  background:var(--ok-bg);
  color:var(--ok);
  border-color:var(--ok-line);
}
.job-status.unknown{
  background:var(--accent-gray);
  color:var(--muted-dark);
  border-color:var(--line);
}
.status-pill{
  display:inline-block;
  padding:2px 8px;
  border-radius:var(--radius-sm);
  font-size:12px;
  font-weight:600;
  border:1px solid var(--line);
  background:var(--panel-card);
}
.status-pill.applied{border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)}
.status-pill.invalid{border-color:var(--danger-line);background:var(--danger-bg);color:var(--danger)}
.status-pill.pending{border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)}
.workspace-pill{
  display:inline-block;
  padding:2px 7px;
  border-radius:var(--radius-sm);
  font-family:var(--font-mono);
  font-size:12px;
  background:var(--panel-card);
  border:1px solid var(--line);
  color:var(--ink);
}

/* Forms & Inputs */
.form-grid{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  align-items:end;
  gap:12px;
}
label{
  display:flex;
  flex-direction:column;
  gap:4px;
  font-weight:600;
  font-size:13px;
  color:var(--ink-heading);
}
input,select,textarea{
  border:1px solid var(--line-subtle);
  border-radius:var(--radius-md);
  padding:7px 10px;
  font:inherit;
  font-size:13.5px;
  color:var(--ink-heading);
  min-width:0;
  background:var(--panel-elevated);
  transition:border-color 0.14s ease,box-shadow 0.14s ease;
}
input:hover,select:hover{border-color:var(--muted-dark)}
input:focus,select:focus{
  outline:none;
  border-color:var(--brand);
  box-shadow:0 0 0 3px var(--focus-ring);
}
fieldset{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:8px 12px;
  margin:0;
  background:var(--panel-card);
}
legend{
  padding:0 5px;
  color:var(--muted-dark);
  font-size:11px;
  font-weight:650;
  letter-spacing:0.05em;
  text-transform:uppercase;
}
.check{
  display:inline-flex;
  flex-direction:row;
  align-items:center;
  font-weight:500;
  font-size:13px;
  margin:4px 12px 4px 0;
  cursor:pointer;
}
.check span{display:flex;flex-direction:column;gap:1px}
.check small{font-family:var(--font-sans);font-size:11.5px;line-height:1.35;color:var(--muted)}
.check input{min-width:auto;accent-color:var(--brand);cursor:pointer}
.stack{display:flex;flex-direction:column;gap:12px;max-width:500px}

/* Runner Permission Profile & Workspaces */
.permission-profile-grid{
  display:flex;
  flex-direction:column;
  gap:12px;
}
.perm-selects-row{
  display:grid;
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:10px;
  width:100%;
}
.workspace-list{list-style:none;padding:0;margin:0 0 16px}
.workspace-card{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:14px 16px;
  margin-bottom:12px;
  background:var(--panel-card);
}
.workspace-form{
  display:flex;
  flex-direction:column;
  gap:10px;
}
.workspace-main-grid{
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:12px;
  margin-bottom:12px;
}
.grid-span-2{grid-column:span 2}
.workspace-perms-section{
  padding-top:10px;
  border-top:1px solid var(--line-light);
  margin-bottom:12px;
}
.workspace-perms-section .form-stat-label{margin-bottom:8px;display:block}
.workspace-btn-bar{
  display:flex;
  justify-content:flex-end;
}
.workspace-footer{
  margin-top:12px;
  padding-top:10px;
  border-top:1px solid var(--line);
  display:flex;
  justify-content:space-between;
  align-items:center;
  flex-wrap:wrap;
  gap:10px;
}
.inline-delete-form{
  display:flex;
  align-items:flex-end;
  flex-wrap:wrap;
  gap:8px;
  min-width:0;
  margin:0;
}
.inline-delete-form label{min-width:0;flex:1 1 180px}
.inline-delete-form input{max-width:100%}
.add-workspace-box{
  margin-top:18px;
  padding:16px;
  border:1px dashed var(--line-subtle);
  border-radius:var(--radius-md);
  background:var(--panel-card);
}
.add-workspace-box h3{margin:0 0 12px}
.full-host-label{
  grid-column:span 2;
}
.check-line{
  display:inline-flex;
  align-items:center;
  gap:6px;
  font-weight:500;
  font-size:13px;
  color:var(--muted-dark);
}
.empty-item{padding:10px 0;font-style:italic}

/* Tool Grid */
.tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.tool-item{
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  padding:10px 12px;
  background:var(--panel-card);
  display:flex;
  flex-direction:column;
  gap:4px;
}
.tool-name-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
}
.tool-name{color:var(--ink-heading);font-size:13.5px;font-weight:650}
.tool-version{font-size:12px;color:var(--muted)}

/* Version Policy */
.version-policy-form{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px;
}
.version-stat{
  display:flex;
  flex-direction:column;
  gap:2px;
  padding:6px 10px;
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  background:var(--panel-card);
}
.form-stat-label{
  font-size:11px;
  font-weight:650;
  color:var(--muted);
  text-transform:uppercase;
  letter-spacing:0.04em;
}
.version-stat strong{
  font-size:13.5px;
  color:var(--ink-heading);
}
.policy-status-foot{margin-top:10px;font-size:12.5px}

/* Danger Zone */
.danger-zone{
  margin-top:16px;
  padding-top:14px;
  border-top:1px solid var(--line);
}
.danger-zone h3,.danger-title{
  margin:0 0 6px;
  color:var(--danger-ink);
}
.emergency-lock-form{margin-top:8px}

/* Settings Page */
.settings-form{max-width:400px}
.settings-note{font-size:13.5px;line-height:1.55}
.logout-box{margin-top:16px}

/* Empty State Box */
.empty-state-box{
  padding:24px 16px;
  text-align:center;
}
.empty-state-box p{margin:0;color:var(--muted)}
.empty-desc{font-size:13.5px}

/* Details & Lists */
.item-list,.plain-list{list-style:none;padding:0;margin:0}
.item-list li{border-bottom:1px solid var(--line-light);padding:2px 0}
.item-list li:last-child{border:0}
.empty{
  color:var(--muted);
  padding:24px 16px;
  text-align:center;
  border:1px dashed var(--line);
  border-radius:var(--radius-md);
  background:var(--panel-card);
}
.details{
  display:grid;
  grid-template-columns:160px 1fr;
  gap:10px 14px;
  margin:0;
  font-size:13.5px;
}
.details dt{
  color:var(--muted);
  font-size:11.5px;
  font-weight:650;
  text-transform:uppercase;
  letter-spacing:0.04em;
}
.details dd{margin:0;font-weight:600;color:var(--ink-heading);overflow-wrap:anywhere}

/* Secret & Enrollment Full-Page Dialogs */
.auth-body{
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  padding:0;
  background:var(--auth-bg);
  color:var(--auth-text);
}
.auth-body::before{display:none}
.auth-shell{
  width:min(460px,92%);
  margin:auto;
  position:relative;
  z-index:2;
}
.secret-result-shell{max-width:760px;padding-top:48px;padding-bottom:48px}
.secret-result-shell .secret-card{width:min(620px,100%);margin:0 auto}
.auth-card{
  padding:32px 28px;
  box-shadow:var(--shadow-lg);
  background:var(--auth-pane-bg);
  border:1px solid var(--auth-border);
  border-radius:var(--radius-xl);
  color:var(--auth-text);
}
.auth-card h1{color:var(--auth-text)}
.auth-card .lede{color:var(--auth-muted)}
.secret-brand-row{
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:16px;
}
.secret-mesh-mark,.error-mesh-mark{
  display:block;
  width:210px;
  height:62px;
  object-fit:cover;
  object-position:center 50%;
  padding:2px 7px;
  border-radius:6px;
  background:transparent;
  box-shadow:var(--shadow-sm);
}
.secret-brand-row .brand-name{display:none}
.brand-name{
  font-size:16px;
  font-weight:750;
  letter-spacing:-0.01em;
  color:var(--ink-heading);
}
.secret-url,.secret-card code{
  display:block;
  overflow-wrap:anywhere;
  padding:12px;
  border-radius:var(--radius-md);
  background:var(--panel-card);
  border:1px solid var(--line);
  color:var(--ink-heading);
  margin:0 0 16px;
  font-family:var(--font-mono);
  font-size:13px;
}
.secret-actions{
  display:flex;
  gap:10px;
}
.secret-actions .button{background:var(--ink-heading);color:var(--brand-ink);border-color:var(--ink-heading)}
.secret-actions .button:hover{background:var(--brand-hover);border-color:var(--brand-hover)}
.secret-actions .button.secondary{background:var(--panel);color:var(--ink-heading);border-color:var(--line-subtle)}
.error-card{
  border-color:var(--danger-line);
  background:var(--danger-panel);
}
.enrollment-header{
  width:min(1180px,calc(100% - 40px));
  margin:18px auto 0;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
}
.enrollment-brand{display:block;flex-shrink:0}
.enrollment-brand-logo{
  display:block;
  width:170px;
  height:50px;
  object-fit:cover;
  object-position:center 50%;
  padding:2px 6px;
  border-radius:6px;
  background:#fff;
  box-shadow:var(--shadow-sm);
}
.enrollment-header-actions{display:flex;align-items:center;gap:8px}
.enrollment-shell{padding-top:24px;padding-bottom:50px}
.enrollment-dialog{
  display:block;
  position:static;
  inset:auto;
  height:auto;
  max-width:100%;
  width:min(880px,100%);
  margin:0 auto;
  padding:28px;
  color:inherit;
  border:1px solid var(--line);
  box-shadow:var(--shadow-lg);
  background:var(--panel-elevated);
}
.dialog-icon-row{margin-bottom:12px}
.dialog-mark{width:36px;height:36px;color:var(--brand)}
.enrollment-meta-box{
  padding:12px 14px;
  background:var(--panel-card);
  border:1px solid var(--line);
  border-radius:var(--radius-md);
  margin-bottom:16px;
  display:flex;
  flex-direction:column;
  gap:3px;
}
.dialog-actions{
  display:flex;
  justify-content:flex-end;
  gap:10px;
  margin-top:20px;
}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0}
.enrollment-dialog pre{
  width:100%;
  max-width:100%;
  min-width:0;
  margin:0 0 12px;
  overflow:auto;
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  word-break:break-word;
  box-sizing:border-box;
}
.enrollment-dialog pre code{
  display:block;
  min-width:0;
  white-space:inherit;
  overflow-wrap:inherit;
  word-break:inherit;
}
.tabs [role=tab]{
  background:var(--panel-card);
  color:var(--muted-dark);
  border:1px solid var(--line);
  border-radius:999px;
  padding:5px 14px;
  font-weight:600;
  font-size:13px;
  cursor:pointer;
}
.tabs [role=tab][aria-selected=true]{
  color:var(--brand-ink);
  background:var(--ink-heading);
  border-color:var(--ink-heading);
}
.enrollment-command-panels{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;width:100%;min-width:0}
.enrollment-command-panels [role=tabpanel]{grid-area:1 / 1;width:100%;box-sizing:border-box;margin-top:8px;visibility:hidden;pointer-events:none;min-width:0}
.enrollment-command-panels .button{max-width:100%;min-width:132px;color:var(--ink-heading);overflow:hidden;text-overflow:ellipsis}
/* Keep every command panel in the same grid track while switching tabs. The
   hidden panels still reserve the tallest command block, so the enrollment
   header and the rest of the page do not jump as an OS tab changes. */
.enrollment-command-panels [role=tabpanel][hidden]{display:block!important}
.enrollment-command-panels [role=tabpanel]:not([hidden]){visibility:visible;pointer-events:auto}
pre{
  overflow:auto;
  max-width:100%;
  min-width:0;
  box-sizing:border-box;
  padding:14px;
  border-radius:var(--radius-md);
  background:var(--panel-card);
  border:1px solid var(--line);
  color:var(--ink-heading);
  font-family:var(--font-mono);
  font-size:13px;
  line-height:1.5;
}
 .warning{
  border:1px solid var(--warn-line);
  background:var(--warn-bg);
  color:var(--warn);
  border-radius:var(--radius-md);
  padding:10px 14px;
   font-size:13px;
 }
 .notice{
   border:1px solid var(--line);
   background:var(--panel-subtle);
   color:var(--muted-dark);
   border-radius:var(--radius-md);
   padding:10px 14px;
   font-size:13px;
  }
 .feature-alert-dialog{
   width:min(720px,calc(100vw - 28px));
   max-height:calc(100vh - 28px);
   border:0;
   border-radius:24px;
   padding:0;
   color:var(--ink);
   background:transparent;
   box-shadow:0 28px 80px rgba(15,23,42,.30);
 }
 .feature-alert-dialog::backdrop{background:rgba(15,23,42,.34);backdrop-filter:blur(4px)}
 .feature-alert-card{
   display:block;
   margin:0;
   padding:24px;
   border:1px solid rgba(245,158,11,.34);
   border-radius:24px;
   background:linear-gradient(135deg,#fff7ed 0%,#ffffff 46%,#f8fafc 100%);
 }
 .feature-alert-heading{margin-bottom:14px}
 .feature-alert-heading h2{margin:0;font-size:22px;letter-spacing:-.03em}
 .feature-alert-list{display:grid;gap:8px;margin:0;padding:12px 14px 12px 30px}
 .feature-alert-list li{padding:2px 0}
 .feature-alert-list .notice-message{display:block;margin-top:2px;color:var(--warn);font-size:12px;line-height:1.45}
 .feature-alert-list .notice-code{display:inline-block;margin-top:3px;color:var(--muted-dark)}
  .diagnostic-warning-list{margin:14px 0 0;padding:10px 14px 10px 30px}
 .diagnostic-subheading{margin:18px 0 8px;font-size:13px;color:var(--ink-heading)}
 .diagnostic-list{display:flex;flex-direction:column;gap:7px}
 .diagnostic-list li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0;border-bottom:1px solid var(--line-light)}
 .diagnostic-list li:last-child{border-bottom:0}
 .execution-mode-fieldset{grid-column:1 / -1;display:grid;gap:4px}
 .execution-mode-fieldset .privileged-host-warning{margin:8px 0}
 .execution-mode-fieldset [data-privileged-confirmation]{accent-color:var(--brand)}
:focus-visible{
  outline:2px solid var(--brand);
  outline-offset:2px;
}

.mono,.secret-url,.secret-card code{
  font-family:var(--font-mono);
  font-size:13px;
  letter-spacing:-0.01em;
}
.sr-only{
  position:absolute;
  width:1px;
  height:1px;
  padding:0;
  overflow:hidden;
  clip:rect(0,0,0,0);
  white-space:nowrap;
  border:0;
}
.hidden{display:none}
.scope-line{font-family:var(--font-mono);font-size:13px;color:var(--muted-dark)}

/* Responsive Breakpoints & Accessibility */
.skip-link{position:absolute;left:12px;top:-48px;z-index:200;padding:8px 12px;background:var(--panel-elevated);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--ink-heading);text-decoration:none}.skip-link:focus{top:12px}
@media(prefers-reduced-motion: reduce){
  *,*::before,*::after{
    animation-duration:0.01ms!important;
    animation-iteration-count:1!important;
    transition-duration:0.01ms!important;
    scroll-behavior:auto!important;
  }
  .button:hover,button:hover,.metric:hover,.row-arrow{
    transform:none!important;
  }
}
@media(max-width:920px){
  .header-inner{padding:0 18px}
  .header-left{gap:16px}
  .control-nav a{padding:5px 9px;font-size:12.5px}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .grid-two{grid-template-columns:1fr}
}
@media(max-width:1100px){
  .header-inner{gap:12px}
  .header-left{gap:12px}
  .header-actions{gap:6px}
  .header-actions .button{padding-left:9px;padding-right:9px;font-size:12.5px}
}
@media(max-width:1100px) and (min-width:1001px){
  .header-left{flex:1 1 auto;min-width:0;overflow:hidden}
  .control-nav{flex:0 1 auto;min-width:0;width:fit-content;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar{display:none;height:0}
}
@media(max-width:1000px) and (min-width:801px){
  .header-inner{height:auto;flex-direction:column;align-items:stretch;gap:8px;padding:6px 18px}
  .header-left{flex-direction:row;align-items:center;gap:12px;min-width:0;overflow:hidden}
  .control-nav{flex:1 1 auto;min-width:0;width:auto;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar{display:none;height:0}
  .header-actions{justify-content:flex-start;width:100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
  .header-actions > *{flex-shrink:0}
}
@media(max-width:800px){
  .login-layout{flex-direction:column}
  .login-brand-pane{display:none}
  .login-form-pane{padding:32px 20px;width:100%;align-items:flex-start}
  .auth-header-mobile{display:block}
  .shell{padding:16px 14px 40px}
  .app-header{height:auto;padding:6px 0}
  .header-inner{height:auto;flex-direction:column;align-items:stretch;gap:8px;padding-left:14px;padding-right:14px}
  .header-left{flex-direction:row;align-items:center;gap:8px;min-width:0;overflow:hidden}
  .header-mesh-mark{width:140px;height:35px}
  .control-nav{flex:1 1 auto;min-width:0;width:auto;overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .control-nav::-webkit-scrollbar,.header-actions::-webkit-scrollbar{display:none;height:0}
  .control-nav a{padding-left:9px;padding-right:9px}
  .header-actions{justify-content:flex-start;width:100%;flex-wrap:wrap;overflow:visible;row-gap:6px;padding-bottom:0}
  .header-actions > *{flex-shrink:0}
  .header-actions .button{font-size:12px;padding:5px 9px}
  .header-actions > a.button{flex:1 1 auto;min-width:0}
  .section-title{align-items:flex-start;flex-direction:column;gap:6px}
  .section-title > .muted{max-width:100%}
  .check{margin-right:0;align-items:flex-start}
  .form-grid{grid-template-columns:1fr 1fr}
  .panel,.auth-card,.detail-header{padding:16px}
  .tool-grid,.details{grid-template-columns:1fr}
  .perm-selects-row{grid-template-columns:repeat(2,1fr)}
  .grid-two > *,.panel,.workspace-card,.workspace-form,.workspace-main-grid,.workspace-perms-section,.workspace-footer{min-width:0;max-width:100%}
  .workspace-main-grid{grid-template-columns:minmax(0,1fr)}
  .grid-span-2,.full-host-label{grid-column:1 / -1}
  .detail-id,.mono-truncate{overflow-wrap:anywhere;word-break:break-word;white-space:normal}
  .page-heading,.detail-header{flex-wrap:wrap}
  .detail-header-actions{width:100%;justify-content:flex-start}
  .table-wrap::after{display:block}
  .scope-editor-form{grid-template-columns:1fr;align-items:stretch}
  .scope-editor-form .form-submit-wrap{margin-top:0}
  .version-policy-form{grid-template-columns:1fr}
  .form-grid.add-form-grid,.form-grid.add-client-grid{flex-direction:column;align-items:stretch}
  .form-grid.add-form-grid > label,.form-grid.add-client-grid > label:not(.check),.form-grid.add-client-grid fieldset,.form-grid.add-form-grid .form-submit-wrap,.form-grid.add-client-grid .form-submit-wrap{width:100%;flex:1 1 auto}
  .add-client-grid fieldset .scope-selector-row{align-items:flex-start}
  .login-brand-logo{width:190px;height:58px}
  .secret-mesh-mark,.error-mesh-mark{width:190px;height:56px}
  .enrollment-header{width:calc(100% - 28px);margin-top:12px;gap:10px;flex-wrap:wrap}
  .enrollment-brand-logo{width:148px;height:44px;padding:2px 5px}
  .enrollment-header-actions{gap:6px;margin-left:auto}
  .enrollment-shell{padding-top:16px}
  .enrollment-dialog{position:static;inset:auto;height:auto;max-width:100%;min-width:0;padding:18px;overflow:hidden}
  .enrollment-dialog .page-heading,.enrollment-dialog .enrollment-meta-box,.enrollment-dialog [role="tabpanel"]{min-width:0;max-width:100%}
  .enrollment-dialog .mono{overflow-wrap:anywhere;word-break:break-word}
  .enrollment-dialog pre{width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden}
  .enrollment-dialog pre code{white-space:inherit;overflow-wrap:inherit;word-break:inherit}
}
@media(max-width:540px){
  .header-left{flex-wrap:wrap;row-gap:8px}
  .header-left .control-nav{flex:1 1 100%;width:100%;overflow-x:visible;flex-wrap:wrap;row-gap:2px}
  .card-row{align-items:flex-start;gap:8px;min-width:0}
  .card-row-main{min-width:0;max-width:100%}
  .card-row-sub{display:flex;flex-wrap:wrap;min-width:0;max-width:100%;row-gap:3px}
  .platform-meta,.client-runner-meta{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
  .action-btn-group{flex-wrap:nowrap}
  .action-btn-group > *{flex:0 0 auto}
  .action-btn-group .danger-action label{white-space:nowrap}
  .actions{width:300px;min-width:300px}
  .metrics{grid-template-columns:1fr}
  .form-grid{grid-template-columns:1fr}
  .perm-selects-row{grid-template-columns:1fr}
  h1{font-size:20px}
  .detail-title{font-size:17px}
  .scope-editor-form{grid-template-columns:1fr;align-items:stretch}
  .scope-editor-form .button{width:100%}
  .override-form-row{flex-direction:column;align-items:stretch}
  .table-wrap{max-width:100%}
  .form-grid{grid-template-columns:1fr}
}
/* Auth surface light layout */
:root{color-scheme:light}
.auth-body.login-entry-body{display:block;min-height:100vh;padding:0;background:var(--auth-bg);color:var(--auth-text)}
.auth-body::before{display:none}
.auth-body>.language-switch{background:rgba(255,255,255,.92);border-color:var(--line);box-shadow:0 8px 24px rgba(15,23,42,.06)}
.auth-body>.language-switch a{color:var(--muted)}
.auth-body>.language-switch a:hover{color:var(--ink-heading);background:var(--accent-gray)}
.auth-body>.language-switch a[aria-current=true]{color:#fff;background:var(--brand-dim)}
.login-layout{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(420px,.88fr);width:100%;min-height:100vh;background:#fff}
.login-brand-pane{min-height:100vh;padding:clamp(36px,6vw,84px) clamp(30px,6vw,84px) 44px;background:linear-gradient(145deg,#ffffff 0%,#f8fafc 60%,#f1f5f9 100%);border-right:1px solid #e2e8f0;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
.login-brand-pane::before{content:"";position:absolute;inset:-20%;pointer-events:none;background:radial-gradient(circle at 18% 20%,rgba(253,74,5,.1),transparent 36%),radial-gradient(circle at 86% 86%,rgba(14,30,42,.06),transparent 36%)}
.login-brand-header{position:relative;z-index:2;max-width:520px}
.login-brand-title-wrap{display:inline-flex;align-items:center;gap:10px;margin:0 0 28px;text-decoration:none}
.login-brand-logo{display:block;width:min(340px,100%);height:104px;object-fit:cover;object-position:center 50%;padding:0;border-radius:0;background:transparent;box-shadow:none}
.login-brand-title-wrap .brand-name,.login-brand-title-wrap .brand-tag{display:none}
.login-brand-header .brand-kicker{color:var(--brand-dim);margin-bottom:12px}
.login-brand-headline{max-width:480px;margin:0 0 12px;color:#0f172a;font-size:clamp(26px,3.2vw,40px);line-height:1.15;letter-spacing:-.035em}
.login-brand-desc{max-width:50ch;margin:0;color:#64748b;font-size:15px;line-height:1.65}
.mesh-network-visual{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;margin:auto 0 0;width:100%}
.mesh-canvas-wrap{position:relative;width:min(420px,100%);aspect-ratio:1;display:flex;align-items:center;justify-content:center}
.mesh-geometry-svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 12px 28px rgba(15,23,42,0.06))}

/* Bespoke logo-derived animated geometry */
.mesh-orbit-ring{transform-origin:200px 200px}
.mesh-orbit-ring-outer{animation:mesh-spin-slow 40s linear infinite}
.mesh-orbit-ring-mid{animation:mesh-spin-rev 28s linear infinite}
.mesh-orbit-ring-inner{animation:mesh-spin-slow 18s linear infinite}

.mesh-arc-a{transform-origin:200px 200px;animation:mesh-arc-pulse-a 7s ease-in-out infinite alternate}
.mesh-arc-b{transform-origin:200px 200px;animation:mesh-arc-pulse-b 7s ease-in-out infinite alternate}

.mesh-hex-outer{transform-origin:200px 200px;animation:mesh-hex-breathe 8s ease-in-out infinite}
.mesh-hex-inner{transform-origin:200px 200px;animation:mesh-spin-rev 36s linear infinite}

.mesh-core-plate{animation:mesh-core-subtle 4s ease-in-out infinite alternate}
.mesh-core-ring{transform-origin:200px 200px;animation:mesh-spin-slow 12s linear infinite}
.mesh-core-nucleus{animation:mesh-nucleus-glow 3s ease-in-out infinite alternate}

.mesh-vertex-node{transform-box:fill-box;transform-origin:center;animation:mesh-vertex-pulse 3s ease-in-out infinite}
.mesh-node-halo{transform-box:fill-box;transform-origin:center;animation:mesh-halo-wave 3s cubic-bezier(0.2,0.8,0.2,1) infinite}

.node-1,.halo-1{animation-delay:0s}
.node-2,.halo-2{animation-delay:0.5s}
.node-3,.halo-3{animation-delay:1.0s}
.node-4,.halo-4{animation-delay:1.5s}
.node-5,.halo-5{animation-delay:2.0s}
.node-6,.halo-6{animation-delay:2.5s}

.mesh-satellite{transform-origin:200px 200px}
.sat-1{animation:mesh-spin-slow 14s linear infinite}
.sat-2{animation:mesh-spin-rev 16s linear infinite}

@keyframes mesh-spin-slow{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes mesh-spin-rev{from{transform:rotate(360deg)}to{transform:rotate(0deg)}}
@keyframes mesh-arc-pulse-a{0%{transform:rotate(0deg) scale(0.98);opacity:0.75}100%{transform:rotate(24deg) scale(1.03);opacity:1}}
@keyframes mesh-arc-pulse-b{0%{transform:rotate(0deg) scale(1.02);opacity:0.8}100%{transform:rotate(-24deg) scale(0.97);opacity:1}}
@keyframes mesh-hex-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
@keyframes mesh-core-subtle{0%{transform:scale(0.97)}100%{transform:scale(1.03)}}
@keyframes mesh-nucleus-glow{0%{opacity:0.75;transform:scale(0.9)}100%{opacity:1;transform:scale(1.15)}}
@keyframes mesh-vertex-pulse{0%,100%{transform:scale(0.88);opacity:0.8}50%{transform:scale(1.2);opacity:1}}
@keyframes mesh-halo-wave{0%{transform:scale(0.6);opacity:0.8}100%{transform:scale(1.8);opacity:0}}

.mesh-visual-caption{margin-top:16px;text-align:center}
.mesh-caption-badge{display:inline-flex;align-items:center;gap:7px;padding:6px 14px;border-radius:999px;background:#fff;border:1px solid #e2e8f0;color:#334155;font-size:12px;font-weight:650;box-shadow:0 4px 12px rgba(15,23,42,.05)}
.mesh-caption-sub{margin:6px 0 0;color:#64748b;font-size:12.5px}

.login-form-pane{display:flex;align-items:center;justify-content:center;padding:54px clamp(28px,7vw,104px);background:#fff}
.login-form-container{width:min(420px,100%);display:flex;flex-direction:column}
.auth-header-mobile{display:none;margin-bottom:24px}
.login-title-group{margin-bottom:30px}
.login-title-group .brand-kicker{color:var(--brand-dim);margin-bottom:8px}
.login-title-group h1{color:#0f172a;font-size:32px;line-height:1.12;margin:0 0 7px;letter-spacing:-.04em}
.login-title-group .subtitle{color:#64748b;font-size:14px;margin:0 0 10px}
.login-invite{color:#475569;font-size:15px;margin:8px 0 0}
.login-form{width:100%;display:flex;flex-direction:column;gap:18px}
.input-group{display:flex;flex-direction:column;gap:7px}
.input-group label{color:#334155;font-size:13px;font-weight:650}
.password-input-wrap{position:relative;display:flex;align-items:center;width:100%}
.password-input-wrap input{width:100%;height:48px;background:#fff;border:1px solid #cbd5e1;border-radius:10px;color:#0f172a;padding:11px 42px 11px 14px;font-size:14px;transition:border-color .14s ease,box-shadow .14s ease}
.password-input-wrap input:hover{border-color:#94a3b8}
.password-input-wrap input:focus{border-color:var(--brand);background:#fff;box-shadow:0 0 0 4px var(--focus-ring);outline:none}
.pwd-toggle-btn{position:absolute;right:7px;top:50%;transform:translateY(-50%);background:transparent!important;border:0!important;padding:7px!important;min-height:auto!important;color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:7px;transition:color .12s ease}
.pwd-toggle-btn:hover{color:#0f172a}
.eye-icon{width:18px;height:18px}
.login-submit-btn{margin-top:8px;width:100%;height:48px;background:#0f172a;color:#fff;border:1px solid #0f172a;border-radius:10px;font-size:14px;font-weight:750;cursor:pointer;box-shadow:0 8px 18px rgba(15,23,42,.15);transition:background-color .14s ease,border-color .14s ease,transform .14s ease,box-shadow .14s ease}
.login-submit-btn:hover{background:#1e293b;border-color:#1e293b;box-shadow:0 10px 22px rgba(15,23,42,.2);transform:translateY(-1px)}
.login-submit-btn:disabled{opacity:.72;cursor:not-allowed;transform:none}
.enrollment-brand-logo,.secret-mesh-mark,.error-mesh-mark,.dialog-mark{object-fit:cover;object-position:center 50%;background:transparent;box-shadow:none}
.dialog-mark{width:64px;height:36px;padding:0}

@media(min-width:801px) and (max-height:760px){
  .login-brand-pane{padding-top:28px;padding-bottom:22px}
  .login-brand-title-wrap{margin-bottom:14px}
  .login-brand-logo{width:270px;height:82px}
  .login-brand-headline{font-size:28px}
  .login-brand-desc{font-size:13px}
  .mesh-canvas-wrap{width:min(300px,32vw)}
  .mesh-visual-caption{margin-top:8px}
}
@media(prefers-reduced-motion:reduce){
  .mesh-orbit-ring-outer,.mesh-orbit-ring-mid,.mesh-orbit-ring-inner,.mesh-arc-a,.mesh-arc-b,.mesh-hex-outer,.mesh-hex-inner,.mesh-core-plate,.mesh-core-ring,.mesh-core-nucleus,.mesh-vertex-node,.mesh-node-halo,.mesh-satellite{
    animation:none!important;
  }
}
@media(max-width:800px){
  .login-layout{display:block;min-height:100vh}
  .login-brand-pane{min-height:auto;padding:30px 24px 24px;border-right:0;border-bottom:1px solid #e2e8f0}
  .login-brand-logo{width:min(280px,86vw);height:86px}
  .login-brand-title-wrap{margin-bottom:20px}
  .login-brand-headline{font-size:26px}
  .login-brand-desc{font-size:14px}
  .mesh-network-visual{margin-top:20px}
  .mesh-canvas-wrap{width:min(280px,78vw)}
  .mesh-visual-caption{margin-top:9px}
  .login-form-pane{padding:38px 24px 52px;align-items:flex-start}
  .auth-header-mobile{display:none}
  .login-form-container{max-width:500px;margin:0 auto}
  .login-title-group h1{font-size:28px}
}
@media(max-width:480px){
  .auth-body>.language-switch{top:12px;right:12px}
  .login-brand-pane{padding:24px 18px 20px}
  .login-brand-logo{width:230px;height:72px}
  .login-brand-headline{font-size:23px}
  .mesh-canvas-wrap{width:235px}
  .login-form-pane{padding:32px 18px 42px}
  .login-title-group{margin-bottom:24px}
  .login-title-group h1{font-size:25px}
}
/* UI refinement layer: clearer hierarchy, calmer surfaces, and touch-friendly responsive controls */
.ops-body{
  background-color:#f7f8fb;
  background-image:radial-gradient(900px 420px at 50% -140px,rgba(253,74,5,.07),transparent 70%);
}
.ops-body::before{opacity:.38;background-size:40px 40px;mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.18) 32%,transparent 62%)}
.app-header{border-bottom-color:#dbe2ea;box-shadow:0 1px 0 rgba(15,23,42,.03),0 8px 24px rgba(15,23,42,.04)}
.header-inner{height:64px}
.header-mesh-mark{width:174px;height:42px}
.control-nav{background:#f3f5f8;border-color:#e1e7ee;border-radius:10px;padding:4px;gap:2px}
.control-nav a{padding:7px 14px;font-size:13px}
.control-nav a.active{background:#111827;box-shadow:0 2px 6px rgba(15,23,42,.18)}
.shell{padding-top:30px}
.page-heading{margin-bottom:24px}
.page-heading h1{font-size:28px;letter-spacing:-.035em}
.page-heading .lede{font-size:14px;color:#64748b}
.page-heading>.button{margin-top:4px}
.metrics{gap:14px;margin-bottom:24px}
.metric{min-height:118px;padding:17px 18px 15px;border-color:#e1e7ee;border-radius:12px;box-shadow:0 2px 8px rgba(15,23,42,.04)}
.metric::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,#fd4a05,#fb923c);opacity:.9}
.metric:nth-child(2)::before{background:linear-gradient(90deg,#0ea5e9,#38bdf8)}
.metric:nth-child(3)::before{background:linear-gradient(90deg,#8b5cf6,#c084fc)}
.metric:nth-child(4)::before{background:linear-gradient(90deg,#64748b,#94a3b8)}
.metric:hover{box-shadow:0 8px 22px rgba(15,23,42,.08);transform:translateY(-1px)}
.grid-two{gap:18px;margin-bottom:24px}
.panel{padding:20px 22px;margin-bottom:24px;border-color:#e1e7ee;border-radius:12px;box-shadow:0 2px 8px rgba(15,23,42,.035)}
.section-title{margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid #edf0f4}
.section-title h2{font-size:16px}
.card-row{padding:11px 12px;margin:0 -12px;border-bottom:1px solid #f0f2f5;border-radius:8px}
.card-row:last-child{border-bottom:0}
.card-row:hover{background:#f8fafc}
.table-wrap{border-color:#dfe6ed;border-radius:10px;box-shadow:0 1px 2px rgba(15,23,42,.025)}
th{padding:11px 14px;background:#f7f9fb;color:#475569}
td{padding:12px 14px}
tbody tr:hover{background:#f8fafc}
.empty-state-box{padding:30px 16px;border:1px dashed #d8e0e8;border-radius:9px;background:#fafbfd}
.button,button{min-height:36px;border-radius:8px}
.button.secondary,button.secondary{background:#fff;border-color:#d8e0e8}
.button:hover,button:hover{box-shadow:0 4px 10px rgba(253,74,5,.18)}
.status-dot{width:7px;height:7px}
@media(max-width:800px){
  .header-inner{padding-top:4px;padding-bottom:4px}
  .header-mesh-mark{width:150px;height:37px}
  .shell{padding-top:20px}
  .page-heading h1{font-size:24px}
  .metrics{gap:10px}
  .metric{min-height:104px;padding:15px 15px 13px}
  .panel{padding:16px;margin-bottom:16px}
  .section-title{padding-bottom:7px}
}
@media(max-width:800px){
  .login-brand-pane{display:block;min-height:auto;padding:22px 20px 18px;border-right:0;border-bottom:1px solid #e2e8f0}
  .login-brand-title-wrap{margin-bottom:10px}
  .login-brand-logo{width:190px;height:58px}
  .login-brand-headline{font-size:22px;margin-bottom:6px}
  .login-brand-desc{font-size:13px;line-height:1.5}
  .mesh-network-visual{display:none}
  .login-form-pane{padding:28px 20px 42px}
}@media(max-width:540px){
  .header-inner{padding-left:12px;padding-right:12px}
  .header-mesh-mark{width:138px;height:34px}
  .shell{padding:14px 12px 34px}
  .page-heading{gap:12px;margin-bottom:16px}
  .page-heading>.button{width:100%;margin-top:0}
  .metric{min-height:98px}
  .metric-value,.metric strong{font-size:20px}
  .panel{padding:14px;border-radius:10px}
}
/* Dense action cells need their own layout.  Without this, each form's
   intrinsic width expands the Runner table and makes the page unusable. */
.runner-table{min-width:0;table-layout:fixed}
.runner-table th:nth-child(1){width:19%}
.runner-table th:nth-child(2){width:10%}
.runner-table th:nth-child(3){width:16%}
.runner-table th:nth-child(4){width:18%}
.runner-table th:nth-child(5){width:12%}
.runner-table th:nth-child(6){width:25%}
.runner-table td{overflow-wrap:anywhere}
.runner-table .actions{vertical-align:top;width:auto;min-width:0;overflow:visible}
.runner-actions{display:grid;width:100%;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-items:start}
.runner-actions>a,.runner-actions>form{min-width:0}
.runner-actions>a{width:100%}
.runner-actions .inline-action-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;width:100%;align-items:center}
.runner-actions .inline-action-form:first-of-type{grid-column:1 / -1}
.row-actions-more{grid-column:1 / -1;border:1px solid var(--line);border-radius:var(--radius-sm);background:#fff;min-width:0;overflow:visible;position:relative;z-index:1}
.row-actions-more summary{cursor:pointer;padding:6px 8px;color:var(--muted-dark);font-size:11px;font-weight:700;list-style:none;text-align:center}
.row-actions-more summary::-webkit-details-marker{display:none}
.row-actions-more summary::before{content:"+";display:inline-block;margin-right:5px;color:var(--brand);font-size:14px;line-height:0;vertical-align:-1px}
.row-actions-more[open] summary::before{content:"−"}
.row-actions-menu{display:grid;gap:7px;padding:7px;border-top:1px solid var(--line-light);background:#f8fafc;box-sizing:border-box;width:100%;min-width:0;overflow:visible}
.row-actions-menu>.inline-action-form{grid-template-columns:minmax(0,1fr);min-width:0;width:100%}
.row-actions-menu>.inline-action-form>.small{width:100%;min-width:0}
.row-actions-menu>.danger-action{grid-template-columns:minmax(0,1fr)}
.row-actions-menu .execution-mode-inline{min-width:0;width:100%;box-sizing:border-box}
.runner-actions .execution-mode-inline{grid-column:1 / -1;min-width:0;width:100%;display:grid;grid-template-columns:auto minmax(0,1fr);padding:4px 6px;gap:4px;background:#f8fafc}
.runner-actions .execution-mode-inline legend{grid-column:1 / -1}
.runner-actions .execution-mode-inline label:not(.check){min-width:0}
.runner-actions .execution-mode-inline select{max-width:100%;min-width:0;width:100%}
.runner-actions .execution-mode-inline .check{min-width:0;overflow-wrap:anywhere;margin:0;font-size:10px}
.runner-actions .execution-mode-inline .privileged-host-warning{display:none!important}
.runner-actions .danger-action{grid-template-columns:minmax(0,1fr) auto}
.runner-actions .danger-action label{min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:3px}
.runner-actions .danger-action label input{max-width:none;width:100%}
.runner-actions .danger-action-buttons{display:flex;align-items:flex-end;gap:5px;flex-wrap:wrap}
.runner-actions .danger-action-buttons .small{flex:1 1 auto}
.client-table{min-width:0;table-layout:fixed}
.client-table th:nth-child(1){width:19%}.client-table th:nth-child(2){width:16%}.client-table th:nth-child(3){width:14%}.client-table th:nth-child(4){width:15%}.client-table th:nth-child(5){width:9%}.client-table th:nth-child(6){width:27%}
.client-table .actions{vertical-align:top;width:auto;min-width:0}
.client-table .action-btn-group{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%}
.client-table .inline-action-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;min-width:0}
.client-table .inline-action-form:first-of-type{grid-column:1 / -1}
.client-table .action-btn-group>a,.client-table .action-btn-group>form{min-width:0}
.client-table .action-btn-group>a{width:100%}
.client-table .inline-action-form input{max-width:none;width:100%}
.enrollment-body .shell{max-width:1120px}
.enrollment-dialog{width:min(960px,100%);margin:0 auto;padding:32px 34px}
.enrollment-dialog .page-heading{display:block;margin-bottom:22px}
.enrollment-dialog .page-heading .lede{max-width:72ch}
.enrollment-dialog .dialog-actions{align-items:center;flex-wrap:wrap}
.enrollment-dialog .dialog-actions form{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 520px}
.enrollment-dialog .dialog-actions .execution-mode-inline{flex:1 1 auto;min-width:0}
.enrollment-dialog .dialog-actions .execution-mode-inline .privileged-host-warning{max-width:100%;position:static;margin:8px 0 0;grid-column:1 / -1}
.secret-card{width:min(620px,100%);margin:0 auto;padding:36px}
html[lang="zh-CN"] legend,html[lang="zh-CN"] h3,html[lang="zh-CN"] .eyebrow,html[lang="zh-CN"] .metric-label,html[lang="zh-CN"] th,html[lang="zh-CN"] .form-stat-label,html[lang="zh-CN"] .details dt{text-transform:none}
.secret-card code{font-size:12px;line-height:1.55;overflow-wrap:anywhere;word-break:break-word}
.secret-actions{flex-wrap:wrap}
.secret-actions .button{flex:1 1 180px}
@media(max-width:1050px){
  .runner-table,.client-table{table-layout:auto;min-width:760px}
  .runner-table .actions,.client-table .actions{min-width:280px}
}
@media(max-width:800px){
  .runner-table,.client-table{display:block;min-width:0;border:0}
  .runner-table thead,.client-table thead{display:none}
  .runner-table tbody,.client-table tbody,.runner-table tr,.client-table tr,.runner-table td,.client-table td{display:block;width:100%}
  .runner-table tr,.client-table tr{padding:14px 0;border-bottom:1px solid var(--line)}
  .runner-table td,.client-table td{padding:5px 0;border:0}
  .runner-table td::before,.client-table td::before{display:block;margin-bottom:3px;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
  .runner-table td:nth-child(1)::before{content:"Runner"}.runner-table td:nth-child(2)::before{content:"Status"}.runner-table td:nth-child(3)::before{content:"Platform"}.runner-table td:nth-child(4)::before{content:"Execution mode"}.runner-table td:nth-child(5)::before{content:"Last seen"}.runner-table td:nth-child(6)::before{content:"Actions"}
  .client-table td:nth-child(1)::before{content:"Client"}.client-table td:nth-child(2)::before{content:"Scopes"}.client-table td:nth-child(3)::before{content:"Active runner"}.client-table td:nth-child(4)::before{content:"Last used"}.client-table td:nth-child(5)::before{content:"Status"}.client-table td:nth-child(6)::before{content:"Actions"}
  html[lang="zh-CN"] .runner-table td:nth-child(1)::before{content:"Runner"}html[lang="zh-CN"] .runner-table td:nth-child(2)::before{content:"状态"}html[lang="zh-CN"] .runner-table td:nth-child(3)::before{content:"平台"}html[lang="zh-CN"] .runner-table td:nth-child(4)::before{content:"执行模式"}html[lang="zh-CN"] .runner-table td:nth-child(5)::before{content:"最后在线"}html[lang="zh-CN"] .runner-table td:nth-child(6)::before{content:"操作"}
  html[lang="zh-CN"] .client-table td:nth-child(1)::before{content:"客户端"}html[lang="zh-CN"] .client-table td:nth-child(2)::before{content:"权限范围"}html[lang="zh-CN"] .client-table td:nth-child(3)::before{content:"活跃 Runner"}html[lang="zh-CN"] .client-table td:nth-child(4)::before{content:"最后使用"}html[lang="zh-CN"] .client-table td:nth-child(5)::before{content:"状态"}html[lang="zh-CN"] .client-table td:nth-child(6)::before{content:"操作"}
  .runner-actions,.client-table .action-btn-group{grid-template-columns:1fr}
  .runner-actions .inline-action-form:first-of-type,.client-table .inline-action-form:first-of-type{grid-column:auto}
  .enrollment-dialog{padding:22px 18px}
  .enrollment-dialog .dialog-actions{align-items:stretch;flex-direction:column}
  .enrollment-dialog .dialog-actions form{width:100%;flex-direction:column;align-items:stretch}
  .enrollment-dialog .dialog-actions form .button,.enrollment-dialog .dialog-actions>a{width:100%}
  .secret-card{padding:24px 20px}
}
</style>`; }
