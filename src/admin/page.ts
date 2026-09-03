import { adminConfig } from './auth.js';
import { agentIdentity } from '../../config/agent.js';

/**
 * The panel itself: one file, no build step, no external anything.
 *
 * Everything is inline for the same reason the public landing page is — a
 * page that fetches a script from a CDN hands whoever controls that CDN the
 * ability to run code inside the one browser tab that can launch a token.
 */

export function adminPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${agentIdentity.name} — operator</title>
<style>${styles()}</style>
</head>
<body>
<header>
  <div class="bar">
    <div class="brand"><span class="dot"></span> ${agentIdentity.name} <small>operator panel</small></div>
    <span class="pill" id="who" hidden></span>
    <button id="connect">Connect wallet</button>
    <button id="signin" disabled>Sign in</button>
    <button id="signout" hidden>Sign out</button>
  </div>
</header>
<main>
  <div class="note" id="gate">
    Not signed in. This panel holds the wallet-scoped Bankr key; the public API
    process does not. Sign in with an address in <code>ADMIN_ADDRESSES</code>
    (${adminConfig.owners.length} configured).
  </div>

  <div id="panel" hidden>
    <h2>Agent wallet</h2>
    <div class="panel" id="wallet">…</div>

    <h2>LLM spend <span class="sub">last 30 days, gateway key</span></h2>
    <div class="panel" id="llm">…</div>

    <h2>Key scope</h2>
    <p class="lede">Asks Bankr what each key can actually do, rather than trusting the dashboard toggles to still be what you set.</p>
    <div class="panel"><button id="scopebtn">Check both keys</button><div id="scope"></div></div>

    <h2>Approval queue</h2>
    <div class="panel" id="queue">…</div>

    <h2>Launch a token</h2>
    <p class="lede">
      Defaults to Robinhood Chain — the chain this service indexes, so the pool
      appears in our own index. Simulating costs no gas and no quota slot; a
      real deploy is irreversible and one of three per rolling 24 hours.
    </p>
    <div class="panel">
      <div class="row">
        <input type="text" id="tname" placeholder="Token name">
        <input type="text" id="tsym" placeholder="SYMBOL" maxlength="20">
      </div>
      <div class="row">
        <input type="text" id="tfee" placeholder="Fee recipient (optional, defaults to the agent wallet)">
        <select id="tchain"><option value="robinhood">Robinhood Chain</option><option value="base">Base</option></select>
      </div>
      <div class="row">
        <button id="simulate" class="primary">Simulate</button>
        <input type="text" id="tconfirm" placeholder="type LAUNCH SYMBOL to deploy for real">
        <button id="deploy" class="danger">Deploy</button>
      </div>
      <div id="launchout"></div>
    </div>

    <h2>Recent Bankr launches</h2>
    <div class="panel" id="launches">…</div>
  </div>
</main>
<script>${script()}</script>
</body>
</html>`;
}

function styles(): string {
  return `
