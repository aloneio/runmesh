// Static admin styles, composed by adminStyles().
export const surfacesStyles = `/* Secret & Enrollment Full-Page Dialogs */
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
.secret-card{width:min(620px,100%);margin:0 auto;padding:36px}
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
  flex-wrap:wrap;
  gap:10px;
}
.secret-actions .button{flex:1 1 180px}
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
.enrollment-shell{max-width:1120px;padding-top:24px;padding-bottom:50px}
.enrollment-dialog{
  display:block;
  position:static;
  inset:auto;
  height:auto;
  max-width:100%;
  width:min(960px,100%);
  margin:0 auto;
  padding:32px 34px;
  color:inherit;
  border:1px solid var(--line);
  box-shadow:var(--shadow-lg);
  background:var(--panel-elevated);
}
.enrollment-dialog .page-heading{display:block;margin-bottom:22px}
.enrollment-dialog .page-heading .lede{max-width:72ch}
.enrollment-dialog .dialog-actions{align-items:center;flex-wrap:wrap}
.enrollment-dialog .dialog-actions form{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 520px}
.enrollment-dialog .dialog-actions .execution-mode-inline{flex:1 1 auto;min-width:0}
.enrollment-dialog .dialog-actions .execution-mode-inline .privileged-host-warning{max-width:100%;position:static;margin:8px 0 0;grid-column:1 / -1}
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
.secret-card code{font-size:12px;line-height:1.55;overflow-wrap:anywhere;word-break:break-word}
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


/* Auth surface light layout */
.auth-body.login-entry-body{display:block}
.auth-body>.language-switch{box-shadow:0 8px 24px rgba(15,23,42,.06)}
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
.password-input-wrap input:focus{border-color:var(--brand);background:#fff;box-shadow:0 0 0 4px var(--focus-ring)}
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
  .login-brand-pane{display:none}
  .login-brand-logo{width:190px;height:58px}
  .login-brand-title-wrap{margin-bottom:20px}
  .login-form-pane{padding:32px 20px;width:100%;align-items:flex-start}
  .auth-header-mobile{display:block}
  .login-form-container{max-width:500px;margin:0 auto}
  .login-title-group h1{font-size:28px}
}
@media(max-width:480px){
  .auth-body>.language-switch{top:12px;right:12px}
  .login-title-group{margin-bottom:24px}
  .login-title-group h1{font-size:25px}
}
`;
