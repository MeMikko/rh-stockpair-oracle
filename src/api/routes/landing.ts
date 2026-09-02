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
 *
 * Server-rendered from live counts rather than written as a static page: the
 * numbers are the product, and a figure that might be a screenshot from last
 * month is worth less than no figure. Everything is inline -- no external
 * scripts, fonts or styles -- so the page cannot break behind a CDN and cannot
 * leak a visitor to a third party.
 *
 * The ask box is open to everyone on purpose. Hiding it behind a wallet would
 * mean nobody could see the service work before committing one, and "other
 * agents call it" is the goal this page exists to serve. A wallet buys pro;
 * it is not the price of looking.
 */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number): string => n.toLocaleString('en-US');

interface Stats {
  v4Pools: number;
  v4Stock: number;
  v3Pools: number;
  v3Stock: number;
  actions: number;
  feeds: number;
  tokens: number;
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
    lag,
  };
}

const ROUTES: Array<[string, string, number]> = [
  ['GET /quote', 'implied USD, depth, price impact, Chainlink deviation, market hours', ROUTE_PRICES['/quote'] ?? 0],
  ['POST /prepare-swap', 'unsigned UniversalRouter calldata, min-out from the quoter', ROUTE_PRICES['/prepare-swap'] ?? 0],
  ['GET /gas', 'chain 4663 gas, split into L2 and L1-data components', ROUTE_PRICES['/gas'] ?? 0],
  ['GET /corporate-actions', 'upcoming splits and dividends joined to affected pools', ROUTE_PRICES['/corporate-actions'] ?? 0],
  ['POST /ask', 'free-text question, structured answer', ROUTE_PRICES['/ask'] ?? 0],
  ['GET /coverage', 'which stock tokens have a Chainlink feed', 0],
  ['GET /health', 'index freshness: pool counts and cursors', 0],
];

function styles(): string {
  return `
:root{--bg:#fafaf9;--panel:#fff;--fg:#18181b;--dim:#71717a;--faint:#a1a1aa;
--line:#e4e4e7;--acc:#15803d;--acc-soft:#dcfce7;--danger:#b91c1c;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius:10px;
--shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.06)}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0e;--panel:#161619;--fg:#e9e9e7;
--dim:#a1a1aa;--faint:#71717a;--line:#27272a;--acc:#4ade80;--acc-soft:#14321f;
--danger:#f87171;--shadow:0 1px 2px rgba(0,0,0,.3)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
header{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line)}
.bar{max-width:900px;margin:0 auto;padding:11px 20px;display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.01em;margin-right:auto}
.dot{width:9px;height:9px;border-radius:50%;background:var(--acc);flex:none}
.brand small{display:block;font-weight:400;font-size:.72rem;color:var(--dim);letter-spacing:0}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);
background:var(--panel);color:var(--fg);padding:8px 14px;font-size:.87rem;transition:border-color .12s}
button:hover:not([disabled]){border-color:var(--faint)}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:500}
button[disabled]{opacity:.45;cursor:not-allowed}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;color:var(--dim);
border:1px solid var(--line);border-radius:999px;padding:4px 11px;white-space:nowrap}
.pill b{color:var(--fg);font-weight:600}
.pill.pro{background:var(--acc-soft);border-color:transparent;color:var(--acc)}
.pill.pro b{color:var(--acc)}
main{max-width:900px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:1.75rem;line-height:1.25;margin:0 0 10px;letter-spacing:-.025em}
h2{font-size:1.05rem;margin:44px 0 14px;letter-spacing:-.015em}
h3{font-size:.95rem;margin:0 0 6px}
.lede{color:var(--dim);font-size:1.02rem;margin:0 0 26px;max-width:62ch}
p{margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:11px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
padding:14px 15px;box-shadow:var(--shadow)}
.stat b{display:block;font-size:1.4rem;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.stat span{color:var(--dim);font-size:.78rem}
.meta-line{color:var(--faint);font-size:.8rem;margin:11px 0 0;font-variant-numeric:tabular-nums}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
padding:20px;box-shadow:var(--shadow)}
.askrow{display:flex;gap:8px;flex-wrap:wrap}
input[type=text]{flex:1;min-width:170px;padding:11px 13px;font:inherit;color:var(--fg);
background:var(--bg);border:1px solid var(--line);border-radius:8px}
input[type=text]:focus{outline:2px solid var(--acc);outline-offset:-1px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:11px 0 0}
.chips button{font-size:.79rem;color:var(--dim);background:transparent;padding:4px 11px;border-radius:999px}
.chips button:hover{color:var(--fg)}
.ans{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0 0}
.ans p{margin:0}
.ans .meta{color:var(--dim);font-size:.78rem;margin-top:11px;display:flex;flex-wrap:wrap;gap:5px 14px}
.ans details{margin-top:10px}
.ans summary{cursor:pointer;color:var(--dim);font-size:.78rem}
.unans{border-left:2px solid var(--faint)}
.err{border-left:2px solid var(--danger)}
table{width:100%;border-collapse:collapse;font-size:.88rem}
td,th{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.76rem;text-transform:uppercase;letter-spacing:.04em}
td:last-child,th:last-child{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
code{font-family:var(--mono);font-size:.84em;background:var(--bg);border:1px solid var(--line);
border-radius:4px;padding:1px 5px}
pre{font-family:var(--mono);font-size:.82rem;background:var(--panel);border:1px solid var(--line);
border-radius:var(--radius);padding:14px 16px;overflow-x:auto;margin:12px 0}
pre code{background:none;border:0;padding:0}
a{color:var(--acc);text-underline-offset:2px}
.note{border-left:2px solid var(--line);padding-left:15px;color:var(--dim);margin:16px 0}
.addr{font-family:var(--mono);font-size:.79rem;word-break:break-all;background:var(--bg);
border:1px solid var(--line);border-radius:7px;padding:8px 10px;margin:6px 0 0}
ol{margin:14px 0 0;padding-left:19px;color:var(--dim);font-size:.87rem}
ol li{margin:5px 0}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--faint);font-size:.83rem}
@media(max-width:560px){.bar{flex-wrap:wrap}h1{font-size:1.45rem}}
`;
}