:root{--bg:#fafaf9;--panel:#fff;--fg:#18181b;--dim:#71717a;--line:#e4e4e7;
--acc:#15803d;--danger:#b91c1c;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0e;--panel:#161619;--fg:#e9e9e7;
--dim:#a1a1aa;--line:#27272a;--acc:#4ade80;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);z-index:10}
.bar{max-width:900px;margin:0 auto;padding:11px 20px;display:flex;align-items:center;gap:10px}
.brand{font-weight:600;margin-right:auto;display:flex;align-items:center;gap:8px}
.brand small{color:var(--dim);font-weight:400}
.dot{width:9px;height:9px;border-radius:50%;background:var(--acc)}
main{max-width:900px;margin:0 auto;padding:28px 20px 80px}
h2{font-size:1.05rem;margin:34px 0 6px}
.sub{color:var(--dim);font-weight:400;font-size:.8rem}
.lede{color:var(--dim);font-size:.9rem;margin:0 0 12px;max-width:70ch}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);
background:var(--panel);color:var(--fg);padding:8px 14px;font-size:.87rem}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button.danger{border-color:var(--danger);color:var(--danger)}
button[disabled]{opacity:.45;cursor:not-allowed}
.pill{font-size:.78rem;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:4px 11px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 6px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
input[type=text],select{flex:1;min-width:170px;padding:10px 12px;font:inherit;color:var(--fg);
background:var(--bg);border:1px solid var(--line);border-radius:8px}
pre{font-family:var(--mono);font-size:.8rem;white-space:pre-wrap;word-break:break-word;margin:10px 0 0;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:.87rem}
td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
code{font-family:var(--mono);font-size:.84em}
.note{border-left:2px solid var(--line);padding-left:15px;color:var(--dim);margin:10px 0 0}
.err{color:var(--danger)}
.ok{color:var(--acc)}
`;
}

function script(): string {
  return `
(function(){
  var account = null;
  function $(id){return document.getElementById(id);}
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return '&#'+c.charCodeAt(0)+';';});}
  function j(v){return '<pre>'+esc(JSON.stringify(v,null,2))+'</pre>';}
  async function api(path, opts){
    var r = await fetch(path, Object.assign({headers:{'content-type':'application/json'}}, opts||{}));
    var body = await r.json().catch(function(){return {error:'unparseable response'};});
    return {status:r.status, body:body};
  }

  async function refreshMe(){
    var me = await api('/admin/me');
    var signedIn = me.body && me.body.signedIn && me.body.owner;
    $('panel').hidden = !signedIn;
    $('gate').hidden = !!signedIn;
    $('signout').hidden = !signedIn;
    if (signedIn){
      $('who').hidden = false;
      $('who').textContent = me.body.address.slice(0,6)+'…'+me.body.address.slice(-4)+' · owner';
      loadAll();
    }
  }

  $('connect').onclick = async function(){
    if (!window.ethereum){ alert('No injected wallet in this browser.'); return; }
    var a = await window.ethereum.request({method:'eth_requestAccounts'});
    account = a[0];
    $('connect').textContent = account.slice(0,6)+'…'+account.slice(-4);
    $('signin').disabled = false;
  };

  $('signin').onclick = async function(){
    if (!account) return;
    var n = await api('/admin/nonce?address='+encodeURIComponent(account));
    if (!n.body || !n.body.message){ alert('sign-in is not configured on this server'); return; }
    var sig;
    try {
      sig = await window.ethereum.request({method:'personal_sign', params:[n.body.message, account]});
    } catch(e){ return; }
    var v = await api('/admin/verify', {method:'POST', body: JSON.stringify({address:account, signature:sig, nonce:n.body.nonce})});
    if (v.status !== 200){ alert(v.body.error || 'sign-in rejected'); return; }
    refreshMe();
  };

  $('signout').onclick = async function(){
    await api('/admin/logout', {method:'POST'});
    location.reload();
  };

  async function section(id, path, render){
    var r = await api(path);
    $(id).innerHTML = r.status === 200 ? render(r.body) : '<span class="err">'+esc(r.body.error||('HTTP '+r.status))+'</span>'
      + (r.body && r.body.hint ? '<div class="note">'+esc(r.body.hint)+'</div>' : '');
  }

  function loadAll(){
    section('wallet','/admin/wallet', function(b){
      var addr = (b.wallet && b.wallet.wallets ? b.wallet.wallets : []).map(function(w){
        return '<tr><td>'+esc(w.chain)+'</td><td><code>'+esc(w.address)+'</code></td></tr>';
      }).join('');
      var out = '<table><tr><th>chain</th><th>address</th></tr>'+addr+'</table>';
      if (b.portfolioError) out += '<div class="note err">portfolio: '+esc(b.portfolioError)+'</div>';
      else if (b.portfolio && b.portfolio.balances) out += j(b.portfolio.balances);
      return out;
    });

    section('llm','/admin/llm', function(b){
      if (b.error) return '<span class="err">'+esc(b.error)+'</span>';
      var bal = b.balanceUsd === null || b.balanceUsd === undefined ? 'unknown' : '$'+b.balanceUsd;
      return '<table>'+
        '<tr><td>requests</td><td>'+esc(b.requests)+'</td></tr>'+
        '<tr><td>cost</td><td>$'+esc(b.costUsd)+'</td></tr>'+
        '<tr><td>balance</td><td>'+esc(bal)+'</td></tr>'+
        '</table>';
    });

    section('queue','/admin/queue', function(b){
      if (!b.drafts.length && !b.approved.length) return '<span class="sub">nothing waiting</span>';
      return b.drafts.map(function(p){
        return '<div class="panel"><div>'+esc(p.draftText)+'</div>'+
          '<div class="sub">'+esc(p.channels.join(', '))+' · '+esc(p.id.slice(0,8))+'</div>'+
          '<div class="row" style="margin-top:8px">'+
          '<button class="primary" data-approve="'+esc(p.id)+'">Approve</button>'+
          '<button data-reject="'+esc(p.id)+'">Reject</button></div></div>';
      }).join('') + (b.approved.length ? '<div class="sub">'+b.approved.length+' approved and awaiting publish</div>' : '');
    }).then(function(){
      Array.prototype.forEach.call(document.querySelectorAll('[data-approve],[data-reject]'), function(btn){
        btn.onclick = async function(){
          var id = btn.getAttribute('data-approve') || btn.getAttribute('data-reject');
          var decision = btn.hasAttribute('data-approve') ? 'approved' : 'rejected';
          await api('/admin/queue/'+encodeURIComponent(id)+'/decide', {method:'POST', body: JSON.stringify({decision:decision})});
          loadAll();
        };
      });
    });

    section('launches','/admin/launches', function(b){
      return '<table><tr><th>token</th><th>chain</th><th>status</th></tr>'+
        b.launches.map(function(l){
          return '<tr><td>'+esc(l.tokenSymbol||'?')+' <span class="sub">'+esc(l.tokenName||'')+'</span></td>'+
            '<td>'+esc(l.chain||'')+'</td><td>'+esc(l.status||'')+'</td></tr>';
        }).join('')+'</table>';
    });
  }

  $('scopebtn').onclick = async function(){
    $('scope').innerHTML = '<span class="sub">asking Bankr…</span>';
    var r = await api('/admin/scope');
    var cls = r.body.verdict === 'ok' ? 'ok' : 'err';
    $('scope').innerHTML = '<div class="'+cls+'">'+esc(r.body.verdict)+'</div>'+j(r.body);
  };

  async function launch(simulate){
    var body = {
      tokenName: $('tname').value,
      tokenSymbol: $('tsym').value,
      feeRecipient: $('tfee').value,
      chain: $('tchain').value,
      simulate: simulate,
      confirm: $('tconfirm').value
    };
    $('launchout').innerHTML = '<span class="sub">'+(simulate?'simulating':'deploying')+'…</span>';
    var r = await api('/admin/launch', {method:'POST', body: JSON.stringify(body)});
    $('launchout').innerHTML = (r.status===200 ? '<div class="ok">'+(r.body.simulated?'simulation only — nothing was broadcast':'DEPLOYED')+'</div>' : '<div class="err">'+esc(r.body.error||'failed')+'</div>')
      + (r.body.note ? '<div class="note">'+esc(r.body.note)+'</div>' : '') + j(r.body);
  }
  $('simulate').onclick = function(){ launch(true); };
  $('deploy').onclick = function(){
    if (!confirm('Deploy '+$('tsym').value+' for real? This cannot be undone.')) return;
    launch(false);
  };

  refreshMe();
})();
`;
}
