// Static admin styles, composed by adminStyles().
export const componentsStyles = `/* Typography & Headings */
h1,h2,h3{
  line-height:1.25;
  margin:0 0 8px;
  color:var(--ink-heading);
  letter-spacing:-0.02em;
}
h1{font-size:28px;font-weight:700;letter-spacing:-.035em}
h2{font-size:17px;font-weight:650;letter-spacing:-0.01em}
h3{font-size:12px;color:var(--muted-dark);text-transform:uppercase;letter-spacing:0.06em;font-weight:650}
.page-heading{
  display:flex;
  justify-content:space-between;
  align-items:flex-start;
  gap:24px;
  margin-bottom:28px;
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
.lede,.subtitle{margin:0 0 10px;max-width:64ch;font-size:14px;line-height:1.55}
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
  grid-template-columns:repeat(4,minmax(0,1fr));
  gap:16px;
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
  padding:20px;
  min-height:130px;
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
.metric-label{
  display:block;
  color:var(--muted);
  font-size:11px;
  font-weight:650;
  letter-spacing:0.04em;
  text-transform:uppercase;
  margin-bottom:6px;
}
.metric-value,.metric strong{
  font-size:30px;
  font-weight:650;
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
.grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:24px}
.panel{
  padding:24px;
  margin-bottom:24px;
  min-width:0;
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
  margin-bottom:18px;
  padding-bottom:14px;
  border-bottom:1px solid var(--line-light);
}
.section-title h2{margin:0}
.section-title > div{display:flex;align-items:center;gap:10px;min-width:0}
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
  background:var(--panel);
  border:1px solid var(--line);
}
.form-grid.add-form-grid{
  display:flex;
  align-items:flex-end;
  gap:12px;
  flex-wrap:wrap;
}
.form-grid.add-form-grid > label{flex:1 1 200px}
.form-grid.add-client-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.add-client-grid > label{min-width:0}
.add-client-grid > label > input,.add-client-grid > label > select{width:100%;min-height:38px}
.add-client-grid > details,.add-client-grid > .muted,.add-client-grid > .form-submit-wrap{grid-column:1 / -1;min-width:0}
.add-client-grid > .muted{margin:0}
.add-client-grid summary{cursor:pointer}
.add-client-grid fieldset{min-width:0;margin-top:12px}
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
th,td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line-light);vertical-align:middle}
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
.timestamp{display:inline-flex;flex-direction:column;line-height:1.5}
.timestamp>span{white-space:nowrap;overflow-wrap:normal;word-break:normal}
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
.runner-selection-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;max-width:100%}
.runner-selection-form{
  display:flex;
  align-items:center;
  gap:6px;
  flex-wrap:wrap;
  margin:0;
  min-width:0;
  max-width:100%;
  flex:1 1 180px;
}
.runner-selection-form select{min-width:0;width:100%;max-width:100%;flex:1 1 150px;height:30px;padding:3px 8px;font-size:12px}
.runner-selection-form .check{font-size:11px;white-space:normal;min-width:0;max-width:100%;margin-right:0}
.runner-selection-form .check span{min-width:0;overflow-wrap:anywhere}
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
.scope-selector-row .check{align-items:flex-start;min-width:0}
.scope-selector-row .check input{flex:none;margin:3px 0 0}
.scope-selector-row .check span{min-width:0;overflow-wrap:anywhere}
.scope-editor-form{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:end;
  gap:12px;
}
.client-recording-form{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
.client-recording-form>label,.client-recording-form>p{margin:0}
.client-recording-form>select{width:100%;max-width:360px;min-width:0}
.client-recording-form>button{justify-self:start;max-width:100%}
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
  padding:14px 10px;
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
  border:1px solid var(--brand-dim);
  background:var(--brand-dim);
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
  min-height:40px;
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
  min-height:34px;
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
  white-space:nowrap;
  overflow-wrap:normal;
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
  color:var(--danger-ink);
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
.status-pill.invalid{border-color:var(--danger-line);background:var(--danger-bg);color:var(--danger-ink)}
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
input:hover,select:hover,textarea:hover{border-color:var(--muted-dark)}
input:focus,select:focus,textarea:focus{
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
input:disabled,select:disabled,textarea:disabled,button:disabled{opacity:.55;cursor:not-allowed}
input[type=file]{width:100%;max-width:100%;padding:8px;font-size:12px}
input[type=file]::file-selector-button{border:0;background:var(--panel-subtle);color:var(--ink);padding:8px 10px;margin-right:10px;border-radius:6px;font:inherit;cursor:pointer}
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
.details dd{margin:0;min-width:0;font-weight:600;color:var(--ink-heading);overflow-wrap:anywhere}

`;