function clientScript(): string {
  // Plain window.ethereum: a wallet connector library would be the only
  // third-party script on this page, and this needs four RPC methods.
  return `
(function () {
  var SIGNIN_READY = ${authConfigured() ? 'true' : 'false'};
  var TREASURY = ${JSON.stringify(paymentConfig.treasury)};
  var USDC = ${JSON.stringify(paymentConfig.usdc)};
  var AMOUNT = ${JSON.stringify(priceUnits().toString())};
  var CHAIN_HEX = ${JSON.stringify('0x' + PAYMENT_CHAIN_ID.toString(16))};

  var account = null;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }
  function say(el, msg, cls) {
    $(el).innerHTML = '<div class="ans ' + (cls || '') + '"><p>' + esc(msg) + '</p></div>';
  }

  function paint(me) {
    var pill = $('tierpill');
    if (account) {
      pill.hidden = false;
      pill.className = 'pill' + (me && me.tier === 'pro' ? ' pro' : '');
      pill.innerHTML = '<b>' + esc(account.slice(0, 6) + '…' + account.slice(-4)) + '</b>' +
        (me && me.signedIn ? ' · ' + esc(me.tier) : ' · not signed in');
    } else {
      pill.hidden = true;
    }
    $('connect').textContent = account ? 'Connected' : 'Connect wallet';
    $('connect').disabled = !!account;
    $('pay').disabled = !account;
    $('signin').disabled = !account || !SIGNIN_READY;
    // A disabled control with no reason beside it reads as a missing feature.
    $('signin').title = !SIGNIN_READY
      ? 'The server has no AUTH_SECRET set, so sign-in is disabled.'
      : (account ? 'Sign a message to prove this address.' : 'Connect a wallet first.');
    $('pay').title = account ? '' : 'Connect a wallet first.';
  }

  function refresh() {
    return fetch('/auth/me')
      .then(function (r) { return r.json(); })
      .then(paint)
      .catch(function () { paint(null); });
  }

  function signIn(silent) {
    if (!account || !SIGNIN_READY) return Promise.resolve();
    return fetch('/auth/nonce?address=' + encodeURIComponent(account))
      .then(function (r) { return r.json(); })
      .then(function (n) {
        if (!n.message) throw new Error('sign-in is not configured on this server');
        return window.ethereum.request({ method: 'personal_sign', params: [n.message, account] })
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
        return refresh();
      })
      .catch(function (e) { if (!silent) say('proout', e.message || 'sign-in failed', 'err'); });
  }

  function connect(interactive) {
    if (!window.ethereum) {
      if (interactive) say('proout', 'No wallet found in this browser.', 'err');
      return Promise.resolve();
    }
    // eth_accounts restores a prior connection without prompting; only an
    // explicit click may open the wallet dialog.
    var method = interactive ? 'eth_requestAccounts' : 'eth_accounts';
    return window.ethereum.request({ method: method })
      .then(function (accs) {
        if (!accs || !accs.length) return refresh();
        account = accs[0];
        return refresh().then(function () {
          // Signing straight after an explicit connect saves a second click.
          // Never on a silent restore: a wallet prompt on page load is rude.
          if (interactive) return signIn(false);
        });
      })
      .catch(function (e) { if (interactive) say('proout', e.message || 'connection refused', 'err'); });
  }

  $('connect').addEventListener('click', function () { connect(true); });

  function encodeTransfer(to, amount) {
    return '0xa9059cbb' + to.toLowerCase().replace(/^0x/, '').padStart(64, '0') +
      BigInt(amount).toString(16).padStart(64, '0');
  }

  $('pay').addEventListener('click', function () {
    if (!account) return;
    say('proout', 'Switching to Base…');
    window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] })
      .catch(function () {})
      .then(function () {
        say('proout', 'Confirm the transfer in your wallet…');
        return window.ethereum.request({
          method: 'eth_sendTransaction',
          params: [{ from: account, to: USDC, data: encodeTransfer(TREASURY, AMOUNT) }]
        });
      })
      .then(function (tx) {
        $('txhash').value = tx;
        say('proout', 'Sent ' + tx.slice(0, 12) + '… — wait a few seconds, then press Claim.');
      })
      .catch(function (e) { say('proout', e.message || 'payment cancelled', 'err'); });
  });

  $('claim').addEventListener('click', function () {
    var tx = $('txhash').value.trim();
    if (!tx) { say('proout', 'Paste the transaction hash first.', 'err'); return; }
    say('proout', 'Checking the transfer on Base…');
    fetch('/pro/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: tx })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { say('proout', j.error || 'claim failed', 'err'); return; }
        say('proout', 'Pro until ' + j.expiresAt.slice(0, 10) + ' for ' + j.address.slice(0, 10) + '…');
        return refresh();
      })
      .catch(function (e) { say('proout', e.message || 'claim failed', 'err'); });
  });

  $('linkfid').addEventListener('click', function () {
    var fid = $('fid').value.trim();
    if (!fid) { say('proout', 'Enter your Farcaster FID.', 'err'); return; }
    say('proout', 'Checking that this FID has verified your address…');
    fetch('/pro/link-fid', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fid: fid })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        say('proout', j.ok
          ? 'FID ' + j.fid + ' linked. Tag the agent and it will answer directly.'
          : (j.error || 'link failed'), j.ok ? '' : 'err');
      })
      .catch(function (e) { say('proout', e.message || 'link failed', 'err'); });
  });

  $('signin').addEventListener('click', function () { signIn(false); });

  // ---- ask: open to everyone, wallet or not -------------------------------
  function render(d) {
    var facts = JSON.stringify(d.facts, null, 2);
    var hasFacts = d.facts && Object.keys(d.facts).length > 0;
    $('out').innerHTML = '<div class="ans' + (d.answered ? '' : ' unans') + '">' +
      '<p>' + esc(d.answer) + '</p>' +
      '<div class="meta"><span>intent <code>' + esc(d.intent) + '</code></span>' +
      (d.symbol ? '<span>symbol <code>' + esc(d.symbol) + '</code></span>' : '') +
      '<span>reproduce <code>' + esc(d.reproduce) + '</code></span>' +
      (d.caller ? '<span>you <code>' + esc(d.caller.tier) + '</code></span>' : '') + '</div>' +
      (hasFacts ? '<details><summary>facts behind this answer</summary><pre><code>' +
        esc(facts) + '</code></pre></details>' : '') + '</div>';
  }

  function ask(q) {
    if (!q) return;
    $('go').disabled = true;
    $('out').innerHTML = '<div class="ans"><p style="color:var(--dim)">asking…</p></div>';
    fetch('/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: q })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j && res.j.error ? res.j.error : 'request failed');
        render(res.j);
      })
      .catch(function (e) { say('out', e.message || 'request failed', 'err'); })
      .then(function () { $('go').disabled = false; });
  }

  $('askform').addEventListener('submit', function (e) { e.preventDefault(); ask($('q').value.trim()); });
  $('chips').addEventListener('click', function (e) {
    var q = e.target && e.target.getAttribute('data-q');
    if (!q) return;
    $('q').value = q;
    ask(q);
  });

  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', function (accs) {
      account = accs && accs.length ? accs[0] : null;
      refresh();
    });
  }

  connect(false);
})();
`;
}

