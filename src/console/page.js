// CFLab operations console page.
//
// A plain JavaScript module (no bundler, no framework, no CDN) so the Worker can
// serve it inline and the Node UI tests can import the exact same HTML and client
// script. The primary Worker serves no static assets, so the stylesheet lives here
// and reuses the design tokens of the existing CFLab pages.
//
// The shell carries no measurements. Every figure is fetched from the
// administrator-only /api/admin/console/* API with the human session token that
// the existing sign-in flow already stores, so an unauthenticated visitor is sent
// through /admin/login exactly like /admin/users does today.

// CFLab brand mark, identical to the one in src/ui.ts and analytics-ui/index.html:
// a bold laboratory-flask silhouette in Cloudflare orange with a white circuit
// trace. Inlined as a data URI, so loading the console makes no favicon request.
// The favicon regression test asserts all three copies stay byte-identical.
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#F38020" d="M12.5 5v7.5L6.6 24.2A2.6 2.6 0 0 0 9 28h14a2.6 2.6 0 0 0 2.4-3.8L19.5 12.5V5z"/><path fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M11.4 23.4h2.3m7.9-.9 2.2-2.2"/><circle cx="16" cy="23.4" r="3" fill="#FFFFFF"/><circle cx="21.4" cy="20.3" r="1.5" fill="#FFFFFF"/></svg>';
const CONSOLE_FAVICON = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,'
  + encodeURIComponent(FAVICON_SVG).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27') + '">';

const CONSOLE_STYLE = `
:root{color-scheme:light;--bg:#f6f7f9;--surface:#fff;--surface-muted:#f9fafb;--muted:#5f6b7a;--text:#1f2933;--border:#e4e7ec;--border-strong:#d0d5dd;--accent:#2563eb;--accent-hover:#1d4ed8;--accent-soft:#eff4ff;--success:#067647;--success-soft:#ecfdf3;--warning:#b54708;--warning-soft:#fffaeb;--danger:#b42318;--danger-soft:#fef3f2;--radius:8px;--shadow:0 1px 2px rgba(16,24,40,.05)}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
h1{font-size:22px;line-height:1.25;margin:0 0 4px;font-weight:650}h2{font-size:16px;margin:0 0 2px;font-weight:600}h3{font-size:14px;margin:0 0 8px;font-weight:600}p{margin:0 0 10px}
code,pre,textarea.sql{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:-999px;top:0;background:var(--surface);padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;z-index:10}
.skip:focus{left:12px;top:12px}
.muted{color:var(--muted)}.lede{color:var(--muted);font-size:14px;margin:0}.hint{font-size:12.5px;color:var(--muted);margin:6px 0 0}
.app-header{background:var(--surface);border-bottom:1px solid var(--border)}
.app-header-inner{max-width:1240px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{font-weight:700;font-size:16px;color:var(--text)}
.nav{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nav a,.nav button.link{color:var(--muted);font-size:14px;background:none;border:none;padding:0;font:inherit;cursor:pointer}
.nav a:hover,.nav button.link:hover{color:var(--text);text-decoration:underline}
.tabs{background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
.tabs-inner{max-width:1240px;margin:0 auto;padding:6px 20px;display:flex;gap:6px;overflow-x:auto}
.tab{font:inherit;font-size:13.5px;font-weight:600;padding:8px 12px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer;white-space:nowrap}
.tab[aria-selected=true]{background:var(--accent-soft);border-color:#c7d7fe;color:var(--accent-hover)}
.container{max-width:1240px;margin:0 auto;padding:24px 20px 64px}
.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-bottom:18px}
.panel-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px}
.panel-head p{margin:0;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:18px}
.card{border:1px solid var(--border);border-radius:var(--radius);padding:14px;background:var(--surface)}
.card-title{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.value{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;word-break:break-word}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.6;border:1px solid var(--border);background:var(--surface-muted);color:var(--muted);white-space:nowrap}
.badge-ok{background:var(--success-soft);border-color:#abefc6;color:var(--success)}
.badge-warn{background:var(--warning-soft);border-color:#fedf89;color:var(--warning)}
.badge-bad{background:var(--danger-soft);border-color:#fecdca;color:var(--danger)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:var(--surface-muted);border-radius:999px;padding:2px 10px;font-size:12.5px;color:var(--text);max-width:100%}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;font:inherit;font-size:13.5px;font-weight:600;line-height:1.2;border-radius:6px;border:1px solid transparent;cursor:pointer;background:var(--surface);color:var(--text);white-space:nowrap}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--accent-hover)}
.btn-secondary{background:var(--surface);border-color:var(--border-strong);color:var(--text)}
.btn-secondary:hover:not(:disabled){background:var(--surface-muted)}
.btn-small{padding:5px 9px;font-size:12.5px}
.btn-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search],input[type=text],select,textarea{width:100%;padding:9px 11px;font:inherit;font-size:14px;color:var(--text);background:var(--surface);border:1px solid var(--border-strong);border-radius:6px}
textarea.sql{min-height:150px;resize:vertical;white-space:pre;tab-size:2}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.field{margin-bottom:12px}
.msg{font-size:13.5px;margin-top:10px}
.msg:empty{display:none}
.msg-error{color:var(--danger);background:var(--danger-soft);border:1px solid #fecdca;padding:8px 10px;border-radius:6px}
.msg-ok{color:var(--success);background:var(--success-soft);border:1px solid #abefc6;padding:8px 10px;border-radius:6px}
.msg-info{color:var(--muted)}
.warnings{display:grid;gap:8px;margin-bottom:18px}
.warning{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-left-width:4px;border-radius:6px;padding:10px 12px;background:var(--surface);font-size:13.5px}
.warning.error{border-left-color:var(--danger)}
.warning.warning{border-left-color:#dc6803}
.warning.info{border-left-color:var(--accent)}
.table-wrap{overflow-x:auto}
.table{width:100%;min-width:640px;border-collapse:collapse;font-size:13.5px}
.table th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;padding:8px;border-bottom:1px solid var(--border);white-space:nowrap}
.table td{padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top;word-break:break-word}
.table tbody tr:last-child td{border-bottom:none}
.table caption{text-align:left;color:var(--muted);font-size:12.5px;padding-bottom:8px}
details.service{border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:10px;background:var(--surface)}
details.service>summary{cursor:pointer;font-weight:600}
details.service[open]>summary{margin-bottom:10px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.kv .card-title{margin-bottom:2px}
pre.sql-copy{white-space:pre-wrap;word-break:break-word;background:var(--surface-muted);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12.5px;margin:6px 0 0;max-height:180px;overflow:auto}
.pager{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}
.metrics{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.split{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:16px}
@media (max-width:900px){.split{grid-template-columns:1fr}}
@media (max-width:720px){
  .table{min-width:0}
  .table thead{display:none}
  .table tr{display:block;border-bottom:1px solid var(--border);padding:6px 0}
  .table td{display:block;border-bottom:none;padding:4px 0}
  .table td::before{content:attr(data-label);display:block;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600}
}
`;

