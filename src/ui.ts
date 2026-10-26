const STYLE = `
:root{
  color-scheme:light;
  --bg:#f6f7f9;
  --surface:#ffffff;
  --surface-muted:#f9fafb;
  --text:#1f2933;
  --muted:#5f6b7a;
  --border:#e4e7ec;
  --border-strong:#d0d5dd;
  --accent:#2563eb;
  --accent-hover:#1d4ed8;
  --accent-soft:#eff4ff;
  --success:#067647;
  --success-soft:#ecfdf3;
  --warning:#b54708;
  --warning-soft:#fffaeb;
  --danger:#b42318;
  --danger-soft:#fef3f2;
  --radius:8px;
  --shadow:0 1px 2px rgba(16,24,40,.05);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
h1{font-size:22px;line-height:1.25;margin:0 0 4px;font-weight:650}
h2{font-size:16px;margin:0 0 2px;font-weight:600}
p{margin:0 0 10px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.muted{color:var(--muted)}
.lede{color:var(--muted);font-size:14px;margin:0}
.hint{font-size:12.5px;color:var(--muted);margin:6px 0 0}

.app-header{background:var(--surface);border-bottom:1px solid var(--border)}
.app-header-inner{max-width:1040px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font-weight:700;font-size:16px;color:var(--text)}
.brand:hover{text-decoration:none}
.nav{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.nav a{color:var(--muted);font-size:14px}
.nav a:hover{color:var(--text);text-decoration:none}
.nav .btn{margin:0}

.container{max-width:1040px;margin:0 auto;padding:28px 20px 56px}
.page-head{margin-bottom:20px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;margin-bottom:20px}
.panel-head{margin-bottom:16px}
.panel-head p{margin:0;color:var(--muted);font-size:13px}

.field{margin-bottom:14px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text)}
input[type=email],input[type=password],input[type=text],select{width:100%;padding:9px 11px;font:inherit;font-size:14px;color:var(--text);background:var(--surface);border:1px solid var(--border-strong);border-radius:6px}
input:focus,select:focus{border-color:var(--accent);outline:2px solid var(--accent-soft);outline-offset:0}
input:disabled,select:disabled{background:var(--surface-muted);color:var(--muted);cursor:not-allowed}
.checkbox{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;margin:0}
.checkbox input{width:auto;margin:0}
.inline-form{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.inline-form .field{margin-bottom:0}
.inline-form .grow{flex:1;min-width:240px}
.inline-form .checkbox-field{padding-bottom:10px}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;font:inherit;font-size:13.5px;font-weight:600;line-height:1.2;border-radius:6px;border:1px solid transparent;cursor:pointer;background:var(--surface);color:var(--text);white-space:nowrap}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--accent-hover);border-color:var(--accent-hover)}
.btn-secondary{background:var(--surface);border-color:var(--border-strong);color:var(--text)}
.btn-secondary:hover:not(:disabled){background:var(--surface-muted)}
.btn-danger{background:var(--surface);border-color:#f04438;color:var(--danger)}
.btn-danger:hover:not(:disabled){background:var(--danger-soft)}
.btn-small{padding:6px 10px;font-size:12.5px}
.btn-block{width:100%}
.btn-row{display:flex;flex-wrap:wrap;gap:8px}

.msg{font-size:13.5px;margin-top:12px}
.msg:empty{display:none}
.msg-error{color:var(--danger);background:var(--danger-soft);border:1px solid #fecdca;padding:8px 10px;border-radius:6px}
.msg-success{color:var(--success);background:var(--success-soft);border:1px solid #abefc6;padding:8px 10px;border-radius:6px}
.msg-info{color:var(--muted)}

.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;line-height:1.6;border:1px solid var(--border);background:var(--surface-muted);color:var(--muted);white-space:nowrap}
.badge-admin{background:var(--accent-soft);border-color:#c7d7fe;color:var(--accent-hover)}
.badge-active{background:var(--success-soft);border-color:#abefc6;color:var(--success)}
.badge-inactive{background:var(--warning-soft);border-color:#fedf89;color:var(--warning)}
.badge-read{background:var(--surface-muted);border-color:var(--border);color:var(--muted)}
.badge-write{background:var(--accent-soft);border-color:#c7d7fe;color:var(--accent-hover)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:var(--surface-muted);border-radius:999px;padding:2px 4px 2px 10px;font-size:12.5px;color:var(--text);max-width:100%}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--muted);font-size:14px;line-height:1;cursor:pointer}
.icon-btn:hover{background:#fee4e2;color:var(--danger)}
.assign{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px}
.assign select{width:auto;min-width:130px;max-width:100%}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.meta-label{font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;margin-bottom:4px}
.meta-value{font-size:14px;word-break:break-word}
.user-email{font-weight:600;word-break:break-word}

.table-wrap{overflow-x:auto}
.table{width:100%;min-width:720px;border-collapse:collapse;font-size:14px}
.table th:first-child,.table td:first-child{width:28%}
.table th:nth-child(2),.table td:nth-child(2){width:44%}
.table th:last-child,.table td:last-child{width:28%}
.table th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border)}
.table td{padding:12px 10px;border-bottom:1px solid var(--border);vertical-align:top}
.table tbody tr:last-child td{border-bottom:none}
.table .chips{margin-top:6px}

.auth-page{min-height:100vh;display:flex;flex-direction:column}
.auth-wrap{flex:1;display:flex;align-items:flex-start;justify-content:center;padding:56px 16px}
.auth-card{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);padding:28px}
.brand-block{margin-bottom:22px}
.brand-mark{display:block;font-size:18px;font-weight:700}
.brand-sub{display:block;font-size:12.5px;color:var(--muted)}
.auth-card h1{font-size:19px;margin-bottom:16px}
.auth-footer{margin:18px 0 0;font-size:13.5px}

@media (max-width:900px){
  .table-wrap{overflow:visible}
  .table{min-width:0}
  .table thead{display:none}
  .table,.table tbody,.table tr,.table td{display:block;width:100%}
  .table tr{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:12px;margin-bottom:12px}
  .table td{border:none;padding:4px 0}
  .table td::before{content:attr(data-label);display:block;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;margin-bottom:4px}
  .table tbody tr:last-child td{border-bottom:none}
}
@media (max-width:520px){
  .app-header-inner{flex-wrap:wrap}
  .nav{width:100%;justify-content:space-between}
}
@media (max-width:640px){
  .container{padding:20px 14px 44px}
  .app-header-inner{padding:10px 14px}
  .inline-form{display:block}
  .inline-form .field{margin-bottom:14px}
  .inline-form .grow{min-width:0}
  .inline-form .checkbox-field{padding-bottom:0}
  .inline-form .btn{width:100%}
  .auth-wrap{padding:28px 12px}
  .auth-card{padding:22px}
}
`;