function page(s: Stats): string {
  const uncovered = s.tokens - s.feeds;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RH stock-pair oracle</title>
<meta name="description" content="Pricing and corporate-action data for Robinhood Chain (4663) pools paired against tokenized stocks. Uniswap v4 and v3.">
<style>${styles()}</style></head><body>

<header><div class="bar">
  <div class="brand"><span class="dot"></span>
    <span>RH stock-pair oracle<small>Robinhood Chain · 4663</small></span>
  </div>
  <span class="pill" id="tierpill" hidden></span>
  <button id="connect" class="primary">Connect wallet</button>
</div></header>

<main>

<h1>What is a token worth when it is priced in a stock?</h1>
<p class="lede">Pricing and corporate-action data for Robinhood Chain pools where one side is a
tokenized stock or ETF. Deterministic — no model sits in the data path.</p>

<div class="grid">
  <div class="stat"><b>${fmt(s.v4Pools + s.v3Pools)}</b><span>pools indexed</span></div>
  <div class="stat"><b>${fmt(s.v4Stock + s.v3Stock)}</b><span>stock-paired</span></div>
  <div class="stat"><b>${fmt(s.feeds)} / ${fmt(s.tokens)}</b><span>tokens with a feed</span></div>
  <div class="stat"><b>${fmt(s.actions)}</b><span>corporate actions</span></div>
</div>
<p class="meta-line">Uniswap v4 ${fmt(s.v4Pools)} · v3 ${fmt(s.v3Pools)}${
    s.lag ? ` · indexed to block ${fmt(s.lag)}` : ''
  } · read live at request time</p>

<h2>Ask it something</h2>
<div class="panel">
  <form id="askform" autocomplete="off">
    <label class="vh" for="q">Question</label>
    <div class="askrow">
      <input id="q" type="text" maxlength="500" placeholder="when is the next NVDA dividend?">
      <button type="submit" id="go" class="primary">Ask</button>
    </div>
  </form>
  <div class="chips" id="chips">
    <button type="button" data-q="how many pools quote NVDA?">pools quoting NVDA</button>
    <button type="button" data-q="what is the v3 v4 volume split?">v3 / v4 split</button>
    <button type="button" data-q="does TSLA have a chainlink feed?">TSLA feed</button>
    <button type="button" data-q="is the gas subsidy still active?">gas subsidy</button>
  </div>
  <div id="out" aria-live="polite"></div>
</div>

<p style="color:var(--dim);font-size:.9rem;margin-top:14px">Every answer carries the
<code>facts</code> behind it and a <code>reproduce</code> field naming the call that reproduces
it — so a caller can <em>verify</em> the answer rather than trust it. A question it cannot
classify says so. There is no fallback that guesses.</p>

<pre><code>curl -X POST https://oracle.sb4s.xyz/ask \\
  -H 'content-type: application/json' \\
  -d '{"question":"when is the next NVDA dividend?"}'</code></pre>

<h2>Pro</h2>
<div class="panel">
  <h3>$${paymentConfig.priceUsd} for ${paymentConfig.periodDays} days — does not auto-renew</h3>
  <p style="color:var(--dim);font-size:.9rem;margin:0">Tag the agent on Farcaster and get an
  answer straight back. Pay from your own wallet; the server reads the transfer off Base rather
  than trusting a receipt.</p>
  <ol>
    <li>Send <b>${formatUsdc(priceUnits())} USDC</b> on Base to the treasury.</li>
    <li>Claim — the server verifies the transfer on-chain.</li>
    <li>Link your Farcaster FID to use it when you tag the agent.</li>
  </ol>
  <div class="addr">${esc(paymentConfig.treasury)}</div>
  <div class="askrow" style="margin-top:14px">
    <button id="pay" class="primary" disabled>Pay ${formatUsdc(priceUnits())} USDC</button>
    <button id="signin" disabled>Sign in</button>
  </div>
  <div class="askrow" style="margin-top:8px">
    <input id="txhash" type="text" placeholder="0x… transaction hash, if you paid separately">
    <button type="button" id="claim">Claim</button>
  </div>
  <div class="askrow" style="margin-top:8px">
    <input id="fid" type="text" inputmode="numeric" placeholder="your Farcaster FID">
    <button type="button" id="linkfid">Link</button>
  </div>
  <div id="proout"></div>
</div>

<h2>Endpoints</h2>
<table>
<tr><th>Route</th><th>Returns</th><th>Price</th></tr>
${ROUTES.map(
  ([route, what, price]) =>
    `<tr><td><code>${esc(route)}</code></td><td>${esc(what)}</td><td>${
      price > 0 ? `$${price.toFixed(3)}` : 'free'
    }</td></tr>`,
).join('\n')}
</table>

<h2>What it will cost</h2>
<p>This is <strong>not a free service</strong>, and it is not advertised as one. It is in
<strong>${esc(pricingMode)} mode</strong>: every route is served without charge and no key is
required, while each response publishes what the call will cost once billing is enabled.</p>
<pre><code>x-oracle-price-usd: 0.01     what this route will cost
x-oracle-charged-usd: 0      what it cost you today
x-oracle-pricing: ${esc(pricingMode)}     the current mode</code></pre>

<h2>Read the labels</h2>
<div class="note">
<code>deviation: null</code> is normal and <strong>must never be read as zero</strong>:
${fmt(uncovered)} of ${fmt(s.tokens)} stock tokens have no Chainlink feed, so for those a
deviation is not merely unknown but unknowable on-chain. <code>depth</code> is an active-tick
estimate that can mislead — trust <code>impact</code>, which is a quoter simulation.
Nothing here signs, broadcasts, or holds funds.
</div>

<div class="note">
<strong>v3 is not a rounding error.</strong> Uniswap v3 carries roughly a third of stock-paired
volume here, and four of the five largest stock-paired pools by 24h volume are v3. Every other
RH data source indexes v4 alone.
</div>

<footer>
<a href="https://github.com/MeMikko/rh-stockpair-oracle">github.com/MeMikko/rh-stockpair-oracle</a>
</footer>
</main>
<script>${clientScript()}</script>
</body></html>`;
}

export function registerLanding(app: FastifyInstance): void {
  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'public, max-age=60');
    return page(readStats());
  });

  // Crawlers arrive within seconds of the certificate hitting the CT log. Let
  // them index the landing page and leave the priced endpoints alone -- a
  // crawler calling /quote costs an upstream RPC round trip and tells nobody
  // anything.
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
      'Disallow: /auth/',
      'Disallow: /pro',
      '',
    ].join('\n');
  });
}