const CONSOLE_BODY = `
<a class="skip" href="#main">Skip to content</a>
<header class="app-header">
  <div class="app-header-inner">
    <a class="brand" href="/">CFLab operations</a>
    <nav class="nav" aria-label="Account">
      <span class="muted" id="who">Checking session…</span>
      <a href="/bitcoin-signals">Bitcoin Signals</a>
      <a href="/admin/users">Users</a>
      <a href="/account">Account</a>
      <button type="button" class="link" id="logout">Sign out</button>
    </nav>
  </div>
</header>
<div class="tabs" role="tablist" aria-label="Console sections">
  <div class="tabs-inner">
    <button class="tab" role="tab" id="tabbtn-overview" aria-controls="tab-overview" aria-selected="true" data-tab="overview">Overview</button>
    <button class="tab" role="tab" id="tabbtn-projects" aria-controls="tab-projects" aria-selected="false" tabindex="-1" data-tab="projects">Projects</button>
    <button class="tab" role="tab" id="tabbtn-databases" aria-controls="tab-databases" aria-selected="false" tabindex="-1" data-tab="databases">Databases</button>
    <button class="tab" role="tab" id="tabbtn-jobs" aria-controls="tab-jobs" aria-selected="false" tabindex="-1" data-tab="jobs">Jobs</button>
    <button class="tab" role="tab" id="tabbtn-system" aria-controls="tab-system" aria-selected="false" tabindex="-1" data-tab="system">System</button>
  </div>
</div>
<main id="main" class="container">
  <section id="tab-overview" role="tabpanel" aria-labelledby="tabbtn-overview" tabindex="0">
    <div class="page-head">
      <div><h1>Operations overview</h1><p class="lede">Live state of the deployed services. Every figure is read from a database this Worker already binds.</p></div>
      <span class="badge" id="revision">revision unknown</span>
    </div>
    <div id="overview-warnings" class="warnings"></div>
    <div id="overview-cards" class="grid"></div>
    <section class="panel" aria-labelledby="activity-title">
      <div class="panel-head"><div><h2 id="activity-title">Recent activity</h2><p>Collection runs, job attempts, and sign-ins, newest first.</p></div></div>
      <div id="activity" class="table-wrap"><p class="muted">Loading…</p></div>
    </section>
    <section class="panel" aria-labelledby="health-title">
      <div class="panel-head"><div><h2 id="health-title">Database health</h2><p>One bounded probe per bound database.</p></div></div>
      <div id="overview-health" class="chips"></div>
    </section>
  </section>
  <section id="tab-projects" role="tabpanel" aria-labelledby="tabbtn-projects" tabindex="0" hidden>
    <div class="page-head"><div><h1>Projects and services</h1><p class="lede">Service registry seeded from the deployed configuration, with each endpoint's access boundary.</p></div></div>
    <div class="field"><label for="project-search">Filter</label><input id="project-search" type="search" placeholder="Search services, endpoints, resources…" autocomplete="off"></div>
    <div id="projects-list"><p class="muted">Loading…</p></div>
    <section class="panel" aria-labelledby="repos-title">
      <div class="panel-head"><div><h2 id="repos-title">Repositories</h2><p>Authoritative source for these deployments.</p></div></div>
      <div id="repos" class="kv"></div>
    </section>
  </section>
  <section id="tab-databases" role="tabpanel" aria-labelledby="tabbtn-databases" tabindex="0" hidden>
    <div class="page-head"><div><h1>Databases</h1><p class="lede">Allowlisted D1 databases only. Statements are executed read-only with bounded rows and are audited by hash.</p></div></div>
    <section class="panel" aria-labelledby="db-pick-title">
      <div class="panel-head"><div><h2 id="db-pick-title">Inventory</h2><p>Resolved through the server-side binding allowlist.</p></div></div>
      <div class="field"><label for="db-select">Database</label><select id="db-select"></select></div>
      <div id="db-inventory" class="chips"></div>
    </section>
    <div class="split">
      <section class="panel" aria-labelledby="schema-title">
        <div class="panel-head"><div><h2 id="schema-title">Schema</h2><p>Select a table to insert a query.</p></div></div>
        <div id="schema"><p class="muted">Loading…</p></div>
      </section>
      <section class="panel" aria-labelledby="workbench-title">
        <div class="panel-head"><div><h2 id="workbench-title">SQL workbench</h2><p>One read-only statement. Multi-statement, write, DDL, PRAGMA and ATTACH input is refused before execution.</p></div></div>
        <div class="field">
          <label for="sql">Statement</label>
          <textarea id="sql" class="sql" spellcheck="false">SELECT name, type FROM sqlite_master WHERE type = 'table' ORDER BY name</textarea>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="run">Run</button>
          <button type="button" class="btn btn-secondary" id="export">Export CSV</button>
          <button type="button" class="btn btn-secondary" id="save-open">Save statement</button>
        </div>
        <div id="db-msg" class="msg" role="status" aria-live="polite"></div>
        <div id="save-form" hidden>
          <div class="field" style="margin-top:12px"><label for="save-name">Name</label><input id="save-name" type="text" maxlength="80" autocomplete="off"></div>
          <button type="button" class="btn btn-secondary btn-small" id="save">Save</button>
        </div>
        <div id="db-metrics" class="metrics" style="margin-top:10px"></div>
        <div id="db-results" class="table-wrap" style="margin-top:10px"></div>
        <div class="pager">
          <button type="button" class="btn btn-secondary btn-small" id="prev" disabled>Previous</button>
          <span class="metrics" id="page-label">Page 1</span>
          <button type="button" class="btn btn-secondary btn-small" id="next" disabled>Next</button>
        </div>
      </section>
    </div>
    <section class="panel" aria-labelledby="saved-title">
      <div class="panel-head"><div><h2 id="saved-title">Saved statements</h2><p>Private to your administrator account.</p></div></div>
      <div id="saved-queries"><p class="muted">Loading…</p></div>
    </section>
  </section>
  <section id="tab-jobs" role="tabpanel" aria-labelledby="tabbtn-jobs" tabindex="0" hidden>
    <div class="page-head"><div><h1>Scheduled jobs</h1><p class="lede">Existing cron triggers only. History is read from the subsystem that records it.</p></div></div>
    <div id="jobs"><p class="muted">Loading…</p></div>
  </section>
  <section id="tab-system" role="tabpanel" aria-labelledby="tabbtn-system" tabindex="0" hidden>
    <div class="page-head"><div><h1>System</h1><p class="lede">Release identity, binding presence, database reachability and backup status. Values are never returned.</p></div></div>
    <div id="system"><p class="muted">Loading…</p></div>
    <div id="system-notes" class="hint"></div>
  </section>
</main>
`;

