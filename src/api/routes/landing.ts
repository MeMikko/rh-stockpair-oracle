import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { ROUTE_PRICES, pricingMode } from '../../../config/pricing.js';
import { formatUsdc, paymentConfig, priceUnits, PAYMENT_CHAIN_ID } from '../../../config/payments.js';
import { authConfigured } from '../../auth/session.js';

/**
 * The page a human gets at the root.
 *
 * Until this existed the root returned a 404 JSON body, which is what every
 * person and crawler that found the domain saw -- and they find it fast, since
 * every certificate is published to Certificate Transparency within seconds.
 * A service listed in a public skill catalogue needs to be able to say what it
 * is to someone who arrives without an API client.
 *
 * Deliberately server-rendered from live counts rather than a static page: the
 * numbers here are the product, and a figure that might be a screenshot from
 * last month is worth less than no figure. Everything is inline -- no external
 * scripts, fonts or styles -- so the page cannot break on a CDN and cannot
 * leak a visitor to a third party.
 */

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const fmt = (n: number): string => n.toLocaleString('en-US');

interface Stats {
  v4Pools: number;
  v4Stock: number;
  v3Pools: number;
  v3Stock: number;
  actions: number;
  feeds: number;
  tokens: number;
  volume: { v4: number; v3: number; hours: number } | null;
  lag: number | null;
}

function readStats(): Stats {
  const db = getDb();
  const n = (sql: string): number => {
    try {
      return Number((db.prepare(sql).get() as { n: number }).n);
    } catch {
      return 0;
    }
  };

  let volume: Stats['volume'] = null;
  try {
    const rows = db
      .prepare(
        `SELECT v.protocol, SUM(v.swaps) AS swaps, MIN(v.from_ts) AS from_ts, MAX(v.to_ts) AS to_ts
           FROM pool_volume v GROUP BY v.protocol`,
      )
      .all() as unknown as Array<{ protocol: string; from_ts: number; to_ts: number }>;
    if (rows.length > 0) {
      // Volume in USD needs the Chainlink join, which is a live read; the
      // landing page uses the cheaper swap-window metadata and links to /ask
      // for the priced figure rather than doing oracle reads on every visit.
      const hours = (rows[0]!.to_ts - rows[0]!.from_ts) / 3600;
      volume = { v4: 0, v3: 0, hours };
    }
  } catch {
    volume = null;
  }

  let lag: number | null = null;
  try {
    const r = db
      .prepare("SELECT MAX(last_block) AS n FROM cursor WHERE stream NOT LIKE 'crosscheck:%'")
      .get() as { n: number } | undefined;
    lag = r?.n ? Number(r.n) : null;
  } catch {
    lag = null;
  }

  return {
    v4Pools: n('SELECT COUNT(*) AS n FROM pools'),
    v4Stock: n("SELECT COUNT(*) AS n FROM pools WHERE quote_kind = 'stock'"),
    v3Pools: n('SELECT COUNT(*) AS n FROM pools_v3'),
    v3Stock: n("SELECT COUNT(*) AS n FROM pools_v3 WHERE quote_kind = 'stock'"),
    actions: n('SELECT COUNT(*) AS n FROM corporate_actions'),
    feeds: n('SELECT COUNT(*) AS n FROM feeds'),
    tokens: n('SELECT COUNT(*) AS n FROM stock_tokens'),
    volume,
    lag,
  };
}

function page(s: Stats): string {
  const priced = Object.entries(ROUTE_PRICES).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const uncovered = s.tokens - s.feeds;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RH stock-pair oracle</title>
<meta name="description" content="Pricing and corporate-action data for Robinhood Chain (4663) pools paired against tokenized stocks. Uniswap v4 and v3.">
<style>
:root{--bg:#fbfbfa;--fg:#1a1a18;--dim:#6b6b66;--line:#e2e1dd;--card:#fff;--acc:#1f6f43;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#131315;--fg:#e8e8e4;--dim:#9a9a93;--line:#2c2c30;--card:#1a1a1d;--acc:#5ec98d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:48px 20px 72px}
h1{font-size:1.5rem;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:1rem;margin:38px 0 12px;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 28px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.stat b{display:block;font-size:1.35rem;font-weight:600;letter-spacing:-.02em}
.stat span{color:var(--dim);font-size:.8rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}
td,th{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.8rem}
code,pre{font-family:var(--mono);font-size:.85rem}
code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:13px 15px;overflow-x:auto;margin:10px 0}
pre code{background:none;border:0;padding:0}
a{color:var(--acc)}
.note{border-left:2px solid var(--line);padding-left:14px;color:var(--dim);margin:14px 0}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font-size:.85rem}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.askrow{display:flex;gap:8px}
#q{flex:1;min-width:0;padding:11px 13px;font:inherit;color:var(--fg);background:var(--card);
   border:1px solid var(--line);border-radius:8px}
