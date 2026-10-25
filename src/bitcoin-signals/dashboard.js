// Bitcoin Signals dashboard page.
//
// A plain JavaScript client module (no bundler, no framework, no CDN) so the
// Worker can serve it inline and the Node dashboard tests can import the exact
// same HTML and script. Charts are small inline SVGs drawn from retained points:
// the primary Worker serves no static assets, so the vendored Chart.js copy used
// by the Analytics Worker is intentionally not loaded here.

const SIGNALS_STYLE = `
:root{color-scheme:light;--bg:#f6f7f9;--surface:#fff;--muted:#5f6b7a;--text:#1f2933;--border:#e4e7ec;--border-strong:#d0d5dd;--accent:#2563eb;--accent-hover:#1d4ed8;--accent-soft:#eff4ff;--success:#067647;--success-soft:#ecfdf3;--warning:#b54708;--warning-soft:#fffaeb;--danger:#b42318;--danger-soft:#fef3f2;--radius:8px;--shadow:0 1px 2px rgba(16,24,40,.05)}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1{font-size:22px;margin:0 0 4px;font-weight:650}h2{font-size:16px;margin:0 0 2px;font-weight:600}h3{font-size:14px;margin:0 0 8px;font-weight:600}p{margin:0 0 10px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.muted{color:var(--muted)}.lede{color:var(--muted);font-size:14px;margin:0}.hint{font-size:12.5px;color:var(--muted);margin:6px 0 0}
.app-header{background:var(--surface);border-bottom:1px solid var(--border)}
.app-header-inner{max-width:1180px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{font-weight:700;font-size:16px;color:var(--text)}
.nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tab{font:inherit;font-size:13.5px;font-weight:600;padding:7px 11px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer}
.tab[aria-selected=true]{background:var(--accent-soft);border-color:#c7d7fe;color:var(--accent-hover)}
.nav a{color:var(--muted);font-size:14px}
.container{max-width:1180px;margin:0 auto;padding:24px 20px 56px}
.page-head{margin-bottom:18px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-bottom:18px}
.panel-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px}
.panel-head p{margin:0;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{border:1px solid var(--border);border-radius:var(--radius);padding:14px;background:var(--surface)}
.card-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
.card-title{font-size:13px;font-weight:600;color:var(--muted)}
.value{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;word-break:break-word}
.unit{font-size:12px;color:var(--muted);margin-left:4px}
.delta{font-size:12.5px;font-variant-numeric:tabular-nums}
.delta.up{color:var(--success)}.delta.down{color:var(--danger)}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.6;border:1px solid var(--border);background:#f9fafb;color:var(--muted);white-space:nowrap}
.badge-warn{background:var(--warning-soft);border-color:#fedf89;color:var(--warning)}
.badge-ok{background:var(--success-soft);border-color:#abefc6;color:var(--success)}
.badge-bad{background:var(--danger-soft);border-color:#fecdca;color:var(--danger)}
.badge-measured{background:var(--accent-soft);border-color:#c7d7fe;color:var(--accent-hover)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.flags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.src{font-size:11.5px;color:var(--muted);margin-top:8px;word-break:break-word}
.spark{margin-top:10px;width:100%;height:46px;display:block}
.spark polyline{fill:none;stroke:var(--accent);stroke-width:1.6}
.spark .axis{stroke:var(--border);stroke-width:1}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kv-label{font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600}
.kv-value{font-size:14px;word-break:break-word}
.table-wrap{overflow-x:auto}
.table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:720px}
.table th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);font-weight:600;padding:8px;border-bottom:1px solid var(--border)}
.table td{padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top;font-variant-numeric:tabular-nums}
.num{text-align:right}
.field{margin-bottom:12px}
label{display:block;font-size:12.5px;font-weight:600;margin-bottom:5px}
input[type=text],input[type=email],input[type=number],input[type=date],select,textarea{width:100%;padding:8px 10px;font:inherit;font-size:13.5px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text)}
textarea{min-height:82px;resize:vertical}
.inline-form{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
.inline-form .field{margin-bottom:0;flex:1;min-width:130px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:8px 12px;font:inherit;font-size:13px;font-weight:600;border-radius:6px;border:1px solid transparent;cursor:pointer;background:var(--surface);color:var(--text)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{border-color:var(--border-strong)}.btn-secondary:hover{background:#f9fafb}
.btn-small{padding:5px 9px;font-size:12px}
.btn:disabled{opacity:.55;cursor:not-allowed}
.msg:empty{display:none}.msg{font-size:13px;margin-top:10px;padding:8px 10px;border-radius:6px}
.msg-ok{background:var(--success-soft);border:1px solid #abefc6;color:var(--success)}
.msg-err{background:var(--danger-soft);border:1px solid #fecdca;color:var(--danger)}
.evidence-item{border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px}
.evidence-date{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.evidence-title{font-weight:600;margin:2px 0 4px}
.evidence-summary{font-size:13.5px;margin:0 0 8px}
.row{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
.print-note{font-size:12px;color:var(--muted)}
.disclaimer{font-size:12.5px;color:var(--warning);background:var(--warning-soft);border:1px solid #fedf89;border-radius:6px;padding:10px}
@media (max-width:900px){.table{min-width:0}.table thead{display:none}.table,.table tbody,.table tr,.table td{display:block;width:100%}.table tr{border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:10px}.table td{border:none;padding:3px 0;text-align:left}.table td::before{content:attr(data-label);display:block;font-size:11px;text-transform:uppercase;color:var(--muted);font-weight:600}}
@media (max-width:640px){.container{padding:18px 14px 44px}.app-header-inner{padding:10px 14px}.nav{width:100%;justify-content:space-between}.inline-form .field{flex:1 1 100%}.inline-form .btn{width:100%}}
`;