const SCRIPT = `
(function(){
  'use strict';
  var SESSION_KEY='cflab_session';
  var state={ tab:'overview', loaded:{}, databases:[], databaseId:null, schema:null, sql:'', page:1, hasMore:false };
  function token(){ return sessionStorage.getItem(SESSION_KEY) }
  function esc(value){ return String(value==null?'':value).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] }) }
  function show(id,text,kind){ var el=document.getElementById(id); if(!el)return; el.textContent=text||''; el.className='msg'+(kind==='err'?' msg-error':kind==='ok'?' msg-ok':kind?' msg-info':'') }
  function signOut(returnTo){ sessionStorage.removeItem(SESSION_KEY); location.href = typeof returnTo === 'string' && returnTo.charAt(0) === '/' ? '/admin/login?next=' + encodeURIComponent(returnTo) : '/admin/login' }
  function api(path,method,body){
    var headers={}; if(body!==undefined)headers['Content-Type']='application/json';
    var t=token(); if(t)headers['Authorization']='Bearer '+t;
    return fetch(path,{method:method||'GET',headers:headers,body:body===undefined?undefined:JSON.stringify(body)}).then(function(res){
      if(res.status===401){ signOut(location.pathname); throw new Error('Sign in required') }
      if(res.status===403){ location.href='/account'; throw new Error('Administrator access required') }
      return res.text().then(function(text){
        var data=null; try{ data=text?JSON.parse(text):null }catch(e){ data=null }
        if(!res.ok){ var err=new Error((data&&data.error&&data.error.message)||('HTTP '+res.status)); err.status=res.status; err.code=data&&data.error&&data.error.code; throw err }
        return data;
      });
    });
  }
  function fmt(n){ return n===null||n===undefined?'&mdash;':Number(n).toLocaleString() }
  function when(iso){
    if(!iso)return '<span class="muted">&mdash;</span>';
    var t=Date.parse(iso); if(!Number.isFinite(t))return '<span class="muted">&mdash;</span>';
    var diff=Date.now()-t, value=Math.abs(diff), text;
    if(diff>=0){ text=value<60000?'just now':value<3600000?Math.round(value/60000)+'m ago':value<86400000?Math.round(value/3600000)+'h ago':Math.round(value/86400000)+'d ago' }
    else{ text='in '+Math.max(1,Math.round(value/60000))+'m' }
    return '<span title="'+esc(iso)+'">'+esc(text)+'</span>';
  }
  function duration(run){
    if(!run||!run.finished_at||!run.started_at)return '&mdash;';
    var ms=Date.parse(run.finished_at)-Date.parse(run.started_at);
    return Number.isFinite(ms)&&ms>=0?(ms<1000?ms+' ms':Math.round(ms/1000)+' s'):'&mdash;';
  }
  function badge(status){
    var text=String(status==null?'unknown':status);
    var kind=/^(ok|success|active|recorded|reachable|configured)$/.test(text)?'badge-ok':/^(failed|error|inactive|unreachable)$/.test(text)?'badge-bad':/^(partial|warning|stale|unavailable|unknown|external|unconfigured)$/.test(text)?'badge-warn':'';
    return '<span class="badge '+kind+'">'+esc(text)+'</span>';
  }
  function table(headers,rows,caption){
    var head='<tr>'+headers.map(function(h){ return '<th scope="col">'+esc(h)+'</th>' }).join('')+'</tr>';
    var body=rows.map(function(row){
      return '<tr>'+row.map(function(cell,index){ return '<td data-label="'+esc(headers[index])+'">'+cell+'</td>' }).join('')+'</tr>';
    }).join('');
    return '<table class="table">'+(caption?'<caption>'+esc(caption)+'</caption>':'')+'<thead>'+head+'</thead><tbody>'+body+'</tbody></table>';
  }
  function panel(title,lede,body){
    return '<section class="panel"><div class="panel-head"><div><h2>'+esc(title)+'</h2><p>'+esc(lede||'')+'</p></div></div>'+body+'</section>';
  }
  function card(title,value,hint){
    return '<div class="card"><div class="card-title">'+esc(title)+'</div><div class="value">'+value+'</div>'+(hint?'<div class="hint">'+esc(hint)+'</div>':'')+'</div>';
  }
  function renderOverview(data){
    document.getElementById('revision').textContent='revision '+(data.revision||'unknown');
    var warnings=document.getElementById('overview-warnings');
    warnings.innerHTML=data.warnings.length?data.warnings.map(function(w){
      return '<div class="warning '+esc(w.severity)+'"><span class="badge '+(w.severity==='error'?'badge-bad':w.severity==='warning'?'badge-warn':'')+'">'+esc(w.severity)+'</span><div>'+esc(w.message)+'</div></div>';
    }).join(''):'<div class="warning info"><span class="badge badge-ok">ok</span><div>No operational warnings.</div></div>';
    var s=data.summary;
    document.getElementById('overview-cards').innerHTML=
      card('Projects',fmt(s.active_projects)+' / '+fmt(s.projects),'active / registered')+
      card('Administrators',fmt(s.administrators),fmt(s.users)+' active users')+
      card('Sessions',fmt(s.sessions),'unexpired, unrevoked')+
      card('Analytics sites',fmt(s.analytics_sites),'active sites')+
      card('Signals observations',fmt(s.signals_observations),'retained rows')+
      card('Jobs',fmt(s.jobs),'scheduled triggers')+
      card('Databases',fmt(s.databases),'bound D1 stores');
    document.getElementById('activity').innerHTML=data.activity.length?table(
      ['When','Area','Status','Summary'],
      data.activity.map(function(entry){ return [when(entry.at),esc(entry.area),badge(entry.status),esc(entry.summary)] }),
      'Newest first'):'<p class="muted">No activity recorded yet.</p>';
    document.getElementById('overview-health').innerHTML=data.health.databases.map(function(db){
      return '<span class="chip">'+esc(db.label)+' '+badge(db.reachable?'reachable':'unreachable')+'</span>';
    }).join('');
  }
  function renderProjects(data, filter){
    var needle=(filter||'').trim().toLowerCase();
    var services=data.services.filter(function(service){
      if(!needle)return true;
      var hay=[service.name,service.id,service.description,service.kind].concat(service.endpoints.map(function(e){return e.method+' '+e.path}),service.resources.map(function(r){return r.reference})).join(' ').toLowerCase();
      return hay.indexOf(needle)>=0;
    });
    var html=services.length?services.map(function(service){
      var endpoints=service.endpoints.length?table(['Method','Path','Access','Purpose'],
        service.endpoints.map(function(e){ return ['<code>'+esc(e.method)+'</code>','<code>'+esc(e.path)+'</code>',badge(e.access),esc(e.summary)] }),
        service.name+' endpoints'):'<p class="muted">No endpoints registered.</p>';
      var resources=service.resources.length?'<div class="chips" style="margin-top:10px">'+service.resources.map(function(r){
        return '<span class="chip">'+esc(r.kind)+': '+esc(r.reference)+'</span>';
      }).join('')+'</div>':'';
      var links='<div class="btn-row" style="margin-top:8px">'+
        (service.dashboard_path?'<a class="btn btn-secondary btn-small" href="'+esc(service.dashboard_path)+'">Open dashboard</a>':'')+
        (service.base_url?'<a class="btn btn-secondary btn-small" href="'+esc(service.base_url)+'">'+esc(service.base_url)+'</a>':'')+
        '</div>';
      return '<details class="service"><summary>'+esc(service.name)+' '+badge(service.status)+' <span class="muted">'+esc(service.kind)+' &middot; '+service.endpoints.length+' endpoints</span></summary>'+
        '<p class="muted">'+esc(service.description)+'</p>'+links+'<div style="margin-top:10px">'+endpoints+'</div>'+resources+'</details>';
    }).join(''):'<p class="muted">No service matches that filter.</p>';
    document.getElementById('projects-list').innerHTML=html;
    document.getElementById('repos').innerHTML=data.repositories.map(function(repo){
      return '<div class="card"><div class="card-title">'+esc(repo.name)+'</div><div>'+esc(repo.branch)+'</div><div class="hint">'+esc(repo.detail)+'</div></div>';
    }).join('')||'<p class="muted">No repository registered.</p>';
  }
  function loadProjects(){
    return api('/api/admin/console/registry').then(function(data){
      state.registry=data;
      renderProjects(data,document.getElementById('project-search').value);
    }).catch(function(err){ document.getElementById('projects-list').innerHTML='<p class="msg msg-error">'+esc(err.message)+'</p>' });
  }
  function loadOverview(){
    return api('/api/admin/console/overview').then(renderOverview).catch(function(err){
      document.getElementById('overview-warnings').innerHTML='<div class="warning error"><div>'+esc(err.message)+'</div></div>';
    });
  }
  function renderJobs(data){
    var rows=data.jobs.map(function(job){
      var attempt=job.last_attempt;
      return [
        '<strong>'+esc(job.name)+'</strong><div class="hint">'+esc(job.description)+'</div>',
        '<code>'+esc(job.schedule)+'</code><div class="hint">'+esc(job.schedule_timezone)+'</div>',
        job.next_run_at?when(job.next_run_at):'<span class="muted">unsupported</span>',
        attempt?when(attempt.started_at)+' '+badge(attempt.status):'<span class="muted">&mdash;</span>',
        job.last_success_at?when(job.last_success_at):'<span class="muted">never</span>',
        duration(attempt),
        job.history==='external'?'<span class="muted">workflow</span>':job.history==='unavailable'?badge('unavailable'):job.stale?badge('stale'):badge('ok'),
        job.warnings.length?esc(job.warnings.join('; ')):'<span class="muted">&mdash;</span>',
      ];
    });
    document.getElementById('jobs').innerHTML=rows.length?panel('Schedules','Cron expressions declared in wrangler.jsonc; history from the owning subsystem.',
      table(['Job','Schedule','Next expected','Last attempt','Last success','Duration','State','Warnings'],rows,'All active scheduled jobs')):'<p class="muted">No jobs registered.</p>';
  }
  function loadJobs(){
    return api('/api/admin/console/jobs').then(renderJobs).catch(function(err){ document.getElementById('jobs').innerHTML='<p class="msg msg-error">'+esc(err.message)+'</p>' });
  }
  function renderSystem(data){
    var bindings=table(['Binding','Type','State','Purpose'],data.bindings.map(function(b){
      return ['<code>'+esc(b.name)+'</code>',esc(b.type),badge(b.configured?'configured':'unconfigured'),esc(b.purpose)];
    }),'Presence only; values are never read into this page');
    var databases=table(['Database','Binding','Reachable','Tables','Indexes','Views'],data.databases.map(function(db){
      return [esc(db.label),'<code>'+esc(db.binding)+'</code>',badge(db.reachable?'reachable':'unreachable'),fmt(db.tables),fmt(db.indexes),fmt(db.views)];
    }),'Bound D1 databases');
    var backup=data.backup;
    var backupCard='<div class="kv">'+
      '<div class="card"><div class="card-title">Attestation</div><div class="value">'+(backup.recorded?badge(backup.ok?'ok':'failed'):badge('unavailable'))+'</div><div class="hint">'+(backup.recorded?'checked '+esc(backup.checked_at):'No attestation recorded')+'</div></div>'+
      '<div class="card"><div class="card-title">Age</div><div class="value">'+(backup.age_hours==null?'&mdash;':fmt(backup.age_hours)+' h')+'</div><div class="hint">limit '+fmt(backup.max_age_hours)+' h</div></div>'+
      '<div class="card"><div class="card-title">State</div><div class="value">'+(backup.recorded?(backup.stale?'stale':'fresh'):'unknown')+'</div><div class="hint">append-only backup bucket; not bound here</div></div>'+
      '</div>';
    document.getElementById('system').innerHTML=
      panel('Release','Deployed revision reported by this Worker.',
        '<div class="kv"><div class="card"><div class="card-title">Worker</div><div class="value" style="font-size:16px">'+esc(data.worker)+'</div></div>'+
        '<div class="card"><div class="card-title">Revision</div><div class="value" style="font-size:16px;word-break:break-all">'+esc(data.revision)+'</div></div></div>')+
      panel('Bindings','Configuration surface of the primary Worker.',bindings)+
      panel('Databases','Reachability and size of each bound D1 store.',databases)+
      panel('Backup status','Recorded three-database verification.',backupCard);
    document.getElementById('system-notes').textContent=data.notes.join(' ');
  }
  function loadSystem(){
    return api('/api/admin/console/system').then(renderSystem).catch(function(err){ document.getElementById('system').innerHTML='<p class="msg msg-error">'+esc(err.message)+'</p>' });
  }
  function renderInventory(data){
    state.databases=data.databases;
    var select=document.getElementById('db-select');
    select.innerHTML=data.databases.map(function(db){ return '<option value="'+esc(db.id)+'">'+esc(db.label)+' ('+esc(db.binding)+')</option>' }).join('');
    document.getElementById('db-inventory').innerHTML=data.databases.map(function(db){
      return '<span class="chip">'+esc(db.id)+' '+badge(db.reachable?'reachable':'unreachable')+' <span class="muted">'+fmt(db.tables)+' tables</span></span>';
    }).join('');
    var first=data.databases.filter(function(db){return db.reachable})[0]||data.databases[0];
    if(first){ state.databaseId=first.id; select.value=first.id; return loadSchema(first.id) }
  }
  function loadDatabases(){
    return api('/api/admin/console/databases').then(renderInventory).then(loadSaved).catch(function(err){
      document.getElementById('db-inventory').innerHTML='<p class="msg msg-error">'+esc(err.message)+'</p>';
    });
  }
  function loadSchema(id){
    state.databaseId=id; state.page=1; state.hasMore=false;
    document.getElementById('schema').innerHTML='<p class="muted">Loading…</p>';
    return api('/api/admin/console/databases/'+encodeURIComponent(id)+'/schema').then(function(data){
      state.schema=data;
      var html=data.tables.map(function(t){
        var columns=table(['Column','Type','Not null','Default','PK'],t.columns.map(function(c){
          return [esc(c.name),esc(c.type||''),c.not_null?'yes':'',esc(c.default_value||''),c.primary_key?String(c.primary_key):''];
        }),t.name+' columns');
        var indexes=t.indexes.length?table(['Index','Unique','Columns'],t.indexes.map(function(i){
          return [esc(i.name),i.unique?'yes':'',esc(i.columns.join(', '))];
        }),t.name+' indexes'):'';
        return '<details style="margin-bottom:6px"><summary>'+esc(t.name)+' <span class="muted">'+t.columns.length+' columns</span></summary>'+
          '<button type="button" class="btn btn-secondary btn-small" data-table="'+esc(t.name)+'" style="margin-bottom:8px">Query this table</button>'+
          columns+indexes+'</details>';
      }).join('');
      document.getElementById('schema').innerHTML=html||'<p class="muted">No tables.</p>';
    }).catch(function(err){ document.getElementById('schema').innerHTML='<p class="msg msg-error">'+esc(err.message)+'</p>' });
  }
  function renderResults(outcome){
    state.page=outcome.metrics.page; state.hasMore=outcome.metrics.has_more;
    document.getElementById('page-label').textContent='Page '+outcome.metrics.page;
    document.getElementById('prev').disabled=state.page<=1;
    document.getElementById('next').disabled=!state.hasMore;
    document.getElementById('db-metrics').textContent=[
      outcome.rows.length+' row(s)',
      outcome.metrics.duration_ms+' ms wall',
      outcome.metrics.sql_duration_ms==null?null:outcome.metrics.sql_duration_ms+' ms sql',
      outcome.metrics.rows_read==null?null:outcome.metrics.rows_read+' read',
      'database '+outcome.database.id
    ].filter(Boolean).join(' \u00b7 ');
    document.getElementById('db-results').innerHTML=outcome.columns.length
      ? table(outcome.columns,outcome.rows.map(function(row){ return row.map(function(cell){ return esc(cell) }) }),'Results')
      : '<p class="muted">No rows returned.</p>';
  }
  function runQuery(page){
    state.sql=document.getElementById('sql').value;
    show('db-msg','Running…','info');
    return api('/api/admin/console/databases/'+encodeURIComponent(state.databaseId)+'/query','POST',{sql:state.sql,page:page||1,page_size:50})
      .then(function(outcome){ show('db-msg','',''); renderResults(outcome) })
      .catch(function(err){
        show('db-msg',err.message,'err');
        document.getElementById('db-results').innerHTML=''; document.getElementById('db-metrics').textContent='';
        document.getElementById('prev').disabled=true; document.getElementById('next').disabled=true;
      });
  }
  function exportCsv(){
    var headers={'Content-Type':'application/json'}, t=token(); if(t)headers['Authorization']='Bearer '+t;
    show('db-msg','Preparing CSV…','info');
    return fetch('/api/admin/console/databases/'+encodeURIComponent(state.databaseId)+'/export',{method:'POST',headers:headers,body:JSON.stringify({sql:document.getElementById('sql').value})})
      .then(function(res){
        if(res.status===401){ signOut(location.pathname); throw new Error('Sign in required') }
        if(!res.ok){ return res.text().then(function(text){
          var data=null; try{ data=text?JSON.parse(text):null }catch(e){ data=null }
          throw new Error((data&&data.error&&data.error.message)||('HTTP '+res.status));
        }) }
        var name='cflab-'+state.databaseId+'.csv';
        var match=/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition')||''); if(match)name=match[1];
        return res.blob().then(function(blob){
          var url=URL.createObjectURL(blob), link=document.createElement('a');
          link.href=url; link.download=name; document.body.appendChild(link); link.click(); link.remove();
          setTimeout(function(){URL.revokeObjectURL(url)},2000);
          show('db-msg','Exported '+name,'ok');
        });
      }).catch(function(err){ show('db-msg',err.message,'err') });
  }
  function renderSaved(queries){
    document.getElementById('saved-queries').innerHTML=queries.length?table(['Name','Database','Updated','Actions'],queries.map(function(q){
      return [esc(q.name),esc(q.database_id),when(q.updated_at),
        '<div class="btn-row"><button type="button" class="btn btn-secondary btn-small" data-load="'+esc(q.id)+'">Load</button>'+
        '<button type="button" class="btn btn-secondary btn-small" data-delete="'+esc(q.id)+'">Delete</button></div>'];
    }),'Your saved statements'):'<p class="muted">No saved statements yet.</p>';
  }
  function loadSaved(){
    return api('/api/admin/console/saved-queries').then(function(data){ renderSaved(data.queries) })
      .catch(function(err){ document.getElementById('saved-queries').innerHTML='<p class="msg msg-error">'+esc(err.message)+'</p>' });
  }
  function saveQuery(){
    var name=document.getElementById('save-name').value.trim();
    if(!name){ show('db-msg','Enter a name for the statement','err'); return }
    return api('/api/admin/console/saved-queries','POST',{name:name,database_id:state.databaseId,sql:document.getElementById('sql').value})
      .then(function(){ document.getElementById('save-form').hidden=true; document.getElementById('save-name').value=''; show('db-msg','Statement saved','ok'); return loadSaved() })
      .catch(function(err){ show('db-msg',err.message,'err') });
  }
  var loaders={overview:loadOverview,projects:loadProjects,databases:loadDatabases,jobs:loadJobs,system:loadSystem};
  function selectTab(name,updateHash){
    if(!loaders[name])name='overview';
    state.tab=name;
    var tabs=document.querySelectorAll('[role=tab]');
    for(var i=0;i<tabs.length;i+=1){
      var btn=tabs[i], active=btn.getAttribute('data-tab')===name;
      btn.setAttribute('aria-selected',active?'true':'false');
      btn.tabIndex=active?0:-1;
      var panel=document.getElementById('tab-'+btn.getAttribute('data-tab'));
      if(panel)panel.hidden=!active;
    }
    if(updateHash!==false)history.replaceState(null,'','#'+name);
    scrollToTop();
    if(!state.loaded[name]){
      state.loaded[name]=true;
      try{ var pending=loaders[name](); if(pending&&pending.catch)pending.catch(function(error){ reportPanelError(name,error) }) }
      catch(error){ reportPanelError(name,error) }
    }
  }
  // A tab switch must not leave the viewport scrolled past the (now shorter)
  // panel, and a render failure must be visible in the panel instead of leaving
  // an apparently blank page.
  function scrollToTop(){ try{ window.scrollTo(0,0) }catch(e){} }
  function reportPanelError(name,error){
    var target=document.getElementById(name==='overview'?'overview-warnings':name);
    if(!target)return;
    var message=error&&error.message?error.message:'The section could not be loaded';
    target.innerHTML='<div class="warning error"><span class="badge badge-bad">error</span><div>'+esc(message)+'</div></div>';
  }
  window.addEventListener('error',function(event){ reportPanelError(state.tab,event.error||{message:event.message}) });
  window.addEventListener('unhandledrejection',function(event){ reportPanelError(state.tab,event.reason) });
  (function wire(){
    var tabs=document.querySelectorAll('[role=tab]');
    function bind(btn,index){
      btn.addEventListener('click',function(){ selectTab(btn.getAttribute('data-tab')) });
      btn.addEventListener('keydown',function(event){
        var delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0; if(!delta)return;
        event.preventDefault();
        var next=tabs[(index+delta+tabs.length)%tabs.length];
        next.focus(); selectTab(next.getAttribute('data-tab'));
      });
    }
    for(var i=0;i<tabs.length;i+=1)bind(tabs[i],i);
    document.getElementById('run').addEventListener('click',function(){ runQuery(1) });
    document.getElementById('prev').addEventListener('click',function(){ if(state.page>1)runQuery(state.page-1) });
    document.getElementById('next').addEventListener('click',function(){ if(state.hasMore)runQuery(state.page+1) });
    document.getElementById('export').addEventListener('click',exportCsv);
    document.getElementById('save-open').addEventListener('click',function(){
      document.getElementById('save-form').hidden=false; document.getElementById('save-name').focus();
    });
    document.getElementById('save').addEventListener('click',saveQuery);
    document.getElementById('db-select').addEventListener('change',function(event){ loadSchema(event.target.value) });
    document.getElementById('schema').addEventListener('click',function(event){
      var button=event.target.closest('button[data-table]'); if(!button)return;
      var name=button.getAttribute('data-table');
      document.getElementById('sql').value='SELECT * FROM "'+name.replace(/"/g,'""')+'" LIMIT 50';
      document.getElementById('sql').focus();
    });
    document.getElementById('saved-queries').addEventListener('click',function(event){
      var load=event.target.closest('button[data-load]');
      if(load){
        var id=load.getAttribute('data-load');
        api('/api/admin/console/saved-queries').then(function(data){
          var query=(data.queries||[]).filter(function(item){return item.id===id})[0];
          if(!query)return;
          state.databaseId=query.database_id;
          document.getElementById('db-select').value=query.database_id;
          document.getElementById('sql').value=query.sql_text;
          loadSchema(query.database_id); show('db-msg','Loaded '+query.name,'ok');
        },function(err){ show('db-msg',err.message,'err') });
        return;
      }
      var remove=event.target.closest('button[data-delete]');
      if(remove){
        if(!confirm('Delete this saved statement?'))return;
        api('/api/admin/console/saved-queries/'+encodeURIComponent(remove.getAttribute('data-delete')),'DELETE')
          .then(loadSaved,function(err){ show('db-msg',err.message,'err') });
      }
    });
    var search=document.getElementById('project-search');
    search.addEventListener('input',function(){ if(state.registry)renderProjects(state.registry,search.value) });
    document.getElementById('logout').addEventListener('click',function(){ api('/api/auth/logout','POST',{}).then(signOut,signOut) });
    window.addEventListener('hashchange',function(){ selectTab((location.hash||'').replace('#',''),false) });
  })();
  api('/api/auth/me').then(function(data){
    document.getElementById('who').textContent='Signed in as '+data.user.email;
    if(!data.user.is_admin){ location.href='/account'; return }
    selectTab((location.hash||'').replace('#','')||'overview');
  },signOut);
})();
`;

export function consolePage(){
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'+CONSOLE_FAVICON+'\n<title>CFLab operations</title>\n<style>'+
    CONSOLE_STYLE+'</style>\n</head>\n<body>\n'+CONSOLE_BODY+'\n<script>'+SCRIPT+'</script>\n</body>\n</html>';
}

export const CONSOLE_SCRIPT = SCRIPT;