// CFLab brand mark: a bold laboratory-flask silhouette in Cloudflare orange with
// a small white circuit trace inside. Inlined as a data URI so no page, Worker or
// browser makes a favicon request; the geometry reads at 16x16 and 32x32.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#F38020" d="M12.5 5v7.5L6.6 24.2A2.6 2.6 0 0 0 9 28h14a2.6 2.6 0 0 0 2.4-3.8L19.5 12.5V5z"/><path fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M11.4 23.4h2.3m7.9-.9 2.2-2.2"/><circle cx="16" cy="23.4" r="3" fill="#FFFFFF"/><circle cx="21.4" cy="20.3" r="1.5" fill="#FFFFFF"/></svg>';
import { CLIENT_NAVIGATION_JS } from './navigation';

const FAVICON = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' + encodeURIComponent(FAVICON_SVG).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27') + '">';

const API_JS = `var SESSION_KEY='cflab_session';function sessionToken(){return sessionStorage.getItem(SESSION_KEY)}function setSession(t){if(t)sessionStorage.setItem(SESSION_KEY,t);else sessionStorage.removeItem(SESSION_KEY)}function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}function formatId(id){return String(id||'').split(/[-_]/).filter(Boolean).map(function(p){return p.charAt(0).toUpperCase()+p.slice(1)}).join(' ')}function show(id,text,kind){var el=document.getElementById(id);if(!el)return;el.textContent=text||'';el.className='msg'+(kind==='err'?' msg-error':kind==='ok'?' msg-success':kind?' msg-info':'')}function api(path,method,body){var headers={};if(body!==undefined)headers['Content-Type']='application/json';var t=sessionToken();if(t)headers['Authorization']='Bearer '+t;return fetch(path,{method:method||'GET',headers:headers,body:body===undefined?undefined:JSON.stringify(body)}).then(function(res){return res.json().catch(function(){return null}).then(function(data){if(!res.ok){var e=new Error((data&&data.error&&data.error.message)||('HTTP '+res.status));e.status=res.status;e.code=data&&data.error&&data.error.code;throw e}return data})})}function initNav(user){var a=document.getElementById('nav-admin');if(a&&user&&user.is_admin)a.hidden=false}function wireLogout(){var b=document.getElementById('logout');if(!b)return;b.addEventListener('click',function(){api('/api/auth/logout','POST',{}).then(function(){setSession(null);location.href='/admin/login'},function(){setSession(null);location.href='/admin/login'})})}`;

