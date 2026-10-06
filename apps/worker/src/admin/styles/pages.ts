// Page composition uses the shared panels, controls and navigation tokens.
export const pagesStyles = `
.metric-link{color:inherit;text-decoration:none}
.metric-link:hover{border-color:var(--brand-dim);box-shadow:var(--shadow-sm)}
.metric-time strong{font-size:14px;font-weight:600}
.metric-time .timestamp{margin-top:8px;font-family:var(--font-mono)}
.grid-two>.panel{margin-bottom:0}
.card-row-aside{gap:8px;margin-left:auto}
.card-row-main .strong{overflow-wrap:anywhere}
.card-row-sub{flex-wrap:wrap;overflow-wrap:anywhere}
.snapshot-note{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:start;gap:8px 20px;margin:16px 0;font-size:12px;color:var(--muted)}
.snapshot-note p{margin:0}
.snapshot-loaded{display:flex;align-items:baseline;gap:8px}
.activity-reference{display:block;margin-top:4px;font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.resource-empty{display:grid;justify-items:start;gap:14px;padding:20px 0;color:var(--muted)}
.resource-empty p{margin:0}
.count-badge{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;padding:2px 7px;border-radius:7px;background:var(--panel-subtle);color:var(--muted-dark);font-size:12px;font-variant-numeric:tabular-nums}
.runner-primary-grid,.runner-access-grid,.runner-enrollment-grid,.runner-diagnostics-grid,.client-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:24px;align-items:start}
.runner-primary-grid>.panel,.runner-access-grid>.panel,.runner-enrollment-grid>.panel,.runner-diagnostics-grid>.panel,.client-settings-grid>.panel{margin-bottom:0}
.runner-version-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:18px}
.version-stat{min-width:0;padding:12px;overflow-wrap:anywhere}
.detail-title-group{min-width:0}.detail-id{overflow-wrap:anywhere}.detail-header-actions{flex-wrap:wrap}
.central-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding-bottom:16px;border-bottom:1px solid var(--line);margin-bottom:24px}
.central-tabs{margin:0;gap:4px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.central-tabs .button{border-color:transparent;min-width:76px;background:transparent;color:var(--muted-dark)}
.central-tabs .button[aria-pressed=true]{background:#fff0e8;color:var(--brand-dim)}
.central-tabs .button:hover{background:var(--panel-subtle)}
.central-grid{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:24px;margin:0 0 24px}
.central-grid>.panel{margin:0}
[data-central-product] .connection-form label{margin:0;min-width:0}
[data-central-product] .connection-form{gap:18px}
.central-card:last-child{border-bottom:0;padding-bottom:0}
.central-card h3{font-size:15px;color:var(--ink-heading)}
.central-card>.muted{font-size:12px}
.central-file-preview{font-size:12px}
.skill-file-choice{padding:14px;background:var(--panel-card);border:1px dashed var(--line-subtle);border-radius:10px}
.client-row-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start;min-width:0}
.client-row-actions>.button{width:100%;min-width:0}
.row-actions-disclosure{min-width:0;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--panel)}
.row-actions-disclosure>summary{cursor:pointer;min-height:34px;padding:7px 9px;font-size:12px;font-weight:600;text-align:center}
.row-actions-disclosure[open]{grid-column:1 / -1}
.client-management-actions{display:grid;gap:8px;padding:10px;border-top:1px solid var(--line);background:var(--panel-card)}
.client-management-actions .inline-action-form{width:100%}
.client-management-actions button{width:100%}
.runner-create-panel,.client-create-panel{scroll-margin-top:90px}
.central-next-step{margin-top:24px;padding-top:24px;border-top:1px solid var(--line)}
.central-card details form{display:grid;gap:12px;margin-top:12px}
@media(max-width:1100px){.central-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:800px){.client-row-actions{grid-template-columns:minmax(0,1fr)}}
@media(max-width:540px){.central-toolbar{gap:8px}.central-tabs .button{min-width:58px;padding:6px 10px}.section-title{flex-wrap:wrap}}
`;