#q:focus{outline:2px solid var(--acc);outline-offset:-1px}
#go{padding:11px 18px;font:inherit;font-weight:500;color:#fff;background:var(--acc);
    border:0;border-radius:8px;cursor:pointer}
#go[disabled]{opacity:.55;cursor:default}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.chips button{font:inherit;font-size:.8rem;color:var(--dim);background:none;
  border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer}
.chips button:hover{color:var(--fg);border-color:var(--dim)}
.ans{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0 0}
.ans p{margin:0}
.ans .meta{color:var(--dim);font-size:.8rem;margin-top:10px;display:flex;flex-wrap:wrap;gap:6px 14px}
.ans details{margin-top:10px}
.ans summary{cursor:pointer;color:var(--dim);font-size:.8rem}
.ans pre{margin:8px 0 0}
.unans{border-left:2px solid var(--dim)}
.err{border-left:2px solid #c0392b}
.pro{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:14px 0 0}
.pro h3{margin:0 0 6px;font-size:.95rem}
.pro ol{margin:12px 0 0;padding-left:20px;color:var(--dim);font-size:.88rem}
.pro li{margin:6px 0}
.pro .addr{font-family:var(--mono);font-size:.8rem;word-break:break-all;
  background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;margin:4px 0 0}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0}
.btns button{padding:9px 15px;font:inherit;font-size:.88rem;font-weight:500;cursor:pointer;
  border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.btns button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
.btns button[disabled]{opacity:.5;cursor:default}
.who{font-size:.82rem;color:var(--dim);margin-top:10px}
.who b{color:var(--fg);font-weight:600}
</style></head><body><div class="wrap">

<h1>RH stock-pair oracle</h1>
<p class="sub">Pricing and corporate-action data for <strong>Robinhood Chain (4663)</strong> pools
where one side is a tokenized stock or ETF. Deterministic — no model sits in the data path.</p>

<div class="grid">
  <div class="stat"><b>${fmt(s.v4Pools + s.v3Pools)}</b><span>pools indexed</span></div>
  <div class="stat"><b>${fmt(s.v4Stock + s.v3Stock)}</b><span>stock-paired</span></div>
  <div class="stat"><b>${fmt(s.feeds)} / ${fmt(s.tokens)}</b><span>tokens with a feed</span></div>
  <div class="stat"><b>${fmt(s.actions)}</b><span>corporate actions</span></div>
</div>
<p class="sub" style="font-size:.85rem;margin-top:10px">
Uniswap v4: ${fmt(s.v4Pools)} pools (${fmt(s.v4Stock)} stock-paired) ·
v3: ${fmt(s.v3Pools)} pools (${fmt(s.v3Stock)} stock-paired)${
    s.lag ? ` · indexed to block ${fmt(s.lag)}` : ''
  }</p>

<h2>Why this exists</h2>
<p>On Robinhood Chain, launchpads pair new tokens against tokenized equities instead of
against ETH. That makes the quote asset something whose price moves on a market with
opening hours, splits and dividends. Nothing else published reads those pools and says
what a token is worth in dollars, or how far a pool has drifted from the equity's oracle
price while the underlying market is shut.</p>

<div class="note">
<strong>v3 is not a rounding error.</strong> Uniswap v3 carries roughly a third of
stock-paired volume here, and four of the five largest stock-paired pools by 24h volume
are v3. Every other RH data source indexes v4 alone.
</div>

<h2>Ask it something</h2>
<form id="askform" autocomplete="off">
  <label class="vh" for="q">Question</label>
  <div class="askrow">
    <input id="q" name="q" type="text" maxlength="500" placeholder="when is the next NVDA dividend?">
    <button type="submit" id="go">Ask</button>
  </div>
</form>
<div class="chips" id="chips">
  <button type="button" data-q="how many pools quote NVDA?">pools quoting NVDA</button>
  <button type="button" data-q="what is the v3 v4 volume split?">v3 / v4 volume split</button>
  <button type="button" data-q="does TSLA have a chainlink feed?">TSLA feed coverage</button>
  <button type="button" data-q="is the gas subsidy still active?">gas subsidy</button>
</div>
<div id="out" aria-live="polite"></div>

<p>Every answer carries the <code>facts</code> behind it and a <code>reproduce</code> field
naming the call that reproduces it — so a caller can <em>verify</em> the answer rather than
trust it. A question it cannot classify returns <code>answered: false</code> and says what it
does know. There is no fallback that guesses.</p>

<pre><code>curl -X POST https://oracle.sb4s.xyz/ask \\
  -H 'content-type: application/json' \\
  -d '{"question":"when is the next NVDA dividend?"}'</code></pre>

<h2>Pro</h2>
<div class="pro">
  <h3>$${paymentConfig.priceUsd} for ${paymentConfig.periodDays} days — does not auto-renew</h3>
  <p style="margin:0;color:var(--dim);font-size:.9rem">
    Pro lets you tag the agent on Farcaster and get an answer straight back, and
    signs you in here. Pay from your own wallet; the server reads the transfer
    off Base rather than trusting a receipt.
  </p>
  <div class="btns">
    <button id="connect" class="primary">Connect wallet</button>
    <button id="pay" disabled>Pay ${formatUsdc(priceUnits())} USDC</button>
    <button id="signin" disabled>Sign in</button>
  </div>
  <div class="who" id="who">Not connected.</div>
  <ol>
    <li>Send <b>${formatUsdc(priceUnits())} USDC</b> on Base to the treasury below.</li>
    <li>Paste the transaction hash — or let the button do both.</li>
    <li>Sign a message to prove the address. It authorises nothing else.</li>
  </ol>
  <div class="addr">${esc(paymentConfig.treasury)}</div>
  <div class="askrow" style="margin-top:10px">
    <input id="txhash" type="text" placeholder="0x… transaction hash, if you paid separately">
    <button type="button" id="claim">Claim</button>
  </div>
  <div class="askrow" style="margin-top:8px">
    <input id="fid" type="text" inputmode="numeric" placeholder="your Farcaster FID, to use pro when you tag the agent">
    <button type="button" id="linkfid">Link</button>
  </div>
  <div id="proout"></div>
</div>

<h2>Endpoints</h2>
<table>
<tr><th>Route</th><th>Returns</th><th>Price</th></tr>
<tr><td><code>GET /quote</code></td><td>implied USD, depth, price impact, Chainlink deviation, market hours</td><td>$${ROUTE_PRICES['/quote']?.toFixed(3)}</td></tr>
<tr><td><code>POST /prepare-swap</code></td><td>unsigned UniversalRouter calldata, min-out from the quoter</td><td>$${ROUTE_PRICES['/prepare-swap']?.toFixed(3)}</td></tr>
<tr><td><code>GET /gas</code></td><td>chain 4663 gas, split into L2 and L1-data components</td><td>$${ROUTE_PRICES['/gas']?.toFixed(3)}</td></tr>
<tr><td><code>GET /corporate-actions</code></td><td>upcoming splits and dividends joined to the affected pools</td><td>$${ROUTE_PRICES['/corporate-actions']?.toFixed(3)}</td></tr>
<tr><td><code>POST /ask</code></td><td>free-text question, structured answer</td><td>$${ROUTE_PRICES['/ask']?.toFixed(3)}</td></tr>
<tr><td><code>GET /coverage</code></td><td>which stock tokens have a Chainlink feed</td><td>free</td></tr>
<tr><td><code>GET /health</code></td><td>index freshness: pool counts and cursors</td><td>free</td></tr>
</table>

<h2>What it will cost</h2>
<p>This is <strong>not a free service</strong>, and it is not advertised as one. It is currently in
<strong>${esc(pricingMode)} mode</strong>: every route is served without charge and no key is
required, while each response publishes what the call will cost once billing is enabled.</p>
<pre><code>x-oracle-price-usd: ${priced.find(([r]) => r === '/quote')?.[1].toFixed(2) ?? '0.01'}     what this route will cost
x-oracle-charged-usd: 0      what it cost you today
x-oracle-pricing: ${esc(pricingMode)}     the current mode</code></pre>
<p>Read those headers rather than assuming — launch mode will end. Prices are set to cover
the upstream cost a request causes, not to earn margin.</p>

<h2>Read the labels</h2>
<p><code>deviation: null</code> is normal and <strong>must never be read as zero</strong>:
${fmt(uncovered)} of ${fmt(s.tokens)} stock tokens have no Chainlink feed, so for those a
deviation is not merely unknown but unknowable on-chain. <code>depth</code> is an
active-tick estimate that can mislead — trust <code>impact</code>, which is a quoter
simulation. Nothing here signs, broadcasts, or holds funds.</p>

<footer>
Source and full documentation:
<a href="https://github.com/MeMikko/rh-stockpair-oracle">github.com/MeMikko/rh-stockpair-oracle</a><br>
Counts on this page are read live from the index at request time.
</footer>

</div>
<script>
(function () {
  var form = document.getElementById('askform');
  var input = document.getElementById('q');
  var go = document.getElementById('go');
  var out = document.getElementById('out');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }

  function render(data) {
    // An unanswered question is shown as such rather than dressed up. The
    // service refusing to guess is a feature, and hiding it would teach
    // people to expect an answer to anything.
    var cls = data.answered ? 'ans' : 'ans unans';
    var facts = JSON.stringify(data.facts, null, 2);
    var hasFacts = data.facts && Object.keys(data.facts).length > 0;
    out.innerHTML =
      '<div class="' + cls + '">' +
        '<p>' + esc(data.answer) + '</p>' +
        '<div class="meta">' +
          '<span>intent: <code>' + esc(data.intent) + '</code></span>' +
          (data.symbol ? '<span>symbol: <code>' + esc(data.symbol) + '</code></span>' : '') +
          '<span>reproduce: <code>' + esc(data.reproduce) + '</code></span>' +
          (data.caller ? '<span>you: <code>' + esc(data.caller.tier) + '</code></span>' : '') +
        '</div>' +
        (hasFacts
          ? '<details><summary>facts behind this answer</summary><pre><code>' +
            esc(facts) + '</code></pre></details>'
          : '') +
      '</div>';
  }

  function ask(q) {
    if (!q) return;
    go.disabled = true;
    out.innerHTML = '<div class="ans"><p style="color:var(--dim)">asking…</p></div>';
    fetch('/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: q })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j && res.j.error ? res.j.error : 'request failed');
        render(res.j);
      })
      .catch(function (e) {
        out.innerHTML = '<div class="ans err"><p>' + esc(e.message || 'request failed') + '</p></div>';
      })
      .then(function () { go.disabled = false; });
  }

  // ---- pro: connect, pay, sign in ----------------------------------------
  // No wallet library: window.ethereum is all this needs, and a bundled
  // connector would be the only third-party script on the page.
  var TREASURY = ${JSON.stringify(paymentConfig.treasury)};
  var USDC = ${JSON.stringify(paymentConfig.usdc)};
  var AMOUNT = ${JSON.stringify(priceUnits().toString())};
  var CHAIN_HEX = ${JSON.stringify('0x' + PAYMENT_CHAIN_ID.toString(16))};

  var SIGNIN_READY = ${authConfigured() ? 'true' : 'false'};
  var account = null;
  var $ = function (id) { return document.getElementById(id); };
  var proout = $('proout');

  function say(msg, cls) {
    proout.innerHTML = '<div class="ans ' + (cls || '') + '"><p>' + esc(msg) + '</p></div>';
  }

  function refreshWho() {
    fetch('/auth/me').then(function (r) { return r.json(); }).then(function (me) {
      var bits = [];
      if (account) bits.push('wallet <b>' + esc(account.slice(0, 6) + '…' + account.slice(-4)) + '</b>');
      bits.push(me.signedIn ? 'signed in as <b>' + esc(me.tier) + '</b>' : 'not signed in');
      // A disabled button with no explanation reads as a missing feature.
      // Say which step is next, or why the step cannot be taken at all.
      if (!SIGNIN_READY) {
        bits.push('sign-in is not configured on this server');
      } else if (!account) {
        bits.push('connect a wallet to pay or sign in');
      }
      $('who').innerHTML = bits.join(' · ');
      $('pay').disabled = !account;
      $('signin').disabled = !account || !SIGNIN_READY;
      $('signin').title = !SIGNIN_READY
        ? 'The server has no AUTH_SECRET set, so sign-in is disabled.'
        : (!account ? 'Connect a wallet first.' : 'Sign a message to prove this address.');
      $('pay').title = account ? '' : 'Connect a wallet first.';
    }).catch(function () {});
  }

  // 6-decimal USDC amount as a 32-byte hex word, without a bignum library.
  function encodeTransfer(to, amount) {
    var addr = to.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    var amt = BigInt(amount).toString(16).padStart(64, '0');
    return '0xa9059cbb' + addr + amt;
  }

  $('connect').addEventListener('click', function () {
    if (!window.ethereum) { say('No wallet found in this browser.', 'err'); return; }
    window.ethereum.request({ method: 'eth_requestAccounts' })
      .then(function (accs) { account = accs[0]; refreshWho(); say('Wallet connected.'); })
      .catch(function (e) { say(e.message || 'connection refused', 'err'); });
  });

  $('pay').addEventListener('click', function () {
    if (!account) return;
    say('Switching to Base…');
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] })
      .catch(function () { /* already on Base, or the wallet refused; try anyway */ })
      .then(function () {
        say('Confirm the transfer in your wallet…');
        return window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from: account, to: USDC, data: encodeTransfer(TREASURY, AMOUNT) }]
        });
      })
      .then(function (tx) {
        $('txhash').value = tx;
        // Claiming immediately usually fails on confirmations, which is
        // expected rather than an error; the hash is kept so Claim works once
        // the transfer settles.
        say('Sent ' + tx.slice(0, 12) + '… — wait a few seconds, then press Claim.');
      })
      .catch(function (e) { say(e.message || 'payment cancelled', 'err'); });
  });

  $('claim').addEventListener('click', function () {
    var tx = $('txhash').value.trim();
    if (!tx) { say('Paste the transaction hash first.', 'err'); return; }
    say('Checking the transfer on Base…');
    fetch('/pro/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: tx })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { say(j.error || 'claim failed', 'err'); return; }
        say('Pro until ' + j.expiresAt.slice(0, 10) + ' for ' + j.address.slice(0, 10) + '… — now sign in with that wallet.');
        refreshWho();
      })
      .catch(function (e) { say(e.message || 'claim failed', 'err'); });
  });

  $('linkfid').addEventListener('click', function () {
    var fid = $('fid').value.trim();
    if (!fid) { say('Enter your Farcaster FID.', 'err'); return; }
    say('Checking that this FID has verified your address…');
    fetch('/pro/link-fid', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fid: fid })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { say(j.error || 'link failed', 'err'); return; }
        say('FID ' + j.fid + ' linked. Tag the agent on Farcaster and it will answer directly.');
        refreshWho();
      })
      .catch(function (e) { say(e.message || 'link failed', 'err'); });
  });

  $('signin').addEventListener('click', function () {
    if (!account) return;
    say('Requesting a nonce…');
    fetch('/auth/nonce?address=' + encodeURIComponent(account))
      .then(function (r) { return r.json(); })
      .then(function (n) {
        if (!n.message) throw new Error('sign-in is not configured on this server');
        return window.ethereum
          .request({ method: 'personal_sign', params: [n.message, account] })
          .then(function (sig) {
            return fetch('/auth/verify', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ address: account, signature: sig, nonce: n.nonce })
            });
          });
      })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'sign-in failed');
        say('Signed in as ' + res.j.tier + '.');
        refreshWho();
      })
      .catch(function (e) { say(e.message || 'sign-in failed', 'err'); });
  });

  refreshWho();

  form.addEventListener('submit', function (e) { e.preventDefault(); ask(input.value.trim()); });
  document.getElementById('chips').addEventListener('click', function (e) {
    var q = e.target && e.target.getAttribute('data-q');
    if (!q) return;
    input.value = q;
    ask(q);
  });
})();
</script>
</body></html>`;
}

export function registerLanding(app: FastifyInstance): void {
  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    // Short cache: the numbers move continuously, but a crawler burst should
    // not mean a database read each time.
    reply.header('cache-control', 'public, max-age=60');
    return page(readStats());
  });

  // Crawlers arrive within seconds of the certificate hitting the CT log.
  // Let them index the landing page and leave the priced endpoints alone --
  // a crawler calling /quote costs an upstream RPC round trip and tells
  // nobody anything.
  app.get('/robots.txt', async (_req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    return [
      'User-agent: *',
      'Allow: /$',
      'Disallow: /quote',
      'Disallow: /prepare-swap',
      'Disallow: /gas',
      'Disallow: /ask',
      'Disallow: /corporate-actions',
      'Disallow: /webhooks/',
      '',
    ].join('\n');
  });
}
