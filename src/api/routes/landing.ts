import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { ROUTE_PRICES, pricingMode } from '../../../config/pricing.js';

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
<pre><code>curl -X POST https://oracle.sb4s.xyz/ask \\
  -H 'content-type: application/json' \\
  -d '{"question":"when is the next NVDA dividend?"}'</code></pre>
<p>Every answer carries the <code>facts</code> behind it and a <code>reproduce</code> field
naming the call that reproduces it — so a caller can <em>verify</em> the answer rather than
trust it. A question it cannot classify returns <code>answered: false</code> and says what it
does know. There is no fallback that guesses.</p>

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

</div></body></html>`;
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
      '',
    ].join('\n');
  });
}
