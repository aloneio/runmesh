// Static admin styles, composed by adminStyles().
export const responsiveStyles = `/* Responsive Breakpoints & Accessibility */
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
@media(max-width:1100px){
  .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .grid-two,.runner-primary-grid,.runner-access-grid,.runner-enrollment-grid,.runner-diagnostics-grid,.client-settings-grid{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:900px){
  .ops-body{padding-left:0}
  .app-header{margin-left:0}
  .header-inner{padding:0 18px}
  .nav-rail{position:static;width:auto;padding:0 12px 10px;border:0;overflow:visible}
  .control-nav{flex-direction:row;flex-wrap:wrap;gap:4px}
  .control-nav a{font-size:13px;min-height:38px;padding:8px 10px;gap:7px}
  .nav-icon{width:16px;height:16px}
}
@media(max-width:800px){
  .shell{padding:16px 14px 40px}
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
  .form-grid.add-form-grid{flex-direction:column;align-items:stretch}
  .form-grid.add-form-grid > label,.form-grid.add-form-grid .form-submit-wrap{width:100%;flex:1 1 auto}
  .form-grid.add-client-grid{grid-template-columns:minmax(0,1fr)}
  .add-client-grid fieldset .scope-selector-row{align-items:flex-start}
  .secret-mesh-mark,.error-mesh-mark{width:190px;height:56px}
  .enrollment-header{width:calc(100% - 28px);margin-top:12px;gap:10px;flex-wrap:wrap}
  .enrollment-brand-logo{width:148px;height:44px;padding:2px 5px}
  .enrollment-header-actions{gap:6px;margin-left:auto}
  .enrollment-shell{padding-top:16px}
  .enrollment-dialog{position:static;inset:auto;height:auto;max-width:100%;min-width:0;padding:22px 18px;overflow:hidden}
  .enrollment-dialog .dialog-actions{align-items:stretch;flex-direction:column}
  .enrollment-dialog .dialog-actions form{width:100%;flex:0 1 auto;flex-direction:column;align-items:stretch}
  .enrollment-dialog .dialog-actions form .button,.enrollment-dialog .dialog-actions>a{width:100%}
  .secret-card{padding:24px 20px}
  .enrollment-dialog .page-heading,.enrollment-dialog .enrollment-meta-box,.enrollment-dialog [role="tabpanel"]{min-width:0;max-width:100%}
  .enrollment-dialog .mono{overflow-wrap:anywhere;word-break:break-word}
  .enrollment-dialog pre{width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:hidden}
  .enrollment-dialog pre code{white-space:inherit;overflow-wrap:inherit;word-break:inherit}
}
@media(max-width:540px){
  .header-left{flex-direction:column;align-items:flex-start;gap:0;padding:4px 0}
  .card-row{align-items:flex-start;gap:8px;min-width:0}
  .card-row-main{min-width:0;max-width:100%}
  .card-row-sub{display:flex;flex-wrap:wrap;min-width:0;max-width:100%;row-gap:3px}
  .platform-meta,.client-runner-meta{min-width:0;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
  .action-btn-group{flex-wrap:nowrap}
  .action-btn-group > *{flex:0 0 auto}
  .action-btn-group .danger-action label{white-space:nowrap}
  .actions{width:300px;min-width:300px}
  .metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .metric{padding:14px;min-height:116px}
  .metric-value,.metric strong{font-size:24px}
  .page-heading{gap:14px}
  .page-heading>.button{width:100%}
  .card-row-aside{flex:none}
  .card-row{flex-wrap:wrap}
  .snapshot-loaded{flex-wrap:wrap}
  .runner-version-summary{grid-template-columns:minmax(0,1fr)}
  .form-grid{grid-template-columns:1fr}
  .perm-selects-row{grid-template-columns:1fr}
  h1{font-size:20px}
  .detail-title{font-size:17px}
  .scope-editor-form{grid-template-columns:1fr;align-items:stretch}
  .scope-editor-form .button{width:100%}
  .override-form-row{flex-direction:column;align-items:stretch}
  .table-wrap{max-width:100%}
}
`;
