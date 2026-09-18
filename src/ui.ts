const STYLE = `:root{color-scheme:dark}body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#0b1114;color:#eef7f5}main{max-width:820px;margin:0 auto;padding:24px 16px}h1{color:#58c4a7;font-size:1.3rem}h2{color:#58c4a7;font-size:1rem;margin-top:24px}label{display:block;margin:10px 0 4px;color:#9ab1b0;font-size:.85rem}input,select{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid #28404a;background:#0f181d;color:#eef7f5;width:100%;box-sizing:border-box}button{font:inherit;padding:8px 12px;border-radius:6px;border:1px solid #2f8f79;background:#2f8f79;color:#fff;font-weight:700;cursor:pointer;margin-top:8px}button.secondary{background:#18252b;border-color:#385862;color:#eef7f5}button.danger{background:#3a2020;border-color:#7e3d3a;color:#ffd6d3}table{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:8px}th,td{text-align:left;padding:6px;border-bottom:1px solid #28404a;vertical-align:top}.msg{margin-top:12px;color:#9ab1b0}.err{color:#e77b75}.ok{color:#7fdc8a}.muted{color:#6f8988;font-size:.8rem}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.pill{display:inline-block;border:1px solid #28404a;border-radius:999px;padding:2px 8px;font-size:.75rem;color:#9ab1b0}a{color:#7db7e8}`;
const API_JS = `var SESSION_KEY='cflab_session';function sessionToken(){return sessionStorage.getItem(SESSION_KEY)}function setSession(t){if(t)sessionStorage.setItem(SESSION_KEY,t);else sessionStorage.removeItem(SESSION_KEY)}function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}function show(id,text,kind){var el=document.getElementById(id);if(!el)return;el.textContent=text||'';el.className='msg '+(kind||'')}function api(path,method,body){var headers={};if(body!==undefined)headers['Content-Type']='application/json';var t=sessionToken();if(t)headers['Authorization']='Bearer '+t;return fetch(path,{method:method||'GET',headers:headers,body:body===undefined?undefined:JSON.stringify(body)}).then(function(res){return res.json().catch(function(){return null}).then(function(data){if(!res.ok){var e=new Error((data&&data.error&&data.error.message)||('HTTP '+res.status));e.status=res.status;e.code=data&&data.error&&data.error.code;throw e}return data})})}`;

function shell(title: string, content: string, script: string): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + ' - CFLab</title><style>' + STYLE + '</style></head><body><main><h1>' + title + '</h1>' + content + '</main><script>' + API_JS + script + '</script></body></html>';
}

export function loginPage(): string {
  return shell('CFLab Login', `
<form id="login-form">
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="current-password" required>
  <button type="submit">Log in</button>
</form>
<div id="msg" class="msg" role="status"></div>
<p class="muted"><a href="/forgot-password">Forgot password?</a></p>`, `
document.getElementById('login-form').addEventListener('submit',function(e){
  e.preventDefault();
  show('msg','Signing in...','');
  api('/api/auth/login','POST',{email:document.getElementById('email').value,password:document.getElementById('password').value})
    .then(function(data){setSession(data.token);location.href=data.user.is_admin?'/admin/users':'/account'})
    .catch(function(err){show('msg',err.message,'err')});
});`);
}

export function forgotPage(): string {
  return shell('Forgot Password', `
<form id="forgot-form">
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="username" required>
  <button type="submit">Send reset instructions</button>
</form>
<div id="msg" class="msg" role="status"></div>
<p class="muted"><a href="/admin/login">Back to login</a></p>`, `
document.getElementById('forgot-form').addEventListener('submit',function(e){
  e.preventDefault();
  show('msg','Submitting...','');
  api('/api/auth/forgot-password','POST',{email:document.getElementById('email').value})
    .then(function(data){show('msg',data.message||'If that account exists, password reset instructions have been sent.','ok')})
    .catch(function(err){show('msg',err.message,'err')});
});`);
}