function plainShell(title: string, content: string, script: string): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + FAVICON + '<title>' + title + ' - CFLab</title><style>' + STYLE + '</style></head><body class="auth-page"><div class="auth-wrap"><main class="auth-card"><div class="brand-block"><span class="brand-mark">CFLab</span><span class="brand-sub">AI Small Biz Guru</span></div><h1>' + title + '</h1>' + content + '</main></div><script>' + API_JS + script + '</script></body></html>';
}
function appShell(title: string, lede: string, content: string, script: string): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + FAVICON + '<title>' + title + ' - CFLab</title><style>' + STYLE + '</style></head><body><header class="app-header"><div class="app-header-inner"><a class="brand" href="/">CFLab</a><nav class="nav" aria-label="Account"><a id="nav-admin" href="/admin/users" hidden>Admin users</a><a href="/bitcoin-signals">Bitcoin Signals</a><a href="/account">Account</a><button id="logout" class="btn btn-secondary btn-small" type="button">Log out</button></nav></div></header><main class="container"><div class="page-head"><h1>' + title + '</h1><p class="lede">' + lede + '</p></div>' + content + '</main><script>' + API_JS + script + '</script></body></html>';
}

export function loginPage(): string {
  return plainShell('Sign in', `
<form id="login-form">
  <div class="field">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required>
  </div>
  <button type="submit" class="btn btn-primary btn-block">Log in</button>
</form>
<div id="msg" class="msg" role="status" aria-live="polite"></div>
<p class="auth-footer"><a href="/forgot-password">Forgot password?</a></p>`, CLIENT_NAVIGATION_JS + `
document.getElementById('login-form').addEventListener('submit',function(e){
  e.preventDefault();
  show('msg','Signing in...','');
  api('/api/auth/login','POST',{email:document.getElementById('email').value,password:document.getElementById('password').value})
    .then(function(data){setSession(data.token);location.href=loginDestination(data.user,location.search)})
    .catch(function(err){show('msg',err.message,'err')});
});`);
}

export function forgotPage(): string {
  return plainShell('Forgot password', `
<p class="lede">Enter your email and we will send reset instructions if the account exists.</p>
<form id="forgot-form">
  <div class="field">
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
  </div>
  <button type="submit" class="btn btn-primary btn-block">Send reset instructions</button>
</form>
<div id="msg" class="msg" role="status" aria-live="polite"></div>
<p class="auth-footer"><a href="/admin/login">Back to sign in</a></p>`, `
document.getElementById('forgot-form').addEventListener('submit',function(e){
  e.preventDefault();
  show('msg','Submitting...','');
  api('/api/auth/forgot-password','POST',{email:document.getElementById('email').value})
    .then(function(data){show('msg',data.message||'If that account exists, password reset instructions have been sent.','ok')})
    .catch(function(err){show('msg',err.message,'err')});
});`);
}

