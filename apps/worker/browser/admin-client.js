
  (function(){
function bindCentralProduct(root){
 var app=root.querySelector('[data-central-product]');if(!app||app.__productBound)return;app.__productBound=true;
 var zh=document.documentElement.lang==='zh-CN',t=function(en,cn){return zh?cn:en;};
 var status=app.querySelector('[data-product-status]'),profiles=[],skills=[],busy=false,mustRefresh=false;
 function el(tag,text,className){var n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
 function say(text,error){status.textContent=text;status.setAttribute('data-error',String(!!error));}
 function button(parent,label,action){var b=el('button',label,'button small secondary');b.type='button';b.addEventListener('click',function(){run(action);});parent.appendChild(b);return b;}
 function clear(node){node.replaceChildren();}
 function details(parent,title,text){var d=el('details'),s=el('summary',title),p=el('pre',text);d.append(s,p);parent.appendChild(d);}
 function choice(parent,title,description,checked){var label=el('label',undefined,'central-choice'),box=el('input'),span=el('span');box.type='checkbox';box.checked=checked;span.append(el('strong',title),el('p',description,'muted'));label.append(box,span);parent.appendChild(label);return box;}
 async function api(path,body,missing){
  if(body&&body.action!=='preview'&&mustRefresh)throw new Error(t('Refresh the library before making another change.','请刷新目录后再修改。'));
  var ctl=new AbortController(),timer=setTimeout(function(){ctl.abort();},25000);
  try{var response=await fetch('/admin/central/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:ctl.signal,headers:{'content-type':'application/json','x-csrf-token':app.getAttribute('data-csrf')},body:body===undefined?undefined:JSON.stringify(body)});
   var value=await response.json();
   if(missing&&response.status===404&&(value.state==='missing'||value.error&&value.error.code==='central_missing'))return null;
   if(!response.ok){if(body&&body.action!=='preview')mustRefresh=true;var code=value.error&&value.error.code;
    if(response.status===409&&path==='skill-installations'&&value.state==='conflict'){var conflict=new Error('skill_exists');conflict.skillId=value.skill_id;conflict.revision=value.current_revision;throw conflict;}
    if(response.status===409)throw new Error(t('This item changed. Refresh and review it again before saving.','内容已变化，请刷新并重新审阅后保存。'));
    if(response.status===403)throw new Error(t('Access was denied. Sign in again or check the upstream authorization.','访问被拒绝，请重新登录或检查上游授权。'));
    if(response.status===400)throw new Error(t('Check the fields and Skill file format. SKILL.md requires name and description frontmatter.','请检查填写内容及 Skill 文件格式。SKILL.md 需要 name 和 description 元数据。'));
    if(code==='oauth_provider_unsupported')throw new Error(t('This service does not support automatic OAuth connection. Check its MCP URL and OAuth client registration support.','此服务暂不支持自动 OAuth 连接，请确认 MCP 地址及自动客户端注册支持。'));
    if(code==='remote_authorization_required'||code==='oauth_reauthorization_required')throw new Error(t('Sign in to this service again using Reconnect.','请点击“重新授权”登录此服务。'));
    if(code==='oauth_unavailable')throw new Error(t('Authorization could not be completed. Refresh and reconnect; if it persists, contact the instance operator.','未能完成授权，请刷新后重新连接；若持续失败，请联系实例运营方。'));
    if(code==='remote_egress_denied'||code==='remote_endpoint_denied'||code==='central_disabled')throw new Error(t('Enter a public HTTPS MCP URL. Private addresses and redirecting endpoints are not supported.','请输入公网 HTTPS MCP 地址，不支持私有地址或重定向端点。'));
    throw new Error(t('Operation could not be confirmed. Refresh the current state before trying again.','操作结果未确认，请先刷新当前状态，再决定是否重试。'));
   }
   var expected=path==='skill-installations'?'installed':path==='connections/begin'?'started':path==='connections/revoke'?'revoked':body===undefined?'found':body.action==='preview'?'previewed':'written';
   if(value.state!=='listed'&&value.state!==expected)throw new Error(t('Unexpected response. Refresh before making another change.','返回结果异常，请刷新后再操作。'));
   return value;
  }catch(error){if(body&&body.action!=='preview')mustRefresh=true;throw error;}finally{clearTimeout(timer);}
 }
 async function run(action){if(busy)return;busy=true;var controls=Array.from(app.querySelectorAll('button,input,select'));var disabled=controls.map(function(c){return c.disabled;});controls.forEach(function(c){c.disabled=true;});say(t('Working…','正在处理…'));
  try{await action();}catch(error){say(error instanceof Error&&error.name!=='AbortError'?error.message:t('Connection interrupted. Refresh to check whether the operation completed.','连接中断，请刷新确认操作是否完成。'),true);}
  finally{busy=false;controls.forEach(function(c,i){if(c.isConnected)c.disabled=disabled[i];});}
 }
 async function pages(path,key){var all=[],after=null,seen=new Set();do{var value=await api(path+(after?'?after='+encodeURIComponent(after):''));all=all.concat(value[key]);after=value.next_after;if(after&&seen.has(after))throw new Error(t('Could not load the complete library. Refresh before changing the library.','无法加载完整目录，请刷新后再修改目录。'));seen.add(after);if(all.length>1000)throw new Error(t('Library is too large to display.','目录超过显示上限。'));}while(after);return all;}
 function invalidate(){app.querySelectorAll('[data-service-review],[data-skill-review]').forEach(function(n){clear(n);n.hidden=true;});}
 async function refresh(){mustRefresh=true;invalidate();profiles=await pages('profiles','profiles');skills=app.getAttribute('data-skills')==='true'?await pages('skills','skills'):[];renderProfiles();renderSkills();mustRefresh=false;say(t('Library is up to date.','目录已更新。'));}
 function renderProfiles(){var list=app.querySelector('[data-service-list]');clear(list);if(!profiles.length)list.append(el('p',t('No services yet. Connect your first service to get started.','还没有服务，添加第一个 MCP 服务即可开始。'),'muted'));
  profiles.forEach(function(profile){var card=el('article',undefined,'central-card');card.append(el('h3',profile.display_name||profile.connector_id),el('p',profile.endpoint,'muted'),el('p',profile.enabled?t('Enabled · tool review required before sharing','已启用 · 分享前仍需审核工具'):t('Paused','已暂停')));var actions=el('div',undefined,'actions');
   button(actions,t('Review tools','审阅工具'),function(){return reviewService(profile,false);});
   button(actions,t('Check connection & discover','检查连接并发现工具'),function(){return reviewService(profile,true);});
   button(actions,profile.enabled?t('Pause','暂停'):t('Enable','启用'),async function(){await api('profiles/'+encodeURIComponent(profile.profile_id),{action:profile.enabled?'disable':'enable',expected_revision:profile.revision});await refresh();});card.append(actions);
   if(profile.authentication==='oauth'){button(actions,t('Reconnect','重新授权'),function(){return connectOAuth(profile);});button(actions,t('Disconnect account','断开账号'),async function(){await api('connections/revoke',{profile_id:profile.profile_id,expected_revision:profile.revision});await refresh();say(t('Account disconnected. Reconnect to use this service.','账号已断开，重新授权后可使用此服务。'));});}
   if(profile.credential){var credentials=el('details'),form=el('form'),label=el('label',t('New service access token','新的服务访问令牌')),input=el('input'),submit=el('button',t('Update access token','更新访问令牌'),'button small secondary');input.type='password';input.required=true;input.autocomplete='new-password';submit.type='submit';label.append(input);form.append(label,submit);credentials.append(el('summary',t('Update service credentials','更新服务凭据')),form);card.append(credentials);form.addEventListener('submit',function(event){event.preventDefault();run(async function(){var token=input.value;input.value='';await api('profiles/'+encodeURIComponent(profile.profile_id),{action:'rotate',expected_revision:profile.revision,credential:{kind:'bearer',token:token}});token='';await refresh();say(t('Access token updated. Check the connection before sharing tools.','访问令牌已更新，请检查连接后再分享工具。'));});});}
   list.append(card);
  });
 }
 async function reviewService(profile,discover){var id=encodeURIComponent(profile.profile_id),catalog=await api('catalogs/'+id,undefined,true);
  if(discover){await api('discovery/'+id,{expected_revision:catalog?catalog.head.revision:0});catalog=await api('catalogs/'+id);}
  var panel=app.querySelector('[data-service-review]');clear(panel);panel.hidden=false;panel.append(el('h2',t('Review tools: ','审阅工具：')+(profile.display_name||profile.connector_id)));
  if(!catalog){panel.append(el('p',t('No tools discovered yet. Enable the service, then check its connection.','尚未发现工具，请启用服务后检查连接。')));say(t('No catalog yet.','尚无工具目录。'));return;}
  panel.append(el('p',t('Approved tools are available to all connected AI clients. Descriptions and schemas come from the upstream service.','勾选并批准的工具可供所有已连接的 AI 客户端使用。描述和参数来自上游服务。')));
  var selected=catalog.snapshot.tools.map(function(tool){var delta=catalog.changes.find(function(c){return c.name===tool.definition.name;});var changed=delta&&delta.state!=='unchanged';
   var box=choice(panel,tool.definition.title||tool.definition.name,(changed?t('New or changed · ','新增或变化 · '):'')+(tool.definition.description||''),catalog.head.approved_digest===catalog.snapshot.digest&&catalog.head.approved_names.includes(tool.definition.name));
   details(panel,t('Parameters & safety hints','参数与安全提示'),JSON.stringify({input:tool.definition.inputSchema,output:tool.definition.outputSchema,hints:tool.definition.annotations},null,2));return {box:box,name:tool.definition.name};});
  catalog.changes.filter(function(c){return c.state==='removed';}).forEach(function(c){panel.append(el('p',t('Removed: ','已移除：')+c.name));});
  button(panel,t('Approve selected tools','批准勾选的工具'),async function(){await api('catalogs/'+id,{action:'approve',expected_revision:catalog.head.revision,digest:catalog.snapshot.digest,tool_names:selected.filter(function(s){return s.box.checked;}).map(function(s){return s.name;}).sort()});await refresh();say(t('Tools approved. Refresh the tool list in your AI client to use them.','工具已批准，请在 AI 客户端刷新工具列表即可使用。'));});
  panel.scrollIntoView({block:'nearest'});say(t('Review the tools before approving.','请审阅工具后再批准。'));
 }
 async function connectOAuth(profile){var result=await api('connections/begin',{profile_id:profile.profile_id,expected_revision:profile.revision});say(t('Opening the service sign-in page…','正在打开服务授权页面…'));location.assign(result.authorization_url);}
 app.querySelector('[data-service-create]').addEventListener('submit',function(event){event.preventDefault();var form=event.currentTarget;run(async function(){var endpoint=form.elements.endpoint.value.trim(),authentication=form.elements.authentication.value,name=form.elements.name.value.trim()||new URL(endpoint).hostname;var id='service-'+crypto.randomUUID();
  var result=await api('profiles/'+id,{action:'connect',connector_id:id,display_name:name,endpoint:endpoint,authentication:authentication});
  var enabled=await api('profiles/'+id,{action:'enable',expected_revision:result.profile.revision});form.reset();
  if(authentication==='oauth'){await connectOAuth(enabled.profile);return;}await refresh();await reviewService(enabled.profile,true);
 });});
 function renderSkills(){var list=app.querySelector('[data-skill-list]');if(!list)return;clear(list);if(!skills.length)list.append(el('p',t('No Skills yet. Import a Skill to review and share it.','尚无 Skill，导入后即可审阅和分享。'),'muted'));
  skills.forEach(function(item){var card=el('article',undefined,'central-card'),head=item.head;card.append(el('h3',item.summary.name),el('p',item.summary.description),el('p',head.enabled?t('Installed','已安装'):t('Paused','已暂停')));if(head.enabled&&head.staged_digest!==head.active_digest)card.append(el('p',t('An update is awaiting review.','有新版本待审阅。')));var actions=el('div',undefined,'actions');button(actions,t('View files','查看文件'),async function(){var data=await api('skills/'+encodeURIComponent(head.skill_id));showSkill(data.bundle,data.head);});
   if(head.enabled)button(actions,t('Pause','暂停'),async function(){await api('skills/'+encodeURIComponent(head.skill_id),{action:'disable',expected_revision:head.revision});await refresh();});card.append(actions);list.append(card);
  });
 }
 function showSkill(bundle,head){var panel=app.querySelector('[data-skill-review]');clear(panel);panel.hidden=false;panel.append(el('h2',bundle.name),el('p',bundle.description));
  bundle.files.forEach(function(file){details(panel,file.path,file.text);});
  if(bundle.required_capabilities&&bundle.required_capabilities.length)details(panel,t('Required capabilities (must be published and enabled)','依赖能力（须已发布并启用）'),JSON.stringify(bundle.required_capabilities,null,2));
  if(!head.enabled)button(panel,t('Enable Skill','启用 Skill'),async function(){await api('skills/'+encodeURIComponent(head.skill_id),{action:'activate',expected_revision:head.revision,digest:bundle.digest});await refresh();});
  panel.scrollIntoView({block:'nearest'});say(t('Skill files are ready to review.','可查看 Skill 文件内容。'));
 }
 var importer=app.querySelector('[data-skill-import]');
 if(importer)['files','folder'].forEach(function(name){importer.elements[name].addEventListener('change',function(){
  if(this.files.length)importer.elements[name==='files'?'folder':'files'].value='';
  var panel=app.querySelector('[data-skill-review]');if(!panel.hidden){clear(panel);panel.hidden=true;say(t('Selection changed. Check the files and select Install Skill again.','所选内容已变化，请确认文件后重新点击“安装 Skill”。'));}
 });});
 if(importer)importer.addEventListener('submit',function(event){event.preventDefault();run(async function(){var picked=Array.from(importer.elements.folder.files.length?importer.elements.folder.files:importer.elements.files.files);if(!picked.length||picked.length>32||picked.some(function(f){return f.size>65536;})||picked.reduce(function(n,f){return n+f.size;},0)>262144)throw new Error(t('Select 1–32 text files, up to 64 KiB each and 256 KiB total.','请选择 1–32 个文本文件，单个不超过 64 KiB，总计不超过 256 KiB。'));
  var files=[];for(var f of picked){var path=f.webkitRelativePath?f.webkitRelativePath.split('/').slice(1).join('/'):f.name;var text=new TextDecoder('utf-8',{fatal:true}).decode(await f.arrayBuffer());files.push({path:path,text:text});}
  var main=files.find(function(f){return f.path==='SKILL.md';});if(!main)throw new Error(t('The selected folder must contain SKILL.md at its root.','所选文件夹根目录必须包含 SKILL.md。'));
  async function install(revision){var result=await api('skill-installations',{files:files,expected_revision:revision});importer.reset();await refresh();say(result.name+t(' installed. Ready to use in all connected AI clients.',' 已安装，所有已连接的 AI 客户端均可使用。'));}
  try{await install(0);}catch(error){if(!error.skillId)throw error;await refresh();var current=skills.find(function(item){return item.head.skill_id===error.skillId;});if(!current||current.head.revision!==error.revision)throw new Error(t('Skill changed. Select the files again to update it.','Skill 已变化，请重新选择文件进行更新。'));var panel=app.querySelector('[data-skill-review]');clear(panel);panel.hidden=false;panel.append(el('h2',t('Update installed Skill: ','更新已安装的 Skill：')+current.summary.name),el('p',t('This updates the Skill for all connected AI clients. Clients must refresh the Skill list before reading its new version.','将为所有已连接的 AI 客户端更新 Skill，客户端需要刷新 Skill 列表后读取新版本。')));files.forEach(function(file){details(panel,file.path,file.text);});button(panel,t('Update Skill','更新 Skill'),function(){return install(current.head.revision);});button(panel,t('Cancel','取消'),async function(){clear(panel);panel.hidden=true;say(t('Update cancelled.','已取消更新。'));});say(t('This Skill is already installed. Review the update and confirm.','此 Skill 已安装，请查看更新内容后确认。'));}
 });});
 app.querySelector('[data-product-refresh]').addEventListener('click',function(){run(refresh);});
 function showTab(name){app.querySelectorAll('[data-central-tab]').forEach(function(b){var active=b.getAttribute('data-central-tab')===name;b.setAttribute('aria-pressed',String(active));b.classList.toggle('secondary',!active);});app.querySelectorAll('[data-central-panel]').forEach(function(p){p.hidden=p.getAttribute('data-central-panel')!==name;});}
 app.querySelectorAll('[data-central-tab]').forEach(function(tab){tab.addEventListener('click',function(){showTab(tab.getAttribute('data-central-tab'));});});
 run(async function(){await refresh();var connected=new URL(location.href).searchParams.get('connected');if(connected){var connection=profiles.find(function(p){return p.profile_id===connected;});history.replaceState(null,'','/admin/central');if(connection){await reviewService(connection,true);return;}}});
}

function applyLocale(locale){document.documentElement.lang=locale;document.querySelectorAll('[data-lang-toggle]').forEach(function(link){link.setAttribute('aria-current',link.getAttribute('data-lang-toggle')===locale?'true':'false')})}
function requestedLocale(){return document.documentElement.lang==='zh-CN'?'zh-CN':'en'}
function rememberLocale(locale){document.cookie='runmesh_lang='+locale+'; Max-Age=31536000; Path=/; SameSite=Lax'}
 document.querySelectorAll('[data-lang-toggle]').forEach(function(link){link.addEventListener('click',function(event){var locale=link.getAttribute('data-lang-toggle')||'en';rememberLocale(locale);var url=new URL(location.href);url.searchParams.set('lang',locale);event.preventDefault();location.href=url.toString()})});
var locale=requestedLocale();if(new URLSearchParams(location.search).has('lang'))rememberLocale(locale);applyLocale(locale);bindCentralProduct(document);
function copyText(text){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text);var area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();try{document.execCommand('copy')}catch(_){}area.remove();return Promise.resolve()}
function copyValue(button){var panel=button.hasAttribute('data-copy-source')&&button.closest('[role=tabpanel]');if(panel){var code=panel.querySelector('pre code');return code?(code.textContent||''):''}var value=button.getAttribute('data-copy');return value===null?'':value}
document.querySelectorAll('[data-copy],[data-copy-source]').forEach(function(button){button.addEventListener('click',function(){var result=copyText(copyValue(button));var mark=function(){button.textContent=document.documentElement.lang==='zh-CN'?'已复制':'Copied';button.classList.add('copied')};if(result&&typeof result.then==='function')result.then(mark,function(){});else mark()})});
function stabilizeTabPanels(){document.querySelectorAll('.enrollment-command-panels').forEach(function(container){var panels=Array.prototype.slice.call(container.querySelectorAll('[data-panel]'));if(!panels.length)return;var max=0;panels.forEach(function(panel){var wasHidden=panel.hidden;panel.hidden=false;max=Math.max(max,panel.offsetHeight);panel.hidden=wasHidden});if(max>0)panels.forEach(function(panel){panel.style.minHeight=max+'px'})})}
document.querySelectorAll('[data-tab]').forEach(function(tab){tab.addEventListener('click',function(){var target=tab.getAttribute('data-tab');var top=tab.getBoundingClientRect().top;document.querySelectorAll('[data-tab]').forEach(function(item){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1});document.querySelectorAll('[data-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-panel')!==target});var delta=tab.getBoundingClientRect().top-top;if(delta)window.scrollBy(0,delta)});tab.addEventListener('keydown',function(event){if(event.key==='ArrowLeft'||event.key==='ArrowRight'){var tabs=Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));var next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click()}})});stabilizeTabPanels();window.addEventListener('resize',function(){stabilizeTabPanels()});
document.querySelectorAll('.pwd-toggle-btn').forEach(function(btn){btn.addEventListener('click',function(){var wrap=btn.closest('.password-input-wrap');if(!wrap)return;var input=wrap.querySelector('input');if(!input)return;var isPwd=input.type==='password';input.type=isPwd?'text':'password';var isZh=document.documentElement.lang==='zh-CN';var buttonLabel=isPwd?(isZh?'隐藏密码':'Hide password'):(isZh?'显示密码':'Show password');btn.setAttribute('aria-label',buttonLabel);btn.setAttribute('title',buttonLabel);btn.innerHTML=isPwd?'<svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>':'<svg class="eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'})});
 document.querySelectorAll('form.login-form').forEach(function(form){form.addEventListener('submit',function(){var btn=form.querySelector('.login-submit-btn');if(!btn||btn.disabled)return;var isZh=document.documentElement.lang==='zh-CN';var isSetup=form.getAttribute('action')==='/setup';var loadingText=isSetup?(isZh?'正在初始化...':'Initializing...'):(isZh?'正在登录...':'Signing in...');var origWidth=btn.offsetWidth;btn.style.width=origWidth>0?(origWidth+'px'):'100%';btn.disabled=true;btn.textContent=loadingText;try{form.submit()}catch(e){}})});
