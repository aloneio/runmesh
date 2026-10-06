// Static admin styles, composed by adminStyles().
export const tablesStyles = `/* Dense action cells need their own layout.  Without this, each form's
   intrinsic width expands the Runner table and makes the page unusable. */
.runner-table{min-width:0;table-layout:fixed}
.runner-table th[data-column=name]{width:19%}
.runner-table th[data-column=status]{width:12%}
.runner-table th[data-column=platform]{width:14%}
.runner-table th[data-column=executionMode]{width:18%}
.runner-table th[data-column=lastSeen]{width:15%}
.runner-table th[data-column=actions]{width:22%}
.table-mobile-label{display:none}
.runner-table td{overflow-wrap:anywhere}
.runner-table .actions{vertical-align:top;width:auto;min-width:0;overflow:visible}
.runner-actions{display:grid;width:100%;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-items:start}
.runner-actions>a,.runner-actions>form{min-width:0}
.runner-actions>a{width:100%}
.runner-actions>.row-actions-more[open]{grid-column:1 / -1}
.runner-actions .inline-action-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;width:100%;align-items:center}
.runner-actions .inline-action-form:first-of-type{grid-column:1 / -1}
.row-actions-more{border:1px solid var(--line);border-radius:var(--radius-sm);background:#fff;min-width:0;overflow:visible;position:relative;z-index:1}
.row-actions-more summary{cursor:pointer;min-height:34px;padding:7px 8px;color:var(--muted-dark);font-size:11px;font-weight:700;list-style:none;text-align:center}
.row-actions-more summary::-webkit-details-marker{display:none}
.row-actions-more summary::before{content:"+";display:inline-block;margin-right:5px;color:var(--brand);font-size:14px;line-height:0;vertical-align:-1px}
.row-actions-more[open] summary::before{content:"−"}
.row-actions-menu{display:grid;gap:7px;padding:7px;border-top:1px solid var(--line-light);background:#f8fafc;box-sizing:border-box;width:100%;min-width:0;overflow:visible}
.row-actions-menu>.inline-action-form{grid-template-columns:minmax(0,1fr);min-width:0;width:100%}
.row-actions-menu>.inline-action-form>.small{width:100%;min-width:0}
.row-actions-menu>.danger-action{grid-template-columns:minmax(0,1fr)}
.row-actions-menu .execution-mode-inline{min-width:0;width:100%;box-sizing:border-box}
.runner-actions .execution-mode-inline{grid-column:1 / -1;min-width:0;width:100%;display:grid;grid-template-columns:minmax(0,1fr);padding:8px;gap:8px;background:var(--panel-card)}
.runner-actions .execution-mode-inline legend{grid-column:1 / -1}
.runner-actions .execution-mode-inline label:not(.check){display:grid;min-width:0;white-space:normal}
.runner-actions .execution-mode-inline select{max-width:100%;min-width:0;width:100%}
.runner-actions .execution-mode-inline .check{min-width:0;overflow:visible;align-items:flex-start;white-space:normal;margin:0;font-size:12px}
.runner-actions .execution-mode-inline .check input{flex:none;width:auto;margin-top:3px}
.runner-actions .execution-mode-inline .check span{min-width:0;white-space:normal;overflow:visible;overflow-wrap:anywhere}
.runner-actions .execution-mode-inline .privileged-host-warning{display:none!important}
.runner-actions .danger-action{grid-template-columns:minmax(0,1fr) auto}
.runner-actions .danger-action label{min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:3px}
.runner-actions .danger-action label input{max-width:none;width:100%}
.runner-actions .danger-action-buttons{display:flex;align-items:flex-end;gap:5px;flex-wrap:wrap}
.runner-actions .danger-action-buttons .small{flex:1 1 auto}
.client-table{min-width:0;table-layout:fixed}
.client-table td{overflow-wrap:anywhere}
.client-table .credential-badge{white-space:nowrap;overflow-wrap:normal;word-break:normal}
.client-table th[data-column=name]{width:19%}.client-table th[data-column=scopes]{width:12%}.client-table th[data-column=activeRunner]{width:16%}.client-table th[data-column=lastUsed]{width:15%}.client-table th[data-column=status]{width:11%}.client-table th[data-column=actions]{width:27%}
.client-table .actions{vertical-align:top;width:auto;min-width:0}
.client-table .action-btn-group{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%}
.client-table .inline-action-form{display:grid;grid-template-columns:minmax(0,1fr);align-items:stretch;gap:5px;min-width:0}
.client-table .inline-action-form:first-of-type{grid-column:1 / -1}
.client-table .action-btn-group>a,.client-table .action-btn-group>form{min-width:0}
.client-table .action-btn-group>a{width:100%}
.client-table .action-btn-group button{max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:center}
.client-table .inline-action-form input{max-width:none;width:100%}
html[lang="zh-CN"] legend,html[lang="zh-CN"] h3,html[lang="zh-CN"] .eyebrow,html[lang="zh-CN"] .metric-label,html[lang="zh-CN"] th,html[lang="zh-CN"] .form-stat-label,html[lang="zh-CN"] .details dt{text-transform:none}
@media(min-width:801px) and (max-width:1280px){
  .runner-table,.client-table{table-layout:auto;min-width:760px}
  .runner-table .actions,.client-table .actions{min-width:280px}
}
@media(max-width:800px){
  .table-wrap:has(>.runner-table)::after,.table-wrap:has(>.client-table)::after{display:none}
  .runner-table,.client-table{display:block;min-width:0;border:0}
  .runner-table thead,.client-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
  .runner-table tbody,.client-table tbody,.runner-table tr,.client-table tr,.runner-table td,.client-table td{display:block;width:100%}
  .runner-table tr,.client-table tr{padding:14px 0;border-bottom:1px solid var(--line)}
  .runner-table td,.client-table td{padding:5px 0;border:0}
  .table-mobile-label{display:block;margin-bottom:3px;color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
  .runner-actions,.client-table .action-btn-group{grid-template-columns:1fr}
  .runner-actions .inline-action-form:first-of-type,.client-table .inline-action-form:first-of-type{grid-column:auto}
}
`;