const SHELL = `<header class="app-header"><div class="app-header-inner">
<a class="brand" href="/account">CFLab</a>
<nav class="nav" aria-label="Sections">
<button class="tab" type="button" id="tab-radar" data-tab="radar" aria-selected="true">Radar</button>
<button class="tab" type="button" id="tab-arbitrage" data-tab="arbitrage" aria-selected="false">Arbitrage</button>
<button class="tab" type="button" id="tab-evidence" data-tab="evidence" aria-selected="false">Evidence</button>
<button class="tab" type="button" id="tab-settings" data-tab="settings" aria-selected="false">Settings</button>
<a id="nav-admin" href="/admin/users" hidden>Admin</a>
<button id="logout" class="btn btn-secondary btn-small" type="button">Log out</button>
</nav></div></header>`;

const BODY = `<main class="container">
<div class="page-head"><h1>Bitcoin Signals</h1><p class="lede">Is bitcoin becoming money that businesses, governments, and individuals hold and use, or another rail for moving fiat? Every figure here is a retained measurement with its own source, unit, and timestamp.</p></div>
<div id="msg" class="msg" role="status" aria-live="polite"></div>
<section id="panel-radar" aria-labelledby="tab-radar">
  <div class="panel"><div class="panel-head"><div><h2>Radar</h2><p>Current measurements, retained history, freshness, and source evidence.</p></div><button class="btn btn-secondary btn-small" type="button" id="refresh-radar">Reload</button></div><div id="radar-flags" class="flags"></div><div id="radar-grid" class="grid" aria-busy="true"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Hypotheses</h2><p>Evidence counts only. There is no composite score.</p></div></div><div id="hypotheses" class="grid"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Curated-only coverage</h2><p>Retention, sovereign settlement, and regulation cannot be machine-measured; they are human-curated, attributed entries.</p></div></div><div id="curated" class="kv"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Recent alerts</h2><p>Deterministic thresholds from stored data. Notifications are off unless an administrator enables them.</p></div></div><div id="radar-alerts"><p class="muted">Loading...</p></div></div>
</section>
<section id="panel-arbitrage" hidden aria-labelledby="tab-arbitrage">
  <div class="panel"><div class="panel-head"><div><h2>Funding and basis</h2><p>Perpetual funding normalized to 8 hours, with fee- and slippage-adjusted indicative carry.</p></div></div>
    <form id="assumptions-form" class="inline-form">
      <div class="field"><label for="fee-bps">Fee bps per leg</label><input id="fee-bps" type="number" min="0" max="500" step="1"></div>
      <div class="field"><label for="slippage-bps">Slippage bps per leg</label><input id="slippage-bps" type="number" min="0" max="500" step="1"></div>
      <div class="field"><label for="legs">Legs (round trip)</label><input id="legs" type="number" min="1" max="8" step="1"></div>
      <div class="field"><label for="holding-days">Holding days</label><input id="holding-days" type="number" min="1" max="365" step="1"></div>
      <button class="btn btn-primary" type="submit">Recalculate</button>
    </form>
    <div id="arb-msg" class="msg" role="status" aria-live="polite"></div>
    <div id="arb-summary" class="kv" style="margin-top:14px"></div>
  </div>
  <div class="panel"><div class="panel-head"><div><h2>Venues</h2><p>Cross-venue comparison. Stale quotes are shown but excluded from the ranking.</p></div></div><div id="arb-venues" class="table-wrap"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Dated-futures basis</h2><p>Premium over the same venue index, annualized to expiry, net of the stated costs.</p></div></div><div id="arb-basis" class="table-wrap"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Historical persistence</h2><p>Measured from retained history. “Settled” uses realized funding; “sampled” uses collected current funding.</p></div></div><div id="arb-persistence" class="table-wrap"><p class="muted">Loading...</p></div></div>
  <p id="arb-disclaimer" class="disclaimer"></p>
</section>
<section id="panel-evidence" hidden aria-labelledby="tab-evidence">
  <div class="panel"><div class="panel-head"><div><h2>Evidence timeline</h2><p>Sourced developments, supporting and contradictory findings, and human review status.</p></div></div>
    <form id="evidence-search" class="inline-form">
      <div class="field" style="flex:2"><label for="evidence-q">Search</label><input id="evidence-q" type="text" maxlength="100" placeholder="title, summary, or source"></div>
      <div class="field"><label for="evidence-kind">Kind</label><select id="evidence-kind"><option value="">Any</option><option value="treasury">Treasury</option><option value="retention">Retention</option><option value="lightning">Lightning</option><option value="settlement">Settlement</option><option value="regulation">Regulation</option><option value="market">Market</option><option value="contradiction">Contradiction</option></select></div>
      <div class="field"><label for="evidence-status">Stage</label><select id="evidence-status"><option value="">Any</option><option value="proposed">Proposed</option><option value="authorized">Authorized</option><option value="pilot">Pilot</option><option value="effective">Effective</option><option value="activity">Activity</option><option value="market">Market</option></select></div>
      <div class="field"><label for="evidence-review">Review</label><select id="evidence-review"><option value="">Any</option><option value="unreviewed">Unreviewed</option><option value="verified">Verified</option><option value="rejected">Rejected</option></select></div>
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
  </div>
  <div class="panel"><div class="panel-head"><div><h2>Entries</h2><p id="evidence-count">Loading...</p></div></div><div id="evidence-list"><p class="muted">Loading...</p></div></div>
  <div class="panel" id="evidence-create-panel" hidden><div class="panel-head"><div><h2>Add curated evidence</h2><p>Record an attributed public source. Nothing is machine-measured, and a repeat is rejected.</p></div></div>
    <form id="evidence-form">
      <div class="inline-form">
        <div class="field"><label for="ev-kind">Kind</label><select id="ev-kind" required><option value="treasury">Treasury</option><option value="retention">Retention</option><option value="lightning">Lightning</option><option value="settlement">Settlement</option><option value="regulation">Regulation</option><option value="market">Market</option><option value="contradiction">Contradiction</option></select></div>
        <div class="field"><label for="ev-status">Stage</label><select id="ev-status"><option value="proposed">Proposed</option><option value="authorized">Authorized</option><option value="pilot">Pilot</option><option value="effective">Effective</option><option value="activity">Activity</option><option value="market">Market</option></select></div>
        <div class="field"><label for="ev-direction">Direction</label><select id="ev-direction"><option value="supports">Supports</option><option value="contradicts">Contradicts</option><option value="mixed">Mixed</option></select></div>
        <div class="field"><label for="ev-importance">Importance</label><select id="ev-importance"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div>
        <div class="field"><label for="ev-date">Occurred (UTC)</label><input id="ev-date" type="date" required></div>
      </div>
      <div class="field"><label for="ev-title">Title</label><input id="ev-title" type="text" maxlength="200" required></div>
      <div class="field"><label for="ev-summary">Summary</label><textarea id="ev-summary" maxlength="4000" required></textarea></div>
      <div class="inline-form">
        <div class="field"><label for="ev-source-title">Source title</label><input id="ev-source-title" type="text" maxlength="200" required></div>
        <div class="field" style="flex:2"><label for="ev-source-url">Source URL (HTTPS)</label><input id="ev-source-url" type="text" maxlength="2000" required></div>
        <div class="field"><label for="ev-jurisdiction">Jurisdiction</label><input id="ev-jurisdiction" type="text" maxlength="60"></div>
      </div>
      <div class="field"><label for="ev-hypotheses">Hypotheses (comma-separated ids)</label><input id="ev-hypotheses" type="text" placeholder="treasury-demand, carry-persistence"><p class="hint">Effects default to the entry direction.</p></div>
      <button class="btn btn-primary" type="submit">Add evidence</button>
      <div id="ev-msg" class="msg" role="status" aria-live="polite"></div>
    </form>
  </div>
</section>
<section id="panel-settings" hidden aria-labelledby="tab-settings">
  <div class="panel"><div class="panel-head"><div><h2>Project storage</h2><p>Identity and permissions live in the primary database; project data lives in its own database.</p></div></div><div id="settings-storage" class="kv"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Collection health</h2><p>Scheduled collection runs without a browser. Sources fail in isolation.</p></div></div><div id="settings-collection"><p class="muted">Loading...</p></div></div>
  <div class="panel"><div class="panel-head"><div><h2>Alerts</h2><p>Deterministic thresholds. Email notifications stay off until enabled here.</p></div></div><form id="alerts-form"><div class="inline-form"><div class="field"><label for="alerts-enabled">Email notifications</label><select id="alerts-enabled"><option value="false">Off</option><option value="true">On</option></select></div><div class="field" style="flex:2"><label for="alerts-email">Recipient</label><input id="alerts-email" type="email" maxlength="254"></div><div class="field"><label for="funding-threshold">Funding threshold (bps/8h)</label><input id="funding-threshold" type="number" min="0" max="1000" step="0.5"></div><div class="field"><label for="funding-periods">Sustained samples</label><input id="funding-periods" type="number" min="1" max="168" step="1"></div></div><div class="inline-form" style="margin-top:10px"><div class="field"><label for="treasury-pct">Treasury change (% )</label><input id="treasury-pct" type="number" min="0.1" max="100" step="0.1"></div><div class="field"><label for="treasury-btc">Treasury change (BTC)</label><input id="treasury-btc" type="number" min="1" max="1000000" step="1"></div><div class="field"><label for="stale-multiplier">Stale source multiplier</label><input id="stale-multiplier" type="number" min="1" max="24" step="1"></div><div class="field"><label for="error-streak">Failure streak</label><input id="error-streak" type="number" min="1" max="50" step="1"></div></div><button class="btn btn-primary" type="submit" style="margin-top:12px">Save alert settings</button><div id="settings-msg" class="msg" role="status" aria-live="polite"></div></form></div>
  <div class="panel"><div class="panel-head"><div><h2>Backup status</h2><p>Recorded from the read-only backup verification. The Worker cannot read the backup bucket itself.</p></div></div><div id="settings-backup" class="kv"><p class="muted">Loading...</p></div><form id="backup-form" class="field" style="margin-top:14px"><label for="backup-report">Paste the JSON from node scripts/backup/backup-status.mjs --json</label><textarea id="backup-report" style="min-height:110px" placeholder='{"ok":true,"max_age_hours":30,"report":[...]}'></textarea><button class="btn btn-secondary" type="submit" style="margin-top:10px">Record attestation</button><div id="backup-msg" class="msg" role="status" aria-live="polite"></div></form></div>
  <div class="panel"><div class="panel-head"><div><h2>Administration</h2><p>Manual refresh is administrator-only and limited to four runs per hour.</p></div></div><div class="chips"><button class="btn btn-secondary" type="button" id="refresh-hourly">Refresh market data</button><button class="btn btn-secondary" type="button" id="refresh-daily">Refresh daily data</button><a class="btn btn-secondary" href="/api/bitcoin-signals/export?dataset=observations">Export observations CSV</a><a class="btn btn-secondary" href="/api/bitcoin-signals/export?dataset=evidence">Export evidence CSV</a></div><div id="refresh-msg" class="msg" role="status" aria-live="polite"></div></div>
  <p class="print-note">Automatic sources: OKX and Kraken public market data, Coinbase Exchange for personal research, and mempool.space for reported public-network statistics, not payment volume. <a href="https://www.coingecko.com/en/api" rel="noreferrer noopener" target="_blank">Powered by CoinGecko</a>. Treasury figures are reported public-company holdings. Deribit is disabled for US residency; Settings lists each source's status.</p>
</section>
</main>`;