export function resetPage(): string {
  return shell('Reset Password', `
<form id="reset-form">
  <label for="new-password">New password (15+ characters)</label>
  <input id="new-password" type="password" autocomplete="new-password" required>
  <label for="confirm-password">Confirm new password</label>
  <input id="confirm-password" type="password" autocomplete="new-password" required>
  <button type="submit">Set password</button>
</form>
<div id="msg" class="msg" role="status"></div>
<p class="muted"><a href="/admin/login">Back to login</a></p>`, `
var token=new URLSearchParams(location.search).get('token')||'';
if(token)history.replaceState(null,'','/reset-password');
document.getElementById('reset-form').addEventListener('submit',function(e){
  e.preventDefault();
  var p=document.getElementById('new-password').value;
  var c=document.getElementById('confirm-password').value;
  if(p!==c){show('msg','Passwords do not match','err');return}
  show('msg','Saving...','');
  api('/api/auth/reset-password','POST',{token:token,password:p})
    .then(function(){show('msg','Password set. You can now log in.','ok');document.getElementById('reset-form').style.display='none'})
    .catch(function(err){show('msg',err.message,'err')});
});`);
}

export function accountPage(): string {
  return shell('Account', `
<div id="profile" class="msg"></div>
<h2>Change password</h2>
<form id="pw-form">
  <label for="current-password">Current password</label>
  <input id="current-password" type="password" autocomplete="current-password" required>
  <label for="new-password">New password (15+ characters)</label>
  <input id="new-password" type="password" autocomplete="new-password" required>
  <label for="confirm-password">Confirm new password</label>
  <input id="confirm-password" type="password" autocomplete="new-password" required>
  <button type="submit">Change password</button>
</form>
<div id="pw-msg" class="msg" role="status"></div>
<h2>Session</h2>
<button id="logout" class="secondary">Log out</button>
<p class="muted"><a id="admin-link" href="/admin/users" style="display:none">Administration</a></p>`, `
api('/api/auth/me').then(function(data){
  var u=data.user;
  var projects=data.memberships.length?data.memberships.map(function(m){return esc(m.app_id)+' ('+esc(m.access)+')'}).join(', '):'none';
  document.getElementById('profile').innerHTML='<p>Signed in as <strong>'+esc(u.email)+'</strong>'+(u.is_admin?' (administrator)':'')+'</p><p class="muted">Projects: '+projects+'</p>';
  if(u.is_admin)document.getElementById('admin-link').style.display='inline';
},function(){setSession(null);location.href='/admin/login'});
document.getElementById('pw-form').addEventListener('submit',function(e){
  e.preventDefault();
  var p=document.getElementById('new-password').value;
  var c=document.getElementById('confirm-password').value;
  if(p!==c){show('pw-msg','Passwords do not match','err');return}
  api('/api/auth/change-password','POST',{current_password:document.getElementById('current-password').value,new_password:p})
    .then(function(){setSession(null);show('pw-msg','Password changed. Please log in again.','ok')})
    .catch(function(err){show('pw-msg',err.message,'err')});
});
document.getElementById('logout').addEventListener('click',function(){
  api('/api/auth/logout','POST',{}).then(function(){setSession(null);location.href='/admin/login'},function(){setSession(null);location.href='/admin/login'});
});`);
}

