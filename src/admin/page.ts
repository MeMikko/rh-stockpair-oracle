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

    <h2>Proposed actions <span class="sub">nothing runs until you approve it</span></h2>
    <p class="lede">
      ${agentIdentity.name} cannot call Bankr's acting endpoints. It writes a
      proposal, and this is where it lands. <strong>Read the parameters, not
      the reason.</strong> The reason is the agent's; the address is what
      moves. Approving runs the call from the server with exactly the values
      shown.
    </p>
    <div class="panel" id="actions">…</div>

    <h2>Ask ${agentIdentity.name} <span class="sub">this service's own agent, with this service's data</span></h2>
    <p class="lede">
      Free-form. It reads the live index, the recorded price series, the
      corporate-action calendar, the signal queue and the wallet — by calling
      tools, so every figure it gives you was looked up during the answer
      rather than remembered. It cannot trade, publish, or spend. Ask it what
      something means, not just what it is.
    </p>
    <div class="panel">
      <div id="chatlog"></div>
      <div class="row"><textarea id="chatin" rows="2" placeholder="why did v4 stop producing measurable rows?"></textarea></div>
      <div class="row">
        <button id="chatsend" class="primary">Ask</button>
        <button id="chatreset">New conversation</button>
        <span class="sub" id="chatstatus"></span>
      </div>
    </div>

    <h2>Talk to Bankr <span class="sub">the wallet's agent, not ${agentIdentity.name}</span></h2>
    <p class="lede">
      Plain language to the account that holds the funds: balances, fees, a
      launch. With a read-write key it <em>executes</em> — "sell all my BNKR"
      is a trade, not a question. Every prompt is logged against your address.
    </p>
    <div class="panel">
      <div class="row"><input type="text" id="prompt" placeholder="what are my balances?"></div>
      <div class="row"><button id="send" class="primary">Send</button><span class="sub" id="thread"></span></div>
      <div id="agentout"></div>
    </div>

    <h2>Write a post</h2>
    <p class="lede">
      Held to the same rule as a drafted one: every number must appear in the
      facts below, or it does not go out. Queues for approval — it never
      publishes. Sending still needs <code>agent:publish -- --live</code>.
    </p>
    <div class="panel">
      <div class="row">
        <select id="signal"><option value="">no signal — the service snapshot</option></select>
      </div>
      <div class="row"><textarea id="ptext" rows="3" placeholder="the post"></textarea></div>
      <div class="row">
        <button id="check">Check the numbers</button>
        <button id="composequeue" class="primary">Queue for approval</button>
      </div>
      <div id="composeout"></div>
    </div>

    <h2>Mentions</h2>
    <p class="lede">
      Where ${agentIdentity.name} has been tagged and has not answered. Drafting
      one runs the same classifier and verifier the webhook does; the reply
      lands in the queue rather than going out.
    </p>
    <div class="panel"><button id="loadmentions">Load mentions</button><div id="mentions"></div></div>

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
input[type=text],select,textarea{flex:1;min-width:170px;padding:10px 12px;font:inherit;color:var(--fg);
background:var(--bg);border:1px solid var(--line);border-radius:8px;resize:vertical}
textarea{width:100%;font-family:inherit}
em{color:var(--fg);font-style:normal;font-weight:600}
pre{font-family:var(--mono);font-size:.8rem;white-space:pre-wrap;word-break:break-word;margin:10px 0 0;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:.87rem}
td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
code{font-family:var(--mono);font-size:.84em}
.note{border-left:2px solid var(--line);padding-left:15px;color:var(--dim);margin:10px 0 0}
.ans{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;
margin-top:10px;white-space:pre-wrap}
details{margin-top:10px}
summary{cursor:pointer;color:var(--dim);font-size:.8rem}
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
    if (!window.ethereum){
      alert('No injected wallet in this browser. This page needs one to sign in — ' +
            'there is no password, only a signature from an owner address.');
      return;
    }
    // Every failure here used to be silent: an unhandled rejection left the
    // button looking broken. The common one is -32002, which means a previous
    // request is still open — usually a popup behind the window — and clicking
    // again can never succeed until that one is dealt with.
    try {
      var a = await window.ethereum.request({method:'eth_requestAccounts'});
      if (!a || !a.length){ alert('The wallet returned no account.'); return; }
      account = a[0];
      $('connect').textContent = account.slice(0,6)+'…'+account.slice(-4);
      $('signin').disabled = false;
    } catch(e){
      if (e && e.code === -32002){
        alert('The wallet is already asking — open the extension and answer the ' +
              'pending request, then try again.');
      } else if (e && e.code === 4001){
        alert('You rejected the connection request.');
      } else {
        alert('Wallet error: ' + ((e && (e.message || e.code)) || 'unknown'));
      }
    }
  };

  $('signin').onclick = async function(){
    if (!account) return;
    var n = await api('/admin/nonce?address='+encodeURIComponent(account));
    if (!n.body || !n.body.message){ alert('sign-in is not configured on this server'); return; }
    var sig;
    try {
      sig = await window.ethereum.request({method:'personal_sign', params:[n.body.message, account]});
    } catch(e){
      if (e && e.code === 4001) alert('You rejected the signature.');
      else if (e && e.code === -32002) alert('The wallet is already asking — answer that request first.');
      else alert('Signing failed: ' + ((e && (e.message || e.code)) || 'unknown'));
      return;
    }
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
    section('actions','/admin/actions', renderActions);
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
      var drafts = b.drafts.map(function(p){
        return '<div class="panel"><div>'+esc(p.draftText)+'</div>'+
          '<div class="sub">'+esc(p.channels.join(', '))+' · '+esc(p.draftedBy)+' · '+esc(p.id)+'</div>'+
          '<div class="row" style="margin-top:8px">'+
          '<button class="primary" data-approve="'+esc(p.id)+'">Approve</button>'+
          '<button data-reject="'+esc(p.id)+'">Reject</button></div></div>';
      }).join('');
      var approved = b.approved.map(function(p){
        return '<div class="panel"><div>'+esc(p.draftText)+'</div>'+
          '<div class="sub">approved by '+esc(p.decidedBy||'?')+' · '+esc(p.channels.join(', '))+
          (p.replyTo ? ' · reply' : ' · broadcast')+'</div>'+
          '<div class="row" style="margin-top:8px">'+
          '<button data-dry="'+esc(p.id)+'">Dry run</button>'+
          '<button class="danger" data-send="'+esc(p.id)+'">Publish for real</button></div>'+
          '<div id="pub-'+esc(p.id)+'"></div></div>';
      }).join('');
      return (drafts ? '<div class="sub">waiting for approval</div>'+drafts : '') +
             (approved ? '<div class="sub">approved, not yet sent</div>'+approved : '');
    }).then(function(){
      Array.prototype.forEach.call(document.querySelectorAll('[data-approve],[data-reject]'), function(btn){
        btn.onclick = async function(){
          var id = btn.getAttribute('data-approve') || btn.getAttribute('data-reject');
          var decision = btn.hasAttribute('data-approve') ? 'approved' : 'rejected';
          await api('/admin/queue/'+encodeURIComponent(id)+'/decide', {method:'POST', body: JSON.stringify({decision:decision})});
          loadAll();
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-dry]'), function(btn){
        btn.onclick = function(){ publish(btn.getAttribute('data-dry'), false); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-send]'), function(btn){
        btn.onclick = function(){
          if (!confirm('Send this to the public timeline? It cannot be taken back.')) return;
          publish(btn.getAttribute('data-send'), true);
        };
      });
    });

    loadSignals();

    section('launches','/admin/launches', function(b){
      return '<table><tr><th>token</th><th>chain</th><th>status</th></tr>'+
        b.launches.map(function(l){
          return '<tr><td>'+esc(l.tokenSymbol||'?')+' <span class="sub">'+esc(l.tokenName||'')+'</span></td>'+
            '<td>'+esc(l.chain||'')+'</td><td>'+esc(l.status||'')+'</td></tr>';
        }).join('')+'</table>';
    });
  }

  // ---- publishing ----
  // Without confirm:"SEND" the server treats it as a dry run, so the dry-run
  // button is the same call minus the word.
  async function publish(id, live){
    var out = $('pub-'+id);
    out.innerHTML = '<span class="sub">'+(live ? 'sending' : 'dry run')+'…</span>';
    var r = await api('/admin/queue/'+encodeURIComponent(id)+'/publish',
      {method:'POST', body: JSON.stringify(live ? {confirm:'SEND'} : {})});
    if (r.status !== 200){ out.innerHTML = '<div class="err">'+esc(r.body.error||'failed')+'</div>'; return; }
    var lines = (r.body.results||[]).map(function(x){
      return x.channel+': '+(x.error ? 'ERROR '+x.error : (x.dryRun ? 'would post' : 'posted '+x.ref));
    }).join('\\n');
    var cls = r.body.status === 'posted' ? 'ok' : (r.body.status === 'failed' ? 'err' : 'sub');
    out.innerHTML = '<div class="'+cls+'">'+esc(r.body.status)+'</div>'+
      (lines ? '<pre>'+esc(lines)+'</pre>' : '')+
      (r.body.note ? '<div class="note">'+esc(r.body.note)+'</div>' : '');
    // Only a live send changes a row, and only then is the list stale.
    if (live && r.body.status === 'posted') setTimeout(loadAll, 1200);
  }

  // ---- Bankr's own agent ----
  var thread = null;

  async function poll(jobId, n){
    if (n > 90) {
      $('agentout').innerHTML = '<div class="err">gave up after three minutes; the job may still finish</div>';
      return;
    }
    var r = await api('/admin/agent/job/'+encodeURIComponent(jobId));
    var s = r.body.status;
    if (s === 'completed'){ $('agentout').innerHTML = '<div class="ans">'+esc(r.body.response||'(empty)')+'</div>'; return; }
    if (s === 'failed' || s === 'cancelled'){ $('agentout').innerHTML = '<div class="err">'+esc(r.body.error||s)+'</div>'; return; }
    $('agentout').innerHTML = '<span class="sub">'+esc(s||'pending')+'… '+(n*2)+'s</span>';
    setTimeout(function(){ poll(jobId, n+1); }, 2000);
  }

  $('send').onclick = async function(){
    var prompt = $('prompt').value.trim();
    if (!prompt) return;
    $('agentout').innerHTML = '<span class="sub">sending…</span>';
    var body = thread ? {prompt:prompt, threadId:thread} : {prompt:prompt};
    var r = await api('/admin/agent/prompt', {method:'POST', body: JSON.stringify(body)});
    if (r.status !== 200){
      $('agentout').innerHTML = '<div class="err">'+esc(r.body.error||'failed')+'</div>'
        + (r.body.hint ? '<div class="note">'+esc(r.body.hint)+'</div>' : '');
      return;
    }
    thread = r.body.threadId || thread;
    $('thread').textContent = thread ? 'thread '+thread : '';
    poll(r.body.jobId, 0);
  };

  // ---- writing a post ----
  async function loadSignals(){
    var r = await api('/admin/signals');
    if (r.status !== 200) return;
    $('signal').innerHTML = '<option value="">no signal — the service snapshot</option>' +
      r.body.signals.map(function(s){
        return '<option value="'+esc(s.id)+'">'+esc(s.kind)+' · '+esc(s.summary.slice(0,70))+
          (s.queuedAs ? ' (already queued)' : '')+'</option>';
      }).join('');
  }

  /* ------------------------------------------- proposed actions -- */

  window.decideAction = async function(id, decision){
    if (decision === 'approve' &&
        !confirm('Run this against Bankr now? This spends gas and cannot be undone.')) return;
    $('actions').innerHTML = '<span class="sub">working…</span>';
    var r = await api('/admin/actions/'+encodeURIComponent(id)+'/decide',
      {method:'POST', body: JSON.stringify({decision:decision})});
    if (r.status !== 200) alert(r.body.error || 'failed');
    loadAll();
  };

  function renderActions(b){
    var list = (b.actions || []);
    if (!list.length) return '<span class="sub">nothing proposed</span>';
    return list.map(function(a){
      var pending = a.status === 'pending';
      // Parameters first and verbatim: the rationale is the agent's account of
      // itself, the parameters are what actually runs.
      return '<div class="ans"><strong>' + esc(a.kind) + '</strong> ' +
        '<span class="sub">' + esc(a.status) + (a.decidedBy ? ' by ' + esc(a.decidedBy) : '') + '</span>' +
        j(a.params) +
        '<div class="sub">reason given: ' + esc(a.rationale) + '</div>' +
        (a.error ? '<div class="err">' + esc(a.error) + '</div>' : '') +
        (a.result ? j(a.result) : '') +
        (pending
          ? '<div class="row">' +
            '<button class="primary" onclick="decideAction(\'' + esc(a.id) + '\',\'approve\')">Approve and run</button>' +
            '<button onclick="decideAction(\'' + esc(a.id) + '\',\'reject\')">Reject</button>' +
            '</div>'
          : '') +
        '</div>';
    }).join('');
  }

  /* -------------------------------------------------- ask Vates -- */

  // Kept in the page rather than on the server: the panel holds no
  // per-operator state, and a reload starting a fresh conversation is the
  // honest behaviour when nothing was stored.
  var chatHistory = [];

  function chatAppend(who, text, tools){
    var d = document.createElement('div');
    d.className = 'ans';
    d.innerHTML = '<strong>' + esc(who) + '</strong> ' +
      (tools && tools.length ? '<span class="sub">' + esc(tools.join(' · ')) + '</span>' : '') +
      '<div>' + esc(text).replace(/\n/g, '<br>') + '</div>';
    $('chatlog').appendChild(d);
    d.scrollIntoView({block:'nearest'});
  }

  $('chatsend').onclick = async function(){
    var text = $('chatin').value.trim();
    if (!text) return;
    chatAppend('you', text, null);
    $('chatin').value = '';
    $('chatstatus').textContent = 'thinking…';
    var r = await api('/admin/chat', {method:'POST',
      body: JSON.stringify({message:text, history:chatHistory})});
    $('chatstatus').textContent = '';
    if (r.status !== 200){
      chatAppend('error', r.body.error || 'failed', null);
      return;
    }
    chatHistory = r.body.messages || [];
    chatAppend('${agentIdentity.name}', r.body.text || '(no answer)', r.body.toolsUsed);
    if (r.body.truncated) $('chatstatus').textContent = 'stopped after the tool budget ran out';
  };

  $('chatreset').onclick = function(){
    chatHistory = [];
    $('chatlog').innerHTML = '';
    $('chatstatus').textContent = 'new conversation';
  };

  $('check').onclick = async function(){
    var r = await api('/admin/compose/check', {method:'POST',
      body: JSON.stringify({signalId:$('signal').value, text:$('ptext').value})});
    if (r.status !== 200){ $('composeout').innerHTML = '<div class="err">'+esc(r.body.error)+'</div>'; return; }
    var v = r.body.verification;
    $('composeout').innerHTML =
      (v.ok
        ? '<div class="ok">passes — every number is in the facts, '+v.length+'/'+r.body.maxLength+' chars</div>'
        : '<div class="err">'+(v.unsupported.length
            ? 'not in the facts: '+esc(v.unsupported.join(', '))
            : 'too long for a cast: '+v.length+'/'+r.body.maxLength)+'</div>')
      + '<details><summary>the numbers this may cite</summary>'+j(r.body.facts)+'</details>';
  };

  $('composequeue').onclick = async function(){
    var r = await api('/admin/compose', {method:'POST',
      body: JSON.stringify({signalId:$('signal').value, text:$('ptext').value})});
    if (r.status === 200){
      $('composeout').innerHTML = '<div class="ok">queued as '+esc(r.body.post.id)+' — approve it in the queue above</div>';
      $('ptext').value = '';
      loadAll();
    } else {
      $('composeout').innerHTML = '<div class="err">'+esc(r.body.error||'failed')+'</div>';
    }
  };

  // ---- mentions ----
  $('loadmentions').onclick = async function(){
    $('mentions').innerHTML = '<span class="sub">asking Neynar…</span>';
    var r = await api('/admin/mentions');
    if (r.status !== 200){ $('mentions').innerHTML = '<div class="err">'+esc(r.body.error)+'</div>'; return; }
    if (!r.body.pending.length){
      $('mentions').innerHTML = '<span class="sub">nothing unanswered ('+r.body.total+' mentions seen)</span>';
      return;
    }
    $('mentions').innerHTML = r.body.pending.map(function(m){
      return '<div class="panel"><div>@'+esc(m.author)+': '+esc(m.text)+'</div>'+
        '<div class="sub">reads as: '+esc(m.question)+'</div>'+
        '<div class="row" style="margin-top:8px"><button data-mention="'+esc(m.hash)+'">Draft a reply</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('[data-mention]'), function(btn){
      btn.onclick = async function(){
        btn.disabled = true; btn.textContent = 'drafting…';
        var res = await api('/admin/mentions/'+encodeURIComponent(btn.getAttribute('data-mention'))+'/queue',
          {method:'POST', body: JSON.stringify({})});
        var out = document.createElement('div');
        out.innerHTML = res.body.queued
          ? '<div class="ok">queued</div><div class="ans">'+esc(res.body.text||'')+'</div>'
          : '<div class="err">'+esc(res.body.reason||res.body.error||'failed')+'</div>'
            + (res.body.text ? '<div class="ans">'+esc(res.body.text)+'</div>' : '');
        btn.parentNode.appendChild(out);
        btn.textContent = 'Draft a reply'; btn.disabled = false;
        loadAll();
      };
    });
  };

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