export function signalsPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Bitcoin Signals - CFLab</title><style>' + SIGNALS_STYLE + '</style></head><body>'
    + SHELL + BODY + '<script>' + SIGNALS_SCRIPT + '</script></body></html>';
}

export const SIGNALS_SCRIPT = `
var SESSION_KEY='cflab_session';
var state={caller:null,radar:null,arbitrage:null,evidence:null,settings:null};
function sessionToken(){return sessionStorage.getItem(SESSION_KEY)}
function setSession(t){if(t)sessionStorage.setItem(SESSION_KEY,t);else sessionStorage.removeItem(SESSION_KEY)}
function esc(s){return String(s===null||s===undefined?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(path,method,body){var headers={};if(body!==undefined)headers['Content-Type']='application/json';var t=sessionToken();if(t)headers['Authorization']='Bearer '+t;return fetch(path,{method:method||'GET',headers:headers,body:body===undefined?undefined:JSON.stringify(body)}).then(function(res){if(res.status===401){setSession(null);location.href='/admin/login';throw new Error('Session expired')}return res.json().catch(function(){return null}).then(function(data){if(!res.ok){var e=new Error((data&&data.error&&data.error.message)||('HTTP '+res.status));e.status=res.status;e.code=data&&data.error&&data.error.code;throw e}return data})})}
function show(id,text,kind){var el=document.getElementById(id);if(!el)return;el.textContent=text||'';el.className='msg'+(kind==='err'?' msg-err':kind==='ok'?' msg-ok':'')}
function fmt(v,d){if(v===null||v===undefined||typeof v!=='number'||!isFinite(v))return '—';return v.toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:d===undefined?2:d})}
function signed(v,d){if(v===null||v===undefined||typeof v!=='number'||!isFinite(v))return '—';var s=fmt(v,d);return v>0?'+'+s:s}
function when(iso){if(!iso)return '—';var t=Date.parse(iso);if(isNaN(t))return '—';return new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC'}
function age(hours){if(hours===null||hours===undefined||!isFinite(hours))return 'unknown age';return fmt(hours,1)+'h ago'}
function badge(text,kind){return '<span class="badge'+(kind?' badge-'+kind:'')+'">'+esc(text)+'</span>'}
function sparkline(points){
  if(!points||points.length<2)return '<p class="hint">History is still accumulating.</p>';
  var values=points.map(function(p){return p.value});
  var min=Math.min.apply(null,values),max=Math.max.apply(null,values);
  var span=max-min;if(!span)span=Math.abs(max)||1;
  var w=280,h=46,step=w/(points.length-1),coords=[];
  for(var i=0;i<points.length;i+=1){var x=(i*step).toFixed(1);var y=(h-2-((points[i].value-min)/span)*(h-4)).toFixed(1);coords.push(x+','+y)}
  return '<svg class="spark" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="Retained history"><title>Retained history: '+points.length+' observations</title><line class="axis" x1="0" y1="'+(h-1)+'" x2="'+w+'" y2="'+(h-1)+'"></line><polyline points="'+coords.join(' ')+'"></polyline></svg>';
}
function initNav(caller){
  var a=document.getElementById('nav-admin');if(a&&caller&&caller.is_admin)a.hidden=false;
  var settingsTab=document.querySelector('.tab[data-tab=settings]');if(settingsTab&&caller&&!caller.is_admin)settingsTab.title='Administrator access required';
  var create=document.getElementById('evidence-create-panel');if(create&&caller&&caller.access==='write')create.hidden=false;
}
function wireLogout(){var b=document.getElementById('logout');if(!b)return;b.addEventListener('click',function(){api('/api/auth/logout','POST',{}).then(function(){setSession(null);location.href='/admin/login'},function(){setSession(null);location.href='/admin/login'})})}
function indicatorCard(item){
  var stale=item.stale?badge('stale','warn'):badge('fresh','ok');
  var tier=badge(item.tier,item.tier==='measured'?'measured':item.tier==='curated'?'warn':'');
  var delta='';
  if(item.change_7d_pct!==null&&item.change_7d_pct!==undefined){var cls=item.change_7d_pct>=0?'up':'down';delta='<div class="delta '+cls+'">'+signed(item.change_7d_pct,2)+'% vs ~7d</div>'}
  var points=item.points?sparkline(item.points):'';
  var interval=item.meta&&item.meta.interval_hours?'<div class="hint">Source interval '+esc(item.meta.interval_hours)+'h, normalized to 8h</div>':'';
  return '<article class="card"><div class="card-head"><div class="card-title">'+esc(item.label)+' · '+esc(item.venue)+'</div><div class="chips">'+tier+stale+'</div></div>'
    +'<div class="value">'+fmt(item.value,item.unit.indexOf('fraction')===0?6:2)+'<span class="unit">'+esc(item.unit)+'</span></div>'+delta
    +'<div class="flags">'+badge('observed '+when(item.observed_at))+badge('retrieved '+when(item.retrieved_at))+'</div>'
    +points+interval
    +'<div class="src">Source: <a href="'+esc(item.source_url)+'" rel="noreferrer noopener" target="_blank">'+esc(item.source_id)+'</a> · '+esc(item.definition)+'</div></article>';
}
function renderRadar(data){
  state.radar=data;state.caller=data.caller||state.caller;initNav(state.caller);
  var grid=document.getElementById('radar-grid');grid.setAttribute('aria-busy','false');
  grid.innerHTML=data.indicators.length?data.indicators.map(indicatorCard).join(''):'<p class="muted">No observations yet. The hourly collection starts on its own schedule; an administrator can run it from Settings.</p>';
  var flags=[];
  var collection=data.collection||{};
  (collection.last_runs||[]).forEach(function(run){flags.push(badge(run.job+' '+run.status+(run.detail?' · '+run.detail:''),run.status==='ok'?'ok':run.status==='failed'?'bad':'warn'))});
  if(collection.failing_sources)flags.push(badge(collection.failing_sources+' failing source(s)','bad'));
  if(collection.stale_sources)flags.push(badge(collection.stale_sources+' stale source(s)','warn'));
  if((data.alerts||[]).length)flags.push(badge(data.alerts.length+' open alert(s)','warn'));
  flags.push(badge('generated '+when(data.generated_at)));
  document.getElementById('radar-flags').innerHTML=flags.join('');
  var hyps=document.getElementById('hypotheses');
  hyps.innerHTML=(data.hypotheses||[]).map(function(h){return '<article class="card"><h3>'+esc(h.title)+'</h3><p class="hint">'+esc(h.question)+'</p><div class="flags">'+badge('supports '+h.evidence.supports,'ok')+badge('contradicts '+h.evidence.contradicts,'bad')+badge('mixed '+h.evidence.mixed)+badge('verified '+h.evidence.verified)+badge(h.evidence.total+' entries')+'</div><div class="hint">Last evidence: '+when(h.evidence.last_at)+'</div></article>'}).join('');
  var curated=document.getElementById('curated');
  var kinds=['retention','settlement','regulation'];
  curated.innerHTML=kinds.map(function(kind){var found=(data.curated||[]).filter(function(c){return c.kind===kind})[0];return '<div><div class="kv-label">'+esc(kind)+'</div><div class="kv-value">'+(found?fmt(found.entries,0)+' entries · last '+when(found.last_at):'No curated entries yet')+'</div></div>'}).join('');
  var alerts=document.getElementById('radar-alerts');
  alerts.innerHTML=(data.alerts||[]).length?('<div class="table-wrap"><table class="table"><thead><tr><th>Severity</th><th>Alert</th><th>Detail</th><th>Created</th></tr></thead><tbody>'+data.alerts.map(function(a){return '<tr><td data-label="Severity">'+badge(a.severity,a.severity==='critical'?'bad':a.severity==='warning'?'warn':'')+'</td><td data-label="Alert">'+esc(a.title)+'</td><td data-label="Detail">'+esc(a.detail)+'</td><td data-label="Created">'+when(a.created_at)+'</td></tr>'}).join('')+'</tbody></table></div>'):'<p class="muted">No open alerts.</p>';
}
function loadRadar(){return api('/api/bitcoin-signals/radar').then(function(data){renderRadar(data);return data},function(err){show('msg','Could not load the radar: '+err.message,'err')})}
function renderArbitrage(data){
  state.arbitrage=data;
  var a=data.assumptions||{};
  document.getElementById('fee-bps').value=a.feeBpsPerLeg;
  document.getElementById('slippage-bps').value=a.slippageBpsPerLeg;
  document.getElementById('legs').value=a.legs;
  document.getElementById('holding-days').value=a.holdingDays;
  var summary=[];
  summary.push('<div><div class="kv-label">Best net funding carry</div><div class="kv-value">'+(data.best_funding?esc(data.best_funding.venue)+' · '+signed(data.best_funding.net_apr_pct,2)+'% APR':'No fresh eligible venue')+'</div></div>');
  summary.push('<div><div class="kv-label">Best net basis</div><div class="kv-value">'+(data.best_basis?esc(data.best_basis.instrument)+' · '+signed(data.best_basis.net_annualized_pct,2)+'% annualized':'No fresh eligible contract')+'</div></div>');
  summary.push('<div><div class="kv-label">Cost assumption</div><div class="kv-value">'+fmt(a.feeBpsPerLeg+a.slippageBpsPerLeg,1)+' bps × '+fmt(a.legs,0)+' legs over '+fmt(a.holdingDays,0)+' days</div></div>');
  summary.push('<div><div class="kv-label">Generated</div><div class="kv-value">'+when(data.generated_at)+'</div></div>');
  if(data.assumption_note)summary.push('<div><div class="kv-label">Note</div><div class="kv-value">'+esc(data.assumption_note)+'</div></div>');
  document.getElementById('arb-summary').innerHTML=summary.join('');
  var venues=document.getElementById('arb-venues');
  venues.innerHTML=(data.venues||[]).length?('<table class="table"><thead><tr><th>Venue</th><th class="num">Funding /8h</th><th class="num">APR</th><th class="num">APY</th><th class="num">Costs (APR)</th><th class="num">Net APR</th><th class="num">Samples</th><th class="num">Positive</th><th>Status</th></tr></thead><tbody>'+data.venues.map(function(v){return '<tr><td data-label="Venue">'+esc(v.venue)+'<div class="hint">'+esc((v.limitations||[]).join(' '))+'</div></td><td data-label="Funding /8h" class="num">'+(v.funding_8h_pct===null?'—':fmt(v.funding_8h_pct,4)+'%')+'</td><td data-label="APR" class="num">'+(v.carry?signed(v.carry.gross_apr_pct,2)+'%':'—')+'</td><td data-label="APY" class="num">'+(v.carry&&v.carry.gross_apy_pct!==null?signed(v.carry.gross_apy_pct,2)+'%':'—')+'</td><td data-label="Costs (APR)" class="num">'+(v.carry?'-'+fmt(v.carry.cost_apr_pct,2)+'%':'—')+'</td><td data-label="Net APR" class="num">'+(v.carry?signed(v.carry.net_apr_pct,2)+'%':'—')+'</td><td data-label="Samples" class="num">'+fmt(v.persistence.samples,0)+'</td><td data-label="Positive" class="num">'+(v.persistence.positive_share===null?'—':fmt(v.persistence.positive_share*100,1)+'%')+'</td><td data-label="Status">'+(v.stale?badge('stale','warn'):badge('fresh','ok'))+'<div class="hint">'+esc(v.observed_at?when(v.observed_at):'no quote')+'</div></td></tr>'}).join('')+'</tbody></table>'):'<p class="muted">No funding observations collected yet. See Settings for source health.</p>';
  var basis=document.getElementById('arb-basis');
  basis.innerHTML=(data.basis||[]).length?('<table class="table"><thead><tr><th>Contract</th><th>Expiry</th><th class="num">Days</th><th class="num">Mark</th><th class="num">Index</th><th class="num">Basis</th><th class="num">Annualized</th><th class="num">Net</th></tr></thead><tbody>'+data.basis.map(function(b){return '<tr><td data-label="Contract">'+esc(b.venue)+'<div class="hint">'+esc(b.instrument)+'</div></td><td data-label="Expiry">'+when(b.expiry)+'</td><td data-label="Days" class="num">'+fmt(b.days_to_expiry,1)+'</td><td data-label="Mark" class="num">'+fmt(b.mark_usd,2)+'</td><td data-label="Index" class="num">'+fmt(b.index_usd,2)+'</td><td data-label="Basis" class="num">'+signed(b.basis_pct,3)+'%</td><td data-label="Annualized" class="num">'+signed(b.annualized_pct,2)+'%</td><td data-label="Net" class="num">'+signed(b.net_annualized_pct,2)+'%</td></tr>'}).join('')+'</tbody></table>'):'<p class="muted">No dated-futures quotes collected yet. See Settings for source health.</p>';
  var persistence=document.getElementById('arb-persistence');
  persistence.innerHTML=(data.venues||[]).length?('<table class="table"><thead><tr><th>Venue</th><th>Basis</th><th class="num">Samples</th><th class="num">Coverage</th><th class="num">Mean /8h</th><th class="num">Median /8h</th><th class="num">Positive</th><th class="num">Longest +run</th><th class="num">Sum</th></tr></thead><tbody>'+data.venues.map(function(v){var p=v.persistence;return '<tr><td data-label="Venue">'+esc(v.venue)+'</td><td data-label="Basis">'+badge(p.basis,p.basis==='settled'?'ok':'')+'</td><td data-label="Samples" class="num">'+fmt(p.samples,0)+'</td><td data-label="Coverage" class="num">'+fmt(p.coverage_hours,0)+'h</td><td data-label="Mean /8h" class="num">'+(p.mean_8h_pct===null?'—':fmt(p.mean_8h_pct,4)+'%')+'</td><td data-label="Median /8h" class="num">'+(p.median_8h_pct===null?'—':fmt(p.median_8h_pct,4)+'%')+'</td><td data-label="Positive" class="num">'+(p.positive_share===null?'—':fmt(p.positive_share*100,1)+'%')+'</td><td data-label="Longest +run" class="num">'+fmt(p.longest_positive_run,0)+'</td><td data-label="Sum" class="num">'+(p.cumulative_pct===null?'—':signed(p.cumulative_pct,3)+'%')+'</td></tr>'}).join('')+'</tbody></table>'):'<p class="muted">No funding history retained yet.</p>';
  document.getElementById('arb-disclaimer').textContent=data.disclaimer||'';
}
function arbitrageQuery(){
  var params=[];
  var map=[['fee-bps','fee_bps'],['slippage-bps','slippage_bps'],['legs','legs'],['holding-days','holding_days']];
  for(var i=0;i<map.length;i+=1){var el=document.getElementById(map[i][0]);if(el&&el.value!=='')params.push(map[i][1]+'='+encodeURIComponent(el.value))}
  return params.length?'?'+params.join('&'):'';
}
function loadArbitrage(){return api('/api/bitcoin-signals/arbitrage'+arbitrageQuery()).then(function(data){renderArbitrage(data);return data},function(err){show('arb-msg','Could not load the arbitrage view: '+err.message,'err')})}
function evidenceItem(item){
  var hypotheses=(item.hypotheses||[]).map(function(h){return badge(h.id+' · '+h.effect,h.effect==='supports'?'ok':h.effect==='contradicts'?'bad':'')}).join('');
  var review=badge(item.review_status,item.review_status==='verified'?'ok':item.review_status==='rejected'?'bad':'warn');
  var actions='';
  if(state.caller&&state.caller.access==='write'){
    actions='<div class="chips" style="margin-top:8px"><button class="btn btn-secondary btn-small" type="button" data-review="verified" data-id="'+esc(item.id)+'">Verify</button><button class="btn btn-secondary btn-small" type="button" data-review="rejected" data-id="'+esc(item.id)+'">Reject</button><button class="btn btn-secondary btn-small" type="button" data-review="unreviewed" data-id="'+esc(item.id)+'">Reset review</button></div>';
  }
  return '<article class="evidence-item"><div class="row"><span class="evidence-date">'+when(item.occurred_at)+'</span><div class="chips">'+badge(item.kind)+badge('stage: '+item.status)+badge(item.direction,item.direction==='supports'?'ok':item.direction==='contradicts'?'bad':'')+badge(item.importance)+review+'</div></div>'
    +'<div class="evidence-title">'+esc(item.title)+'</div><p class="evidence-summary">'+esc(item.summary)+'</p>'
    +'<div class="chips">'+hypotheses+'</div>'
    +'<div class="src">Source: <a href="'+esc(item.source_url)+'" rel="noreferrer noopener" target="_blank">'+esc(item.source_title)+'</a> · retrieved '+when(item.retrieved_at)+(item.jurisdiction?' · '+esc(item.jurisdiction):'')+'</div>'+actions+'</article>';
}
function renderEvidence(data){
  state.evidence=data;
  document.getElementById('evidence-count').textContent=fmt(data.total,0)+' entr'+(data.total===1?'y':'ies')+' · showing '+fmt((data.items||[]).length,0);
  document.getElementById('evidence-list').innerHTML=(data.items||[]).length?data.items.map(evidenceItem).join(''):'<p class="muted">No evidence matches. Curated entries for retention, settlement, and regulation are added by hand with a cited source.</p>';
}
function loadEvidence(){
  var params=[];
  var q=document.getElementById('evidence-q').value.trim();
  if(q)params.push('q='+encodeURIComponent(q));
  var kind=document.getElementById('evidence-kind').value;
  if(kind)params.push('kind='+encodeURIComponent(kind));
  var status=document.getElementById('evidence-status').value;
  if(status)params.push('status='+encodeURIComponent(status));
  var review=document.getElementById('evidence-review').value;
  if(review)params.push('review='+encodeURIComponent(review));
  return api('/api/bitcoin-signals/evidence'+(params.length?'?'+params.join('&'):'')).then(function(data){renderEvidence(data);return data},function(err){show('msg','Could not load evidence: '+err.message,'err')});
}
function renderSettings(data){
  state.settings=data;
  var p=data.project||{};var s=p.storage||{};
  document.getElementById('settings-storage').innerHTML='<div><div class="kv-label">Project</div><div class="kv-value">'+esc(p.name||'')+' ('+esc(p.app_id||'')+')</div></div>'
    +'<div><div class="kv-label">Storage backend</div><div class="kv-value">'+esc(s.backend||'')+' · binding '+esc(s.binding||'')+'</div></div>'
    +'<div><div class="kv-label">Migrations</div><div class="kv-value">'+esc(s.migrations_dir||'')+'</div></div>'
    +'<div><div class="kv-label">Reachable</div><div class="kv-value">'+(s.reachable?badge('yes','ok'):badge('no','bad'))+(s.error?' <span class="hint">'+esc(s.error)+'</span>':'')+'</div></div>'
    +'<div><div class="kv-label">Observations</div><div class="kv-value">'+fmt(data.data.observations,0)+'</div></div>'
    +'<div><div class="kv-label">Evidence entries</div><div class="kv-value">'+fmt(data.data.evidence,0)+'</div></div>';
  var collection=data.collection||{};
  var runs=(collection.last_runs||[]).map(function(run){return badge(run.job+' '+run.status+' · '+when(run.started_at)+' · '+fmt(run.observations_added,0)+' added',run.status==='ok'?'ok':run.status==='failed'?'bad':'warn')}).join('');
  var sources=(collection.sources||[]).map(function(src){return '<tr><td data-label="Source">'+esc(src.source_id)+'<div class="hint">'+esc(src.name)+'</div></td><td data-label="Cadence">'+esc(src.cadence)+'</td><td data-label="Tier">'+badge(src.tier)+'</td><td data-label="Last success">'+(src.last_ok_at?when(src.last_ok_at)+' ('+age(src.age_hours)+')':'never')+'</td><td data-label="State">'+(src.active===false?badge('disabled','warn')+'<div class="hint">'+esc(src.disabled_reason||'')+'</div>':src.healthy?badge('fresh','ok'):badge('stale','warn'))+'</td><td data-label="Last error">'+(src.last_error_code?esc(src.last_error_code)+' · '+when(src.last_error_at):'none')+'</td></tr>'}).join('');
  document.getElementById('settings-collection').innerHTML='<div class="flags">'+runs+'</div>'
    +((collection.sources||[]).length?'<div class="table-wrap" style="margin-top:12px"><table class="table"><thead><tr><th>Source</th><th>Cadence</th><th>Tier</th><th>Last success</th><th>State</th><th>Last error</th></tr></thead><tbody>'+sources+'</tbody></table></div>':'');
  var rules=data.settings.rules||{};var notifications=data.settings.notifications||{};
  document.getElementById('alerts-enabled').value=notifications.enabled?'true':'false';
  document.getElementById('alerts-email').value=notifications.email_to||'';
  document.getElementById('funding-threshold').value=rules.funding_threshold_bps_8h;
  document.getElementById('funding-periods').value=rules.funding_sustained_periods;
  document.getElementById('treasury-pct').value=rules.treasury_change_pct;
  document.getElementById('treasury-btc').value=rules.treasury_change_btc;
  document.getElementById('stale-multiplier').value=rules.stale_multiplier;
  document.getElementById('error-streak').value=rules.error_streak;
  var backup=data.backup||{};
  document.getElementById('settings-backup').innerHTML='<div><div class="kv-label">Status</div><div class="kv-value">'+(backup.recorded?(backup.ok?badge('verified fresh','ok'):badge('stale or missing','bad')):badge('not recorded','warn'))+'</div></div>'
    +'<div><div class="kv-label">Checked</div><div class="kv-value">'+(backup.checked_at?when(backup.checked_at)+' ('+age(backup.age_hours)+')':'never')+'</div></div>'
    +'<div><div class="kv-label">Freshness limit</div><div class="kv-value">'+fmt(backup.max_age_hours||(data.backups_expected&&data.backups_expected.max_age_hours),0)+'h</div></div>'
    +'<div><div class="kv-label">Databases</div><div class="kv-value">'+esc((data.backups_expected&&data.backups_expected.databases||[]).join(', '))+'</div></div>'
    +'<div><div class="kv-label">Detail</div><div class="kv-value">'+esc(backup.note||'')+'</div></div>';
}
function loadSettings(){
  if(!state.caller||!state.caller.is_admin){document.getElementById('settings-collection').innerHTML='<p class="muted">Administrator access is required for collection health, alerts, backups, and manual refresh.</p>';return Promise.resolve(null)}
  return api('/api/bitcoin-signals/settings').then(function(data){renderSettings(data.status||{});return data},function(err){show('settings-msg','Could not load settings: '+err.message,'err')});
}
function selectTab(name){
  if(['radar','arbitrage','evidence','settings'].indexOf(name)<0)name='radar';
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i+=1){var t=tabs[i];t.setAttribute('aria-selected',t.getAttribute('data-tab')===name?'true':'false')}
  var panels=['radar','arbitrage','evidence','settings'];
  for(var j=0;j<panels.length;j+=1){var el=document.getElementById('panel-'+panels[j]);if(el)el.hidden=panels[j]!==name}
  try{history.replaceState(null,'','#'+name)}catch(e){}
  if(name==='arbitrage'&&!state.arbitrage)loadArbitrage();
  if(name==='evidence'&&!state.evidence)loadEvidence();
  if(name==='settings')loadSettings();
}
function download(url){
  var t=sessionToken();
  fetch(url,{headers:{Authorization:'Bearer '+t}}).then(function(res){if(!res.ok)throw new Error('HTTP '+res.status);return res.blob()}).then(function(blob){
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download=url.indexOf('evidence')>-1?'bitcoin-signals-evidence.csv':'bitcoin-signals-observations.csv';
    document.body.appendChild(a);a.click();a.remove();
  }).catch(function(err){show('settings-msg','Export failed: '+err.message,'err')});
}
function wire(){
  wireLogout();
  var tabs=document.querySelectorAll('.tab');
  for(var i=0;i<tabs.length;i+=1){(function(tab){tab.addEventListener('click',function(){selectTab(tab.getAttribute('data-tab'))})})(tabs[i])}
  document.getElementById('assumptions-form').addEventListener('submit',function(e){e.preventDefault();loadArbitrage()});
  document.getElementById('evidence-search').addEventListener('submit',function(e){e.preventDefault();loadEvidence()});
  document.getElementById('refresh-radar').addEventListener('click',function(){loadRadar()});
  document.getElementById('evidence-list').addEventListener('click',function(e){
    var button=e.target.closest('button[data-review]');if(!button)return;
    api('/api/bitcoin-signals/evidence/'+encodeURIComponent(button.getAttribute('data-id')),'PATCH',{review_status:button.getAttribute('data-review')}).then(function(){show('msg','Review recorded','ok');return Promise.all([loadEvidence(),loadRadar()])},function(err){show('msg','Could not record review: '+err.message,'err')});
  });
  document.getElementById('evidence-form').addEventListener('submit',function(e){
    e.preventDefault();
    var hypotheses=document.getElementById('ev-hypotheses').value.split(',').map(function(v){return v.trim()}).filter(Boolean).map(function(id){return {id:id,effect:document.getElementById('ev-direction').value}});
    var date=document.getElementById('ev-date').value;
    api('/api/bitcoin-signals/evidence','POST',{
      kind:document.getElementById('ev-kind').value,status:document.getElementById('ev-status').value,
      direction:document.getElementById('ev-direction').value,importance:document.getElementById('ev-importance').value,
      occurred_at:date?date+'T00:00:00.000Z':new Date().toISOString(),
      title:document.getElementById('ev-title').value,summary:document.getElementById('ev-summary').value,
      source_title:document.getElementById('ev-source-title').value,source_url:document.getElementById('ev-source-url').value,
      jurisdiction:document.getElementById('ev-jurisdiction').value||null,hypotheses:hypotheses
    }).then(function(){show('ev-msg','Evidence recorded','ok');document.getElementById('evidence-form').reset();return Promise.all([loadEvidence(),loadRadar()])},function(err){show('ev-msg','Could not add evidence: '+err.message,'err')});
  });
  document.getElementById('alerts-form').addEventListener('submit',function(e){
    e.preventDefault();
    api('/api/bitcoin-signals/settings','PATCH',{
      notifications:{enabled:document.getElementById('alerts-enabled').value==='true',email_to:document.getElementById('alerts-email').value.trim()},
      rules:{funding_threshold_bps_8h:Number(document.getElementById('funding-threshold').value),funding_sustained_periods:Number(document.getElementById('funding-periods').value),funding_window_hours:48,treasury_change_pct:Number(document.getElementById('treasury-pct').value),treasury_change_btc:Number(document.getElementById('treasury-btc').value),stale_multiplier:Number(document.getElementById('stale-multiplier').value),error_streak:Number(document.getElementById('error-streak').value)}
    }).then(function(){show('settings-msg','Alert settings saved','ok');return loadSettings()},function(err){show('settings-msg','Could not save: '+err.message,'err')});
  });
  document.getElementById('backup-form').addEventListener('submit',function(e){
    e.preventDefault();
    var raw=document.getElementById('backup-report').value.trim();
    var parsed;try{parsed=JSON.parse(raw)}catch(err){show('backup-msg','That is not valid JSON','err');return}
    api('/api/bitcoin-signals/backup-attestation','POST',parsed).then(function(result){show('backup-msg',result.ok?'Backup verification recorded: all three databases fresh':'Recorded, but at least one database is not fresh','ok');return loadSettings()},function(err){show('backup-msg','Could not record: '+err.message,'err')});
  });
  document.getElementById('refresh-hourly').addEventListener('click',function(){refresh('hourly')});
  document.getElementById('refresh-daily').addEventListener('click',function(){refresh('daily')});
  var exportLinks=document.querySelectorAll('a[href^="/api/bitcoin-signals/export"]');
  for(var k=0;k<exportLinks.length;k+=1){(function(link){link.addEventListener('click',function(e){e.preventDefault();download(link.getAttribute('href'))})})(exportLinks[k])}
}
function refresh(scope){
  show('refresh-msg','Collecting...','');
  api('/api/bitcoin-signals/refresh','POST',{scope:scope}).then(function(result){
    var runs=result.runs||[];
    var text=runs.map(function(run){return run.job+': '+run.status+(run.reason?' ('+run.reason+')':'')+' · '+fmt(run.observations_added,0)+' new observation(s) from '+fmt(run.sources.length,0)+' source(s)'}).join(' · ');
    show('refresh-msg',text||'No collection ran','ok');
    return Promise.all([loadRadar(),loadSettings()]);
  },function(err){show('refresh-msg','Collection failed: '+err.message,'err')});
}
wire();
loadRadar().then(function(data){
  var initial=(location.hash||'#radar').slice(1);
  selectTab(initial);
  if(data&&data.alerts&&data.alerts.length)show('msg',data.alerts.length+' open alert(s)','');
});
`;