export function usersPage(): string {
  return shell('Users', `
<p id="me" class="muted"></p>
<h2>Create user</h2>
<form id="create-form" class="row">
  <input id="new-email" type="email" placeholder="email" required style="flex:1;min-width:220px">
  <label class="muted" style="margin:0"><input id="new-admin" type="checkbox" style="width:auto"> admin</label>
  <button type="submit">Create</button>
</form>
<div id="msg" class="msg" role="status"></div>
<h2>Users</h2>
<div id="users"></div>`, `
var appsCache=[];
function load(){return Promise.all([api('/api/admin/users'),api('/api/admin/apps')]).then(function(r){appsCache=r[1].apps||[];render(r[0].users||[]);return null})}
function render(users){
  var host=document.getElementById('users');
  if(!users.length){host.innerHTML='<p class="muted">No users yet.</p>';return}
  host.innerHTML=users.map(function(u){
    var memberships=u.memberships.length?u.memberships.map(function(m){return '<span class="pill">'+esc(m.app_id)+' ('+esc(m.access)+') <button class="danger" data-action="rm-membership" data-user="'+u.id+'" data-app="'+esc(m.app_id)+'" style="margin:0;padding:0 6px">x</button></span>'}).join(' '):'<span class="muted">no projects</span>';
    var options=appsCache.map(function(a){return '<option value="'+esc(a.id)+'">'+esc(a.id)+'</option>'}).join('');
    return '<div class="user-card" style="border:1px solid #28404a;border-radius:8px;padding:10px;margin-top:10px">'
      +'<div class="row"><strong>'+esc(u.email)+'</strong>'+(u.is_admin?'<span class="pill">admin</span>':'')+(u.active?'':'<span class="pill">inactive</span>')+(u.has_password?'':'<span class="pill">no password</span>')+'</div>'
      +'<div class="row" style="margin-top:6px">'+memberships+'</div>'
      +'<div class="row" style="margin-top:6px"><select data-role="app" style="width:auto">'+options+'</select><select data-role="access" style="width:auto"><option value="read">read</option><option value="write">write</option></select><button class="secondary" data-action="add-membership" data-user="'+u.id+'">Add project</button></div>'
      +'<div class="row" style="margin-top:6px">'
      +'<button class="secondary" data-action="toggle-active" data-user="'+u.id+'" data-active="'+(u.active?'1':'0')+'">'+(u.active?'Deactivate':'Activate')+'</button>'
      +'<button class="secondary" data-action="toggle-admin" data-user="'+u.id+'" data-admin="'+(u.is_admin?'1':'0')+'">'+(u.is_admin?'Remove admin':'Make admin')+'</button>'
      +'<button class="secondary" data-action="revoke" data-user="'+u.id+'">Revoke sessions</button>'
      +'<button class="secondary" data-action="setup" data-user="'+u.id+'">Send setup</button>'
      +'</div></div>';
  }).join('');
}
document.getElementById('users').addEventListener('click',function(e){
  var b=e.target.closest('button[data-action]');if(!b)return;
  var id=b.getAttribute('data-user');var action=b.getAttribute('data-action');
  var done=function(msg){show('msg',msg,'ok');return load()};
  var fail=function(err){show('msg',err.message,'err')};
  if(action==='add-membership'){var card=b.closest('.user-card');var app=card.querySelector('select[data-role=app]').value;var access=card.querySelector('select[data-role=access]').value;api('/api/admin/users/'+id+'/memberships','POST',{app_id:app,access:access}).then(function(){return done('Project added')},fail)}
  else if(action==='rm-membership'){api('/api/admin/users/'+id+'/memberships/'+encodeURIComponent(b.getAttribute('data-app')),'DELETE').then(function(){return done('Project removed')},fail)}
  else if(action==='toggle-active'){api('/api/admin/users/'+id,'PATCH',{active:b.getAttribute('data-active')!=='1'}).then(function(){return done('User updated')},fail)}
  else if(action==='toggle-admin'){api('/api/admin/users/'+id,'PATCH',{is_admin:b.getAttribute('data-admin')!=='1'}).then(function(){return done('User updated')},fail)}
  else if(action==='revoke'){api('/api/admin/users/'+id+'/revoke-sessions','POST',{}).then(function(d){return done('Revoked '+d.revoked+' session(s)')},fail)}
  else if(action==='setup'){api('/api/admin/users/'+id+'/send-password-setup','POST',{}).then(function(){return done('Setup email sent')},fail)}
});
document.getElementById('create-form').addEventListener('submit',function(e){
  e.preventDefault();
  api('/api/admin/users','POST',{email:document.getElementById('new-email').value,is_admin:document.getElementById('new-admin').checked})
    .then(function(){document.getElementById('new-email').value='';document.getElementById('new-admin').checked=false;show('msg','User created. Send setup when ready.','ok');return load()},function(err){show('msg',err.message,'err')});
});
api('/api/auth/me').then(function(data){
  if(!data.user.is_admin){location.href='/account';return}
  document.getElementById('me').textContent='Signed in as '+data.user.email;
  load();
},function(){setSession(null);location.href='/admin/login'});`);
}