export function resetPage(): string {
  return plainShell('Choose a password', `
<p class="lede">Set a new password for your CFLab account, then sign in.</p>
<form id="reset-form">
  <div class="field">
    <label for="new-password">New password</label>
    <input id="new-password" type="password" autocomplete="new-password" required>
    <p class="hint">At least 15 characters. Spaces and Unicode are allowed.</p>
  </div>
  <div class="field">
    <label for="confirm-password">Confirm new password</label>
    <input id="confirm-password" type="password" autocomplete="new-password" required>
  </div>
  <button type="submit" class="btn btn-primary btn-block">Set password</button>
</form>
<div id="msg" class="msg" role="status" aria-live="polite"></div>
<p class="auth-footer"><a href="/admin/login">Back to sign in</a> &middot; <a href="/forgot-password">Request a new link</a></p>`, `
var token=new URLSearchParams(location.search).get('token')||'';
history.replaceState(null,'','/reset-password');
var form=document.getElementById('reset-form');
if(!/^cf(?:lr|ri)_[0-9a-f]{64}$/.test(token)){
  form.hidden=true;
  show('msg','This password link is missing or malformed. Request a new link below.','err');
}else{
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var p=document.getElementById('new-password').value;
    var c=document.getElementById('confirm-password').value;
    if(p!==c){show('msg','Passwords do not match','err');return}
    show('msg','Saving...','');
    api('/api/auth/reset-password','POST',{token:token,password:p})
      .then(function(){form.hidden=true;show('msg','Password set. You can now sign in.','ok')})
      .catch(function(err){show('msg',err.message||'This link is invalid or has expired. Request a new link below.','err')});
  });
}`);
}

export function accountPage(): string {
  return appShell('Account', 'Your CFLab identity, project access, and password.', `
<section class="panel">
  <div class="panel-head"><h2>Profile</h2><p>Signed-in identity and assigned projects.</p></div>
  <div id="profile" class="meta-grid"><p class="muted">Loading...</p></div>
</section>
<section class="panel">
  <div class="panel-head"><h2>Change password</h2><p>Changing your password signs out every session, including this one.</p></div>
  <form id="pw-form">
    <div class="field">
      <label for="current-password">Current password</label>
      <input id="current-password" type="password" autocomplete="current-password" required>
    </div>
    <div class="field">
      <label for="new-password">New password</label>
      <input id="new-password" type="password" autocomplete="new-password" required>
      <p class="hint">At least 15 characters. Spaces and Unicode are allowed.</p>
    </div>
    <div class="field">
      <label for="confirm-password">Confirm new password</label>
      <input id="confirm-password" type="password" autocomplete="new-password" required>
    </div>
    <button type="submit" class="btn btn-primary">Change password</button>
  </form>
  <div id="pw-msg" class="msg" role="status" aria-live="polite"></div>
</section>`, `
function renderProfile(data){
  var u=data.user;
  var role=u.is_admin?'<span class="badge badge-admin">Administrator</span>':'<span class="badge">Project user</span>';
  var projects=data.memberships.length?data.memberships.map(function(m){return '<span class="chip">'+esc(formatId(m.app_id))+' <span class="badge '+(m.access==='write'?'badge-write':'badge-read')+'">'+esc(m.access)+'</span></span>'}).join(''):'<span class="muted">No project assignments</span>';
  document.getElementById('profile').innerHTML='<div class="meta-item"><div class="meta-label">Email</div><div class="meta-value">'+esc(u.email)+'</div></div>'
    +'<div class="meta-item"><div class="meta-label">Role</div><div class="meta-value">'+role+'</div></div>'
    +'<div class="meta-item"><div class="meta-label">Projects</div><div class="meta-value chips">'+projects+'</div></div>';
}
api('/api/auth/me').then(function(data){renderProfile(data);initNav(data.user);wireLogout()},function(){setSession(null);location.href='/admin/login?next='+encodeURIComponent(location.pathname)});
document.getElementById('pw-form').addEventListener('submit',function(e){
  e.preventDefault();
  var p=document.getElementById('new-password').value;
  var c=document.getElementById('confirm-password').value;
  if(p!==c){show('pw-msg','Passwords do not match','err');return}
  api('/api/auth/change-password','POST',{current_password:document.getElementById('current-password').value,new_password:p})
    .then(function(){setSession(null);show('pw-msg','Password changed. Please sign in again.','ok')})
    .catch(function(err){show('pw-msg',err.message,'err')});
});`);
}