function syncExecutionMode(form){var selected=form.querySelector('input[name="execution_mode"]:checked');if(!selected)selected=form.querySelector('select[name="execution_mode"]');var privileged=!!selected&&selected.value==='privileged_host';var confirmation=form.querySelector('[data-privileged-confirmation]');var warning=form.querySelector('.privileged-host-warning');var modeFieldset=form.querySelector('[data-execution-mode-form]');var reuse=!!modeFieldset&&modeFieldset.getAttribute('data-reuse-privileged-confirmation')==='true';if(confirmation)confirmation.required=privileged&&!reuse;if(warning)warning.hidden=!privileged||reuse}
 document.querySelectorAll('form').forEach(function(form){var controls=form.querySelectorAll('input[name="execution_mode"],select[name="execution_mode"]');if(!controls.length)return;controls.forEach(function(input){input.addEventListener('change',function(){syncExecutionMode(form)})});syncExecutionMode(form)});
// Keep the application chrome mounted while admin pages stream into cached workspace containers.
function updateActiveNavigation(path){var normalized=path.replace(/\/$/,'')||'/admin';document.querySelectorAll('.control-nav a').forEach(function(link){var href=link.getAttribute('href')||'';var active=href==='/admin'?normalized==='/admin':normalized===href||normalized.indexOf(href+'/')===0;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current')})}
function pageKey(url){return url.pathname+(url.search||'')}
function pageRoot(node){return node&&node.classList&&node.classList.contains('shell')?node:(node&&node.closest&&node.closest('.shell'))||node}
function pageContainer(root,key){var container=document.createElement('div');container.className='admin-page-container';container.setAttribute('data-page-container','');container.setAttribute('data-page-key',key);container.setAttribute('aria-hidden','true');container.appendChild(root);return container}
function ensurePageViewport(){var viewport=document.querySelector('[data-admin-viewport]');var active=document.querySelector('#main-content');if(!active)return viewport;var root=pageRoot(active);if(!root)return viewport;if(!viewport){viewport=document.createElement('div');viewport.className='admin-viewport';viewport.setAttribute('data-admin-viewport','');root.parentNode.insertBefore(viewport,root);var initial=pageContainer(root,pageKey(new URL(location.href)));initial.setAttribute('data-page-title',document.title||'');initial.classList.add('is-active');initial.setAttribute('aria-hidden','false');viewport.appendChild(initial)}else if(!root.closest('[data-page-container]')){var initial=pageContainer(root,pageKey(new URL(location.href)));initial.setAttribute('data-page-title',document.title||'');initial.classList.add('is-active');initial.setAttribute('aria-hidden','false');viewport.appendChild(initial)}return viewport}
function setActivePage(container,focus){var viewport=ensurePageViewport();if(!viewport||!container)return;var containers=Array.prototype.slice.call(viewport.querySelectorAll('[data-page-container]'));var previous=viewport.querySelector('[data-page-container].is-active');containers.forEach(function(item){var active=item===container;var wasPrevious=item===previous&&item!==container;item.classList.toggle('is-active',active);if(wasPrevious){item.classList.remove('is-leaving')}else if(active)item.classList.remove('is-leaving');else item.classList.remove('is-leaving');item.setAttribute('aria-hidden',active?'false':'true');item.inert=!active;var main=item.id==='main-content'?item:item.querySelector('#main-content');if(active){if(!main)main=item.tagName==='MAIN'?item:item.querySelector('main');if(main)main.id='main-content'}else if(main)main.removeAttribute('id')});viewport.style.minHeight=Math.max.apply(Math,[0].concat(containers.map(function(item){return item.offsetHeight||0})))+'px';if(focus){var main=container.id==='main-content'?container:container.querySelector('#main-content')||container.querySelector('main');if(main&&typeof main.focus==='function')main.focus({preventScroll:true})}}
function bindDynamicContent(root){
  if(!root)return;
  bindCentralProduct(root);
  root.querySelectorAll('[data-copy],[data-copy-source]').forEach(function(button){if(button.__runmeshBound)return;button.__runmeshBound=true;button.addEventListener('click',function(){var result=copyText(copyValue(button));var mark=function(){button.textContent=document.documentElement.lang==='zh-CN'?'已复制':'Copied';button.classList.add('copied')};if(result&&typeof result.then==='function')result.then(mark,function(){});else mark()})});
  root.querySelectorAll('[data-tab]').forEach(function(tab){if(tab.__runmeshBound)return;tab.__runmeshBound=true;tab.addEventListener('click',function(){var target=tab.getAttribute('data-tab');var top=tab.getBoundingClientRect().top;root.querySelectorAll('[data-tab]').forEach(function(item){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1});root.querySelectorAll('[data-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-panel')!==target});var delta=tab.getBoundingClientRect().top-top;if(delta)window.scrollBy(0,delta)});tab.addEventListener('keydown',function(event){if(event.key==='ArrowLeft'||event.key==='ArrowRight'){var tabs=Array.prototype.slice.call(root.querySelectorAll('[data-tab]'));var next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click()}})});
  root.querySelectorAll('.pwd-toggle-btn').forEach(function(btn){if(btn.__runmeshBound)return;btn.__runmeshBound=true;btn.addEventListener('click',function(){var wrap=btn.closest('.password-input-wrap');if(!wrap)return;var input=wrap.querySelector('input');if(!input)return;var isPwd=input.type==='password';input.type=isPwd?'text':'password';var label=isPwd?(document.documentElement.lang==='zh-CN'?'隐藏密码':'Hide password'):(document.documentElement.lang==='zh-CN'?'显示密码':'Show password');btn.setAttribute('aria-label',label);btn.setAttribute('title',label)})});
  root.querySelectorAll('form').forEach(function(form){var controls=form.querySelectorAll('input[name="execution_mode"],select[name="execution_mode"]');if(!controls.length)return;controls.forEach(function(input){if(input.__runmeshBound)return;input.__runmeshBound=true;input.addEventListener('change',function(){syncExecutionMode(form)})});syncExecutionMode(form)});
  bindFeatureAlert(root);
  stabilizeTabPanels();
}
function setupDynamicNavigation(){document.querySelectorAll('a[href^="/admin"]').forEach(function(link){if(link.__runmeshNavBound)return;link.__runmeshNavBound=true;link.addEventListener('click',function(event){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.hasAttribute('download')||link.target==='_blank')return;var target=new URL(link.href,location.href);if(target.origin!==location.origin)return;if(target.pathname===location.pathname&&target.search===location.search&&target.hash)return;event.preventDefault();loadAdminPage(target,pageKey(target)!==pageKey(new URL(location.href)))})})}
function mountAdminPage(nextRoot,title,key,viewport,shouldPush,url){
  nextRoot.removeAttribute('id');var container=pageContainer(nextRoot,key);container.setAttribute('data-page-title',title||'');
  viewport=ensurePageViewport();viewport.appendChild(container);document.title=title||document.title;
  bindDynamicContent(container);bindFeatureAlert(container);setupDynamicNavigation();
  if(shouldPush)history.pushState({runmeshAdmin:true},'',url.pathname+url.search+url.hash);
  setActivePage(container,true);updateActiveNavigation(url.pathname);applyLocale(requestedLocale());
  // Retain only the newly rendered page, not stale forms or sensitive job logs.
  Array.prototype.slice.call(viewport.querySelectorAll('[data-page-container]')).forEach(function(item){if(item!==container)item.remove()});
  viewport.style.minHeight=(container.offsetHeight||0)+'px';
}
function loadAdminPage(url,shouldPush){
  if(window.__runmeshLoading){window.__runmeshQueuedUrl=url;window.__runmeshQueuedPush=shouldPush;return}
  window.__runmeshLoading=true;var key=pageKey(url),viewport=ensurePageViewport(),current=document.querySelector('#main-content');
  if(current)current.setAttribute('aria-busy','true');
  return fetch(url.href,{credentials:'same-origin',cache:'no-store'}).then(function(response){
    if(!response.ok)throw new Error('HTTP '+response.status);return response.text();
  }).then(function(markup){
    var parsed=new DOMParser().parseFromString(markup,'text/html'),next=parsed.querySelector('#main-content');
    if(parsed.documentElement&&parsed.documentElement.lang&&parsed.documentElement.lang!==document.documentElement.lang){location.href=url.href;return;}
    if(!next)throw new Error('main content missing');var nextRoot=pageRoot(next);if(!nextRoot)throw new Error('page root missing');
    mountAdminPage(nextRoot,parsed.title||'',key,viewport,shouldPush,url);
  }).catch(function(error){
    console.error('Runmesh navigation failed',error);location.href=url.href;
  }).finally(function(){
    window.__runmeshLoading=false;var active=document.querySelector('#main-content');if(active)active.removeAttribute('aria-busy');
    if(window.__runmeshQueuedUrl){var queued=window.__runmeshQueuedUrl,queuedPush=window.__runmeshQueuedPush;window.__runmeshQueuedUrl=null;loadAdminPage(queued,queuedPush)}
  });
}
function bindFeatureAlert(root){var dialog=root.querySelector('.feature-alert-dialog');if(!dialog||dialog.__runmeshBound)return;dialog.__runmeshBound=true;dialog.addEventListener('click',function(event){if(event.target===dialog)dialog.close()})}
 ensurePageViewport();var initialContainer=document.querySelector('[data-page-container].is-active');if(initialContainer){stabilizeTabPanels();setActivePage(initialContainer,false)}
 window.addEventListener('popstate',function(){loadAdminPage(new URL(location.href),false)});setupDynamicNavigation();window.__runmeshDynamicNavigation=true;bindFeatureAlert(document);
  })();