export function usersPage(): string {
  return appShell('Users', 'Create users, assign project access, and manage sessions.', `
<section class="panel">
  <div class="panel-head"><h2>Add user</h2><p>Creating a user emails an account-setup invitation with a single-use link. The account stays unusable until the recipient chooses a password.</p></div>
  <form id="create-form" class="inline-form">
    <div class="field grow">
      <label for="new-email">Email</label>
      <input id="new-email" type="email" autocomplete="off" required>
    </div>
    <div class="field checkbox-field">
      <label class="checkbox"><input id="new-admin" type="checkbox"> Administrator</label>
    </div>
    <button type="submit" class="btn btn-primary">Create user</button>
  </form>
  <div id="msg" class="msg" role="status" aria-live="polite"></div>
</section>
<section class="panel">
  <div class="panel-head"><h2>Users</h2><p id="me">Loading...</p></div>
  <div id="users" class="table-wrap"><p class="muted">Loading...</p></div>
</section>
<section class="panel">
  <div class="panel-head"><h2>Projects and storage</h2><p>Identity and permissions live in the primary database. Project data lives in the storage backend shown, resolved by a server-side allowlist.</p></div>
  <div id="projects" class="table-wrap"><p class="muted">Loading...</p></div>
  <div id="signals-health" class="meta-grid" style="margin-top:16px"></div>
</section>`, `
var appsCache=[];
function renderProjects(projects){
  var host=document.getElementById('projects');
  if(!projects.length){host.innerHTML='<p class="muted">No projects registered.</p>';return}
  var rows=projects.map(function(p){
    var storage='<span class="chip">'+esc(p.storage.label)+' <span class="badge">'+esc(p.storage.binding)+'</span></span>';
    var link=p.dashboard?'<a href="'+esc(p.dashboard)+'">Open dashboard</a>':'<span class="muted">n/a</span>';
    return '<tr><td data-label="Project"><div class="user-email">'+esc(p.name)+'</div><div class="hint">'+esc(p.id)+'</div></td>'
      +'<td data-label="Storage">'+storage+'<div class="hint">'+esc(p.storage.backend)+' &middot; '+esc(p.storage.migrations_dir)+'</div></td>'
      +'<td data-label="Dashboard">'+link+'</td></tr>';
  }).join('');
  host.innerHTML='<table class="table"><thead><tr><th scope="col">Project</th><th scope="col">Storage</th><th scope="col">Dashboard</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function renderSignalsHealth(status){
  var host=document.getElementById('signals-health');
  if(!status||!status.project||!status.data){host.innerHTML='<p class="muted">Health is not available for this project.</p>';return}
  var storage=status.project.storage||{};
  var collection=status.collection||{};
  var last=collection.last_runs&&collection.last_runs.length?collection.last_runs[0]:null;
  var backup=status.backup||{};
  var items=[
    ['Storage', (storage.reachable?'<span class="badge badge-active">reachable</span>':'<span class="badge badge-inactive">unreachable</span>')+' <span class="hint">'+esc(storage.binding||'')+'</span>'],
    ['Last collection', last?esc(last.job+' '+last.status)+' <span class="hint">'+esc(last.started_at||'')+'</span>':'<span class="muted">no run yet</span>'],
    ['Source freshness', collection.stale_sources?'<span class="badge badge-inactive">'+collection.stale_sources+' stale</span>':'<span class="badge badge-active">all fresh</span>'],
    ['Observations', esc(String(status.data.observations))+' <span class="hint">'+esc(status.data.last_observation_at||'')+'</span>'],
    ['Open alerts', esc(String(status.data.alerts_open))],
    ['Backup', backup.recorded?(backup.ok?'<span class="badge badge-active">verified fresh</span>':'<span class="badge badge-inactive">stale or missing</span>'):'<span class="badge badge-inactive">not recorded</span>']
  ];
  host.innerHTML=items.map(function(item){return '<div class="meta-item"><div class="meta-label">'+esc(item[0])+'</div><div class="meta-value">'+item[1]+'</div></div>'}).join('');
}
function loadProjects(){
  api('/api/admin/projects').then(function(data){renderProjects(data.projects||[])},function(err){
    document.getElementById('projects').innerHTML='<p class="muted">Could not load projects: '+esc(err.message)+'</p>';
  });
  api('/api/admin/projects/bitcoin-signals/status').then(renderSignalsHealth,function(err){
    document.getElementById('signals-health').innerHTML='<p class="muted">Bitcoin Signals health unavailable: '+esc(err.message)+'</p>';
  });
}
function appName(id){for(var i=0;i<appsCache.length;i++){if(appsCache[i].id===id)return appsCache[i].name||formatId(id)}return formatId(id)}
function inviteBadge(u){
  var i=u.invite||{status:'none'};
  if(i.status==='completed')return '<span class="badge badge-active">Password set</span>';
  if(i.status==='pending')return '<span class="badge" title="Invitation sent '+(i.attempted_at||'')+'">Invitation sent</span>';
  if(i.status==='failed')return '<span class="badge badge-inactive" title="'+esc(i.error||'Delivery failed')+'">Invitation failed</span>';
  if(i.status==='expired')return '<span class="badge">Invitation expired</span>';
  return '<span class="badge">No password</span>';
}
function load(){return Promise.all([api('/api/admin/users'),api('/api/admin/apps')]).then(function(r){appsCache=r[1].apps||[];render(r[0].users||[]);return null})}
function render(users){
  var host=document.getElementById('users');
  if(!users.length){host.innerHTML='<p class="muted">No users yet.</p>';return}
  var rows=users.map(function(u){
    var badges=(u.is_admin?'<span class="badge badge-admin">Admin</span>':'')+(u.active?'<span class="badge badge-active">Active</span>':'<span class="badge badge-inactive">Inactive</span>')+inviteBadge(u);
    var chips=u.memberships.length?u.memberships.map(function(m){return '<span class="chip">'+esc(appName(m.app_id))+' <span class="badge '+(m.access==='write'?'badge-write':'badge-read')+'">'+esc(m.access)+'</span><button type="button" class="icon-btn" data-action="rm-membership" data-user="'+u.id+'" data-app="'+esc(m.app_id)+'" data-email="'+esc(u.email)+'" data-project="'+esc(appName(m.app_id))+'" aria-label="Remove '+esc(appName(m.app_id))+' access">&times;</button></span>'}).join(''):'<span class="muted">None</span>';
    var options=appsCache.map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.name||a.id)+'</option>'}).join('');
    var assign=appsCache.length?'<div class="assign"><label class="sr-only" for="app-'+u.id+'">Project for '+esc(u.email)+'</label><select id="app-'+u.id+'" data-role="app">'+options+'</select><select data-role="access" aria-label="Access level"><option value="read">Read</option><option value="write">Write</option></select><button type="button" class="btn btn-secondary btn-small" data-action="add-membership" data-user="'+u.id+'">Assign</button></div>':'';
    var actions='<div class="btn-row">'
      +'<button type="button" class="btn btn-small '+(u.active?'btn-danger':'btn-secondary')+'" data-action="toggle-active" data-user="'+u.id+'" data-active="'+(u.active?'1':'0')+'" data-email="'+esc(u.email)+'">'+(u.active?'Deactivate':'Activate')+'</button>'
      +'<button type="button" class="btn btn-small '+(u.is_admin?'btn-danger':'btn-secondary')+'" data-action="toggle-admin" data-user="'+u.id+'" data-admin="'+(u.is_admin?'1':'0')+'" data-email="'+esc(u.email)+'">'+(u.is_admin?'Remove admin':'Make admin')+'</button>'
      +'<button type="button" class="btn btn-secondary btn-small" data-action="revoke" data-user="'+u.id+'" data-email="'+esc(u.email)+'">Revoke sessions</button>'
      +(u.active?'<button type="button" class="btn btn-secondary btn-small" data-action="setup" data-user="'+u.id+'" data-email="'+esc(u.email)+'">'+(u.invite&&u.invite.status==='pending'?'Resend invite':'Send invite')+'</button>':'')
      +'</div>';
    return '<tr><td data-label="User"><div class="user-email">'+esc(u.email)+'</div><div class="chips">'+badges+'</div></td>'
      +'<td data-label="Projects">'+chips+assign+'</td>'
      +'<td data-label="Actions">'+actions+'</td></tr>';
  }).join('');
  host.innerHTML='<table class="table"><thead><tr><th scope="col">User</th><th scope="col">Projects</th><th scope="col">Actions</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
document.getElementById('users').addEventListener('click',function(e){
  var b=e.target.closest('button[data-action]');if(!b)return;
  var id=b.getAttribute('data-user'),action=b.getAttribute('data-action'),email=b.getAttribute('data-email')||'this user';
  var done=function(msg){show('msg',msg,'ok');return load()};
  var fail=function(err){show('msg',err.message,'err')};
  if(action==='add-membership'){var assign=b.closest('.assign');var app=assign.querySelector('select[data-role=app]').value;var access=assign.querySelector('select[data-role=access]').value;api('/api/admin/users/'+id+'/memberships','POST',{app_id:app,access:access}).then(function(){return done('Project assigned')},fail)}
  else if(action==='rm-membership'){if(!confirm('Remove '+b.getAttribute('data-project')+' access for '+email+'?'))return;api('/api/admin/users/'+id+'/memberships/'+encodeURIComponent(b.getAttribute('data-app')),'DELETE').then(function(){return done('Project removed')},fail)}
  else if(action==='toggle-active'){if(b.getAttribute('data-active')==='1'&&!confirm('Deactivate '+email+'? Their sessions will be revoked.'))return;api('/api/admin/users/'+id,'PATCH',{active:b.getAttribute('data-active')!=='1'}).then(function(){return done('User updated')},fail)}
  else if(action==='toggle-admin'){if(b.getAttribute('data-admin')==='1'&&!confirm('Remove administrator access from '+email+'?'))return;api('/api/admin/users/'+id,'PATCH',{is_admin:b.getAttribute('data-admin')!=='1'}).then(function(){return done('User updated')},fail)}
  else if(action==='revoke'){if(!confirm('Revoke all sessions for '+email+'? They will need to sign in again.'))return;api('/api/admin/users/'+id+'/revoke-sessions','POST',{}).then(function(d){return done('Revoked '+d.revoked+' session(s)')},fail)}
  else if(action==='setup'){api('/api/admin/users/'+id+'/send-password-setup','POST',{}).then(function(r){return done((r.purpose==='invite'?'Invitation':'Reset link')+' sent to '+email)},function(err){show('msg',err.message,'err');return load()})}
});
document.getElementById('create-form').addEventListener('submit',function(e){
  e.preventDefault();
  api('/api/admin/users','POST',{email:document.getElementById('new-email').value,is_admin:document.getElementById('new-admin').checked})
    .then(function(u){
      document.getElementById('new-email').value='';document.getElementById('new-admin').checked=false;
      if(u.invite&&u.invite.status==='failed'){
        show('msg','User created, but the invitation email was not delivered: '+(u.invite.error||'delivery failed')+'. Use Send invite to try again.','err');
      }else{
        show('msg','User created. Invitation sent to '+u.email+'.','ok');
      }
      return load();
    },function(err){show('msg',err.message,'err')});
});
api('/api/auth/me').then(function(data){
  if(!data.user.is_admin){location.href='/account';return}
  initNav(data.user);wireLogout();
  document.getElementById('me').textContent='Signed in as '+data.user.email;
  load();
  loadProjects();
},function(){setSession(null);location.href='/admin/login?next='+encodeURIComponent(location.pathname)});`);
}
