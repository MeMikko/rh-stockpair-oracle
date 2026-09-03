import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { ROUTE_PRICES, pricingMode } from '../../../config/pricing.js';
import { formatUsdc, paymentConfig, priceUnits, PAYMENT_CHAIN_ID } from '../../../config/payments.js';
import { authConfigured } from '../../auth/session.js';
import { agentIdentity } from '../../../config/agent.js';
import { serviceDescriptor } from './discovery.js';

/**
 * The page a human gets at the root.
 *
 * Until this existed the root returned a 404 JSON body, which is what every
 * person and crawler that found the domain saw -- and they find it fast, since
 * every certificate is published to Certificate Transparency within seconds.
 *
 * Server-rendered from live counts rather than written as a static page: the
 * numbers are the product, and a figure that might be a screenshot from last
 * month is worth less than no figure. Styles, script and the logo are inline
 * or first-party -- no external script, font or stylesheet -- so the page
 * cannot break behind a CDN and cannot leak a visitor to a third party. The
 * only two sub-resources are ours: /mark.svg (favicon) and /logo.jpg (social
 * preview, home-screen icon).
 *
 * **The look is the agent's own logo, taken seriously.** Navy plate, silver
 * and cyan blades, the ringed eye, the spark above it: the palette, the
 * concentric rings behind the hero and the spaced wordmark all come from that
 * one image. Dark is the native theme because the logo has a night sky in it;
 * the light theme is the same identity in ice rather than a second design.
 *
 * The ask box is open to everyone on purpose. Hiding it behind a wallet would
 * mean nobody could see the service work before committing one, and "other
 * agents call it" is the goal this page exists to serve. A wallet buys pro;
 * it is not the price of looking.
 *
 * **One wallet control, not five.** Connect, sign in, pay, paste a hash and
 * claim used to be five buttons a person had to sequence themselves. There is
 * only ever one next step, so there is one button and its label is that step.
 * Paying claims itself by polling -- a claim only fails for the few seconds
 * the transfer takes to bury itself -- and the manual hash box is folded away
 * for the person who paid from somewhere else.
 *
 * Layout is fluid rather than merely narrow-tolerant: tables become cards
 * under 680px, the header wraps to give the wallet button a full row on a
 * phone, and every control clears a 42px touch target.
 */

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The account's own logo, read once at boot.
 *
 * Served rather than inlined: at 91 KB a data URI would be pasted into every
 * HTML response, and this is wanted only by social-preview crawlers and the
 * home-screen icon. Read at module load so a missing file is a boot-time
 * problem rather than a 500 on the first crawler.
 */
const LOGO_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/vates-logo.jpg');
let logoBytes: Buffer | null = null;
try {
  logoBytes = readFileSync(LOGO_PATH);
} catch {
  // A deployment without the asset still serves the page: the inline mark is
  // the identity everywhere it matters, and the raster is only the preview.
  logoBytes = null;
}
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

/**
 * The Vates mark, drawn rather than fetched.
 *
 * The account's logo is a raster image on a navy plate: two tapered blades
 * forming a V, a ringed eye between them, a spark above. Inlined as SVG it
 * costs nothing per request, stays crisp at any size, and keeps the promise
 * that this page loads no external asset -- the photograph of it is served
 * separately at /logo.jpg for social previews, where a raster is what the
 * consumer wants.
 *
 * The navy plate is part of the identity rather than a background hack: it is
 * what lets the silver blades read on a light theme as well as a dark one.
 *
 * `id` prefixes the gradient ids. Two copies of this on one page with the same
 * ids would have the second silently reuse the first's paint.
 */
function mark(id: string, size: number, label?: string): string {
  const a = (n: string): string => `${id}-${n}`;
  return `<svg class="mk" width="${size}" height="${size}" viewBox="0 0 64 64" ${
    label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"'
  }>
<defs>
<linearGradient id="${a('silver')}" x1="0" y1="0" x2=".6" y2="1">
<stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#dbe7fb"/>
<stop offset="1" stop-color="#8fa3c8"/></linearGradient>
<linearGradient id="${a('cyan')}" x1="1" y1="0" x2=".4" y2="1">
<stop offset="0" stop-color="#f2fdff"/><stop offset=".5" stop-color="#8fe6ff"/>
<stop offset="1" stop-color="#2bb8e6"/></linearGradient>
<radialGradient id="${a('pupil')}">
<stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#bff2ff"/>
<stop offset="1" stop-color="#2bb8e6" stop-opacity="0"/></radialGradient>
<filter id="${a('glow')}" x="-60%" y="-60%" width="220%" height="220%">
<feGaussianBlur stdDeviation="1.6"/></filter>
</defs>
<rect width="64" height="64" rx="${Math.max(8, Math.round(size / 4.6))}" fill="#08101f"/>
<g stroke="#7fd8f5" fill="none" opacity=".28">
<circle cx="32" cy="26" r="14.5" stroke-width=".7"/>
<circle cx="32" cy="26" r="18" stroke-width=".5" stroke-dasharray="26 10"/>
</g>
<path d="M11 8 h6 l16.5 40.5 -1.9 7z" fill="url(#${a('silver')})"/>
<path d="M53 8 h-6 L30.5 48.5l1.9 7z" fill="url(#${a('cyan')})"/>
<path d="M14.6 10.5 32 52" stroke="#ffffff" stroke-width=".5" opacity=".45"/>
<path d="M49.4 10.5 32 52" stroke="#eaffff" stroke-width=".5" opacity=".45"/>
<path d="M22 26q10-8.5 20 0-10 8.5-20 0z" fill="#08101f" stroke="#cfe9f7" stroke-width=".9"/>
<circle cx="32" cy="26" r="4.6" fill="none" stroke="#dff4ff" stroke-width=".8"/>
<circle cx="32" cy="26" r="4" fill="url(#${a('pupil')})" filter="url(#${a('glow')})"/>
<circle cx="32" cy="26" r="1.5" fill="#ffffff"/>
<path d="M32 4.5 33.5 9.5 32 13 30.5 9.5z" fill="#dff4ff"/>
<path d="M32 13v5" stroke="#9fdcf2" stroke-width=".7"/>
</svg>`;
}

const ROUTES: Array<[string, string, number]> = [
  ['GET /quote', 'implied USD, depth, price impact, deviation, market hours — v4 poolId or v3 address', ROUTE_PRICES['/quote'] ?? 0],
  ['POST /prepare-swap', 'unsigned UniversalRouter calldata, min-out from the quoter (v4 pools)', ROUTE_PRICES['/prepare-swap'] ?? 0],
  ['GET /gas', 'chain 4663 gas, split into L2 and L1-data components', ROUTE_PRICES['/gas'] ?? 0],
  ['GET /price', "a stock's own USD price from its Chainlink feed", ROUTE_PRICES['/price'] ?? 0],
  ['GET /pools', 'pool counts per protocol, plus the top pool ids to quote', ROUTE_PRICES['/pools'] ?? 0],
  ['GET /volume', '24h stock-paired volume, with the window it was measured over', ROUTE_PRICES['/volume'] ?? 0],
  ['GET /corporate-actions', 'upcoming splits and dividends joined to affected pools', ROUTE_PRICES['/corporate-actions'] ?? 0],
  ['POST /ask', 'free-text question, structured answer', ROUTE_PRICES['/ask'] ?? 0],
  ['GET /coverage', 'which stock tokens have a Chainlink feed', 0],
  ['GET /health', 'index freshness: pool counts and cursors', 0],
];

function styles(): string {
  // One inline stylesheet, no external font or CSS: the page must render the
  // same behind any CDN and must not hand a visitor to a third party. Every
  // colour is a token so the dark theme is a redefinition rather than a second
  // set of rules that drifts.
  return `
:root{
/* Vates. Taken from the mark: a navy plate, silver blades, a cyan eye.
   Dark is the native theme -- the logo has a night sky in it -- and the light
   theme is the same identity in ice rather than a different design: navy ink
   on a blue-tinted white, with the cyan darkened to a teal that can be read
   on paper. Nothing here is a hue chosen for novelty. */
--bg:#f6f8fc;--bg-soft:#eef2f9;--panel:#fff;--panel-2:#f9fbfe;
--fg:#0b1424;--dim:#54637d;--faint:#8d9ab0;--line:#dde4ef;--line-soft:#e9eef6;
--acc:#0a6d8c;--acc-fg:#fff;--acc-soft:#e2f4fa;--acc-line:#b6e0ee;
--glow:rgba(43,184,230,.18);
--warn:#8a5a00;--danger:#b3261e;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--radius:12px;--radius-sm:9px;
--shadow:0 1px 2px rgba(11,20,36,.05),0 2px 10px rgba(11,20,36,.05);
--shadow-lift:0 2px 4px rgba(11,20,36,.06),0 14px 30px rgba(11,20,36,.09);
--ring:0 0 0 3px rgba(43,184,230,.35)}
@media(prefers-color-scheme:dark){:root{
--bg:#070c18;--bg-soft:#0c1424;--panel:#0d1526;--panel-2:#111b2e;
--fg:#e9f0fb;--dim:#93a4c0;--faint:#61738f;--line:#1c2a3f;--line-soft:#161f33;
--acc:#5cd6f5;--acc-fg:#04121c;--acc-soft:rgba(92,214,245,.12);--acc-line:rgba(92,214,245,.32);
--glow:rgba(92,214,245,.16);
--warn:#e0b060;--danger:#ff8a80;
--shadow:0 1px 2px rgba(0,0,0,.5);--shadow-lift:0 12px 34px rgba(0,0,0,.55);
--ring:0 0 0 3px rgba(92,214,245,.3)}}
*{box-sizing:border-box}
/* Must outrank the display rules below: .pill and .row both set a display, and
   a display beats the hidden attribute -- which showed the tier pill and the
   FID row to everyone regardless of state. */
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--fg);background:var(--bg);font:16px/1.65 var(--sans);
-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
/* The logo's own furniture, at the threshold of visible: the spark's glow, and
   the rings around the eye. On a fixed layer rather than on the body, because
   background-attachment:fixed is ignored on iOS and janky where it is not. */
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:
radial-gradient(720px 320px at 50% -140px,var(--glow),transparent 72%),
repeating-radial-gradient(circle at 50% -70px,transparent 0 118px,var(--glow) 118px 119px,transparent 119px 236px)}
.wrap{width:100%;max-width:960px;margin:0 auto;
padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right))}

/* ---- header ---------------------------------------------------------- */
header{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 88%,transparent);
backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
@supports not (backdrop-filter:blur(1px)){header{background:var(--bg)}}
.bar{display:flex;align-items:center;gap:10px 14px;padding:12px 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;margin-right:auto;min-width:0;
text-decoration:none;color:inherit}
.mk{flex:none;display:block}
.brand .mk{box-shadow:0 0 0 1px var(--line),0 0 22px -6px var(--glow)}
.brand-txt{min-width:0}
/* The wordmark, spaced the way the logo spaces it: thin, wide, unhurried. */
.wordmark{display:block;font-weight:300;font-size:.98rem;letter-spacing:.34em;
text-transform:uppercase;line-height:1.15;white-space:nowrap}
.brand-txt small{display:block;font-size:.72rem;color:var(--dim);white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;letter-spacing:.02em}

/* ---- controls -------------------------------------------------------- */
button{font:inherit;font-size:.9rem;cursor:pointer;border-radius:var(--radius-sm);
border:1px solid var(--line);background:var(--panel);color:var(--fg);
padding:10px 15px;min-height:42px;font-weight:500;
transition:border-color .14s,background .14s,transform .06s,box-shadow .14s}
button:hover:not([disabled]){border-color:var(--faint);background:var(--panel-2)}
button:active:not([disabled]){transform:translateY(1px)}
button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{
outline:none;box-shadow:var(--ring);border-radius:var(--radius-sm)}
button.primary{background:var(--acc);border-color:transparent;color:var(--acc-fg);font-weight:600}
button.primary:hover:not([disabled]){background:color-mix(in srgb,var(--acc) 88%,var(--fg));
border-color:transparent}
button.ghost{background:transparent;border-color:transparent;color:var(--dim);padding:8px 10px}
button.ghost:hover:not([disabled]){color:var(--fg);background:var(--bg-soft)}
button[disabled]{opacity:.5;cursor:not-allowed}
button.busy{color:transparent;position:relative}
button.busy::after{content:"";position:absolute;inset:0;margin:auto;width:15px;height:15px;
border:2px solid color-mix(in srgb,var(--acc-fg) 60%,transparent);border-top-color:var(--acc-fg);
border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition:none!important}}
input[type=text]{flex:1;min-width:0;padding:11px 13px;font:inherit;font-size:1rem;color:var(--fg);
background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-sm);min-height:42px}
input::placeholder{color:var(--faint)}
.row{display:flex;gap:8px;flex-wrap:wrap}
.row>button{flex:0 0 auto}

/* ---- status pill ----------------------------------------------------- */
.pill{display:inline-flex;align-items:center;gap:7px;font-size:.79rem;color:var(--dim);
background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 11px;
white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.pill b{color:var(--fg);font-weight:600;font-family:var(--mono);font-size:.76rem}
.pill.pro{background:var(--acc-soft);border-color:var(--acc-line);color:var(--acc)}
.pill.pro b{color:var(--acc)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--acc);flex:none}
.dot.idle{background:var(--faint)}

/* ---- layout ---------------------------------------------------------- */
main{padding:44px 0 88px}
.hero{display:flex;gap:28px;align-items:flex-start}
.hero-txt{min-width:0}
.hero .mk{margin-top:6px;box-shadow:0 0 0 1px var(--line),0 24px 60px -24px var(--glow)}
@media(max-width:720px){.hero{gap:18px}.hero .mk{width:64px;height:64px}}
@media(max-width:460px){.hero{display:block}.hero .mk{margin:0 0 16px}}
.eyebrow{font:400 .7rem/1 var(--mono);letter-spacing:.22em;text-transform:uppercase;
color:var(--acc);margin:0 0 14px}
h1{font-size:clamp(1.6rem,4.6vw,2.4rem);line-height:1.16;margin:0 0 12px;letter-spacing:-.03em;
font-weight:660;max-width:24ch}
h2{font-size:1.12rem;margin:52px 0 14px;letter-spacing:-.015em;font-weight:620;
display:flex;align-items:center;gap:9px}
/* The spark from the mark, small enough to be a rhythm rather than a motif. */
h2::before{content:"";width:5px;height:5px;flex:none;border-radius:50%;background:var(--acc);
box-shadow:0 0 10px 1px var(--glow)}
h3{font-size:1rem;margin:0 0 6px;font-weight:600}
.lede{color:var(--dim);font-size:1.05rem;margin:0 0 28px;max-width:60ch}
p{margin:0 0 12px}
.fine{color:var(--dim);font-size:.92rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
padding:15px 16px;box-shadow:var(--shadow);transition:box-shadow .16s,transform .16s}
.stat:hover{box-shadow:var(--shadow-lift);transform:translateY(-1px)}
.stat b{display:block;font-size:1.55rem;font-weight:660;letter-spacing:-.035em;
font-variant-numeric:tabular-nums;line-height:1.15}
.stat span{color:var(--dim);font-size:.8rem}
.meta-line{color:var(--faint);font-size:.82rem;margin:12px 0 0;font-variant-numeric:tabular-nums}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
padding:20px;box-shadow:var(--shadow)}
.panel+.panel{margin-top:12px}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 0}
.chips button{font-size:.82rem;color:var(--dim);background:var(--bg-soft);border-color:transparent;
padding:6px 12px;border-radius:999px;min-height:34px;font-weight:450}
.chips button:hover{color:var(--fg);background:var(--bg-soft);border-color:var(--line)}
.ans{background:var(--bg-soft);border:1px solid var(--line-soft);border-radius:var(--radius-sm);
padding:14px 16px;margin:14px 0 0}
.ans p{margin:0}
.ans .meta{color:var(--dim);font-size:.79rem;margin-top:12px;display:flex;flex-wrap:wrap;gap:6px 14px}
.ans details{margin-top:10px}
.ans summary{cursor:pointer;color:var(--dim);font-size:.79rem}
.unans{border-left:3px solid var(--faint)}
.err{border-left:3px solid var(--danger)}
.ok{border-left:3px solid var(--acc)}

/* ---- tables: rows on a phone, a table on a screen -------------------- */
table{width:100%;border-collapse:collapse;font-size:.9rem}
td,th{text-align:left;padding:10px 10px;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
box-shadow:var(--shadow);overflow:hidden}
.tbl td:first-child,.tbl th:first-child{padding-left:16px}
.tbl td:last-child,.tbl th:last-child{padding-right:16px}
@media(max-width:680px){
.tbl{background:transparent;border:0;box-shadow:none;overflow:visible}
.tbl thead{display:none}
.tbl tr{display:block;background:var(--panel);border:1px solid var(--line);
border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 14px;margin:0 0 10px}
.tbl td{display:block;border:0;padding:2px 0;text-align:left}
.tbl td:first-child,.tbl td:last-child{padding-left:0;padding-right:0}
.tbl td.num{text-align:left}
.tbl td::before{content:attr(data-label);display:block;font:500 .68rem/1.6 var(--sans);
text-transform:uppercase;letter-spacing:.06em;color:var(--faint)}
.tbl td:first-child::before{display:none}
}

/* ---- code, notes, footer -------------------------------------------- */
code{font-family:var(--mono);font-size:.86em;background:var(--bg-soft);border:1px solid var(--line-soft);
border-radius:5px;padding:1.5px 5px;overflow-wrap:anywhere}
pre{font-family:var(--mono);font-size:.83rem;background:var(--panel);border:1px solid var(--line);
border-radius:var(--radius);padding:15px 16px;overflow-x:auto;margin:12px 0;box-shadow:var(--shadow);
-webkit-overflow-scrolling:touch}
pre code{background:none;border:0;padding:0}
a{color:var(--acc);text-underline-offset:2px;text-decoration-thickness:1px}
.note{border-left:3px solid var(--line);padding:2px 0 2px 16px;color:var(--dim);margin:16px 0}
.note strong{color:var(--fg)}
.addr{font-family:var(--mono);font-size:.8rem;word-break:break-all;background:var(--bg-soft);
border:1px solid var(--line-soft);border-radius:var(--radius-sm);padding:10px 12px;margin:10px 0 0;
display:flex;gap:10px;align-items:center;justify-content:space-between}
.addr button{flex:none}
ol{margin:14px 0 0;padding-left:20px;color:var(--dim);font-size:.9rem}
ol li{margin:6px 0}
details.more{margin:12px 0 0;border-top:1px solid var(--line-soft);padding-top:12px}
details.more summary{cursor:pointer;color:var(--dim);font-size:.85rem;list-style:none}
details.more summary::-webkit-details-marker{display:none}
details.more summary::before{content:"＋ ";color:var(--faint)}
details.more[open] summary::before{content:"− "}
details.more>*+*{margin-top:8px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
footer{margin-top:64px;padding:22px 0 0;border-top:1px solid var(--line);color:var(--faint);
font-size:.85rem}
footer a{color:var(--dim)}
@media(max-width:560px){
main{padding:32px 0 64px}
h2{margin:40px 0 12px}
.bar{padding:10px 0}
#wallet{width:100%;order:3}
.pill{order:2}
}
`;
}

function clientScript(): string {
  // Plain window.ethereum, on purpose: a connector library would be the only
  // third-party script on this page, and this needs five RPC methods.
  //
  // The flow used to be five controls -- connect, sign in, pay, paste hash,
  // claim -- and a person had to know the order. It is now ONE control that
  // names the next step, because there is only ever one next step: connect,
  // then sign in, then pay. Paying claims itself by polling, since a claim
  // only fails for a few seconds while the transfer confirms; the manual hash
  // box survives, folded away, for the person who paid from elsewhere.
  return `
(function () {
  var SIGNIN_READY = ${authConfigured() ? 'true' : 'false'};
  var TREASURY = ${JSON.stringify(paymentConfig.treasury)};
  var USDC = ${JSON.stringify(paymentConfig.usdc)};
  var AMOUNT = ${JSON.stringify(priceUnits().toString())};
  var AMOUNT_LABEL = ${JSON.stringify(formatUsdc(priceUnits()))};
  var CHAIN_HEX = ${JSON.stringify('0x' + PAYMENT_CHAIN_ID.toString(16))};

  var S = { account: null, tier: 'free', signedIn: false, busy: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; });
  }
  function say(el, msg, cls) {
    $(el).innerHTML = '<div class="ans ' + (cls || '') + '"><p>' + esc(msg) + '</p></div>';
  }
  function clear(el) { $(el).innerHTML = ''; }
  function short(a) { return a.slice(0, 6) + '…' + a.slice(-4); }
  function busy(on) {
    S.busy = on;
    $('wallet').classList.toggle('busy', on);
    render();
  }

  /**
   * One button, one next step. The label IS the instruction, so nothing has to
   * explain the order elsewhere on the page.
   */
  function step() {
    if (!window.ethereum) return { label: 'No wallet detected', act: null,
      hint: 'Install a browser wallet, or use the API directly — none of this is needed to read.' };
    if (!S.account) return { label: 'Connect wallet', act: connect,
      hint: 'Connecting only proves an address. It authorises no transaction.' };
    if (!S.signedIn && SIGNIN_READY) return { label: 'Sign in', act: signIn,
      hint: 'Sign a message to prove this address. No transaction, no approval.' };
    if (S.tier === 'pro') return { label: 'Pro active', act: null,
      hint: 'Tag the agent on Farcaster and it answers you directly.' };
    return { label: 'Get pro · ' + AMOUNT_LABEL + ' USDC', act: pay,
      hint: 'One USDC transfer on Base. It does not auto-renew.' };
  }

  function render() {
    var st = step();
    var b = $('wallet');
    b.textContent = st.label;
    b.disabled = S.busy || !st.act;
    b.className = st.act ? 'primary' : '';
    b.title = st.hint;
    $('walletHint').textContent = st.hint;

    var pill = $('tierpill');
    pill.hidden = !S.account;
    if (S.account) {
      pill.className = 'pill' + (S.tier === 'pro' ? ' pro' : '');
      pill.innerHTML = '<span class="dot' + (S.signedIn ? '' : ' idle') + '"></span><b>' +
        esc(short(S.account)) + '</b>' + (S.signedIn ? ' ' + esc(S.tier) : ' not signed in');
    }
    // The FID row is only meaningful once pro is live, and an input that
    // cannot do anything yet is worse than one that is not there.
    $('fidrow').hidden = S.tier !== 'pro';
  }

  function refresh() {
    return fetch('/auth/me')
      .then(function (r) { return r.json(); })
      .then(function (me) {
        S.tier = (me && me.tier) || 'free';
        S.signedIn = !!(me && me.signedIn);
      })
      .catch(function () { S.tier = 'free'; S.signedIn = false; })
      .then(render);
  }

  function connect() {
    return ask('eth_requestAccounts').then(function (accs) {
      if (!accs || !accs.length) return;
      S.account = accs[0];
      // Sign in straight after connecting: it is the next step either way, and
      // two prompts a person expected beat two clicks they did not.
      return refresh().then(function () { if (SIGNIN_READY) return signIn(); });
    });
  }

  function signIn() {
    if (!S.account || !SIGNIN_READY) return Promise.resolve();
    return fetch('/auth/nonce?address=' + encodeURIComponent(S.account))
      .then(function (r) { return r.json(); })
      .then(function (n) {
        if (!n.message) throw new Error('sign-in is not configured on this server');
        return ask('personal_sign', [n.message, S.account]).then(function (sig) {
          if (!sig) return;
          return fetch('/auth/verify', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address: S.account, signature: sig, nonce: n.nonce })
          }).then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok) throw new Error(j.error || 'sign-in failed');
              return refresh();
            });
          });
        });
      });
  }

  function encodeTransfer(to, amount) {
    return '0xa9059cbb' + to.toLowerCase().replace(/^0x/, '').padStart(64, '0') +
      BigInt(amount).toString(16).padStart(64, '0');
  }

  /** Claim, retrying while the transfer buries itself deep enough to count. */
  function claim(tx, tries) {
    return fetch('/pro/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txHash: tx })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok) {
          say('proout', 'Pro until ' + j.expiresAt.slice(0, 10) + '. Link your Farcaster FID ' +
            'below to be answered directly when you tag the agent.', 'ok');
          return refresh();
        }
        if (tries > 0) {
          // Not an error yet: the server waits for confirmations, so the first
          // few attempts are expected to say "not confirmed".
          say('proout', 'Waiting for the transfer to confirm on Base… (' + j.error + ')');
          return new Promise(function (res) { setTimeout(res, 4000); })
            .then(function () { return claim(tx, tries - 1); });
        }
        say('proout', j.error + ' — the hash is saved below; press Claim again in a minute.', 'err');
        $('txhash').value = tx;
        $('paidElsewhere').open = true;
      });
  }

  function pay() {
    if (!S.account) return Promise.resolve();
    say('proout', 'Confirm the transfer in your wallet…');
    return ask('wallet_switchEthereumChain', [{ chainId: CHAIN_HEX }])
      .catch(function () { /* already on Base, or the wallet cannot switch */ })
      .then(function () {
        return ask('eth_sendTransaction',
          [{ from: S.account, to: USDC, data: encodeTransfer(TREASURY, AMOUNT) }]);
      })
      .then(function (tx) {
        if (!tx) return;
        say('proout', 'Sent ' + tx.slice(0, 12) + '… — checking Base for it.');
        return claim(tx, 12);
      });
  }

  /**
   * Every wallet call goes through here, so a rejection is reported once and
   * the button is never left spinning. A user cancelling is not an error and
   * says nothing.
   */
  function ask(method, params) {
    busy(true);
    return window.ethereum.request({ method: method, params: params })
      .catch(function (e) {
        if (e && (e.code === 4001 || /reject|denied|cancel/i.test(e.message || ''))) {
          clear('proout');
          return null;
        }
        say('proout', (e && e.message) || 'the wallet refused that request', 'err');
        return null;
      })
      .then(function (v) { busy(false); return v; });
  }

  $('wallet').addEventListener('click', function () {
    var st = step();
    if (st.act) st.act();
  });

  $('claim').addEventListener('click', function () {
    var tx = $('txhash').value.trim();
    if (!tx) { say('proout', 'Paste the transaction hash first.', 'err'); return; }
    say('proout', 'Checking the transfer on Base…');
    claim(tx, 3);
  });

  $('linkfid').addEventListener('click', function () {
    var fid = $('fid').value.trim();
    if (!fid) { say('proout', 'Enter your Farcaster FID.', 'err'); return; }
    say('proout', 'Linking…');
    fetch('/pro/link-fid', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fid: fid })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        say('proout', j.ok
          ? 'FID ' + j.fid + ' linked' + (j.verified ? ' (address verified on Farcaster)' : '') +
            '. Tag the agent and it will answer directly.' +
            (j.replaced ? ' Replaced FID ' + j.replaced + '.' : '')
          : (j.error || 'link failed'), j.ok ? 'ok' : 'err');
      })
      .catch(function (e) { say('proout', (e && e.message) || 'link failed', 'err'); });
  });

  $('copyaddr').addEventListener('click', function () {
    var btn = this;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(TREASURY).then(done, function () {});
    else done();
  });

  // ---- ask: open to everyone, wallet or not -------------------------------
  function render_answer(d) {
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

  function askQuestion(q) {
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
        render_answer(res.j);
      })
      .catch(function (e) { say('out', (e && e.message) || 'request failed', 'err'); })
      .then(function () { $('go').disabled = false; });
  }

  $('askform').addEventListener('submit', function (e) {
    e.preventDefault();
    askQuestion($('q').value.trim());
  });
  $('chips').addEventListener('click', function (e) {
    var q = e.target && e.target.getAttribute('data-q');
    if (!q) return;
    $('q').value = q;
    askQuestion(q);
  });

  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', function (accs) {
      S.account = accs && accs.length ? accs[0] : null;
      refresh();
    });
  }

  // Restore a prior connection without prompting: eth_accounts never opens a
  // dialog, and a wallet popup on page load is rude.
  if (window.ethereum) {
    window.ethereum.request({ method: 'eth_accounts' })
      .then(function (accs) { if (accs && accs.length) S.account = accs[0]; })
      .catch(function () {})
      .then(refresh);
  } else {
    render();
  }
})();
`;
}

function page(s: Stats): string {
  const uncovered = s.tokens - s.feeds;
  const price = (p: number): string => (p > 0 ? `$${p.toFixed(2)}` : 'free');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f8fc" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#070c18" media="(prefers-color-scheme:dark)">
<title>${esc(agentIdentity.name)} — RH stock-pair oracle</title>
<link rel="icon" type="image/svg+xml" href="/mark.svg">
<link rel="apple-touch-icon" href="/logo.jpg">
<meta property="og:title" content="${esc(agentIdentity.name)} — stock-pair oracle for Robinhood Chain">
<meta property="og:description" content="Implied price, depth, Chainlink deviation and corporate actions for RH pools paired against tokenized stocks. Uniswap v4 and v3.">
<meta property="og:image" content="/logo.jpg">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="description" content="Pricing and corporate-action data for Robinhood Chain (4663) pools paired against tokenized stocks. Uniswap v4 and v3.">
<style>${styles()}</style></head><body>

<header><div class="wrap bar">
  <a class="brand" href="/">
    ${mark('hd', 34, `${agentIdentity.name} logo`)}
    <span class="brand-txt">
      <span class="wordmark">${esc(agentIdentity.name)}</span>
      <small>stock-pair oracle · Robinhood Chain 4663</small>
    </span>
  </a>
  <span class="pill" id="tierpill" hidden></span>
  <button id="wallet" class="primary">Connect wallet</button>
</div></header>

<main class="wrap">

<div class="hero">
  ${mark('hero', 88)}
  <div class="hero-txt">
    <p class="eyebrow">Uniswap v4 + v3 · deterministic</p>
    <h1>What is a token worth when it is priced in a stock?</h1>
    <p class="lede">Pricing and corporate-action data for Robinhood Chain pools where one side is
    a tokenized stock or ETF. No model sits in the data path, and every answer carries the numbers
    behind it.</p>
  </div>
</div>

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
    <div class="row">
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

<p class="fine" style="margin-top:14px">Every answer carries the <code>facts</code> behind it and a
<code>reproduce</code> field naming the call that reproduces it — so a caller can <em>verify</em>
the answer rather than trust it. A question it cannot classify says so. There is no fallback that
guesses.</p>

<pre><code>curl -X POST https://oracle.sb4s.xyz/ask \\
  -H 'content-type: application/json' \\
  -d '{"question":"when is the next NVDA dividend?"}'</code></pre>

<h2>Pro</h2>
<div class="panel">
  <h3>$${paymentConfig.priceUsd} for ${paymentConfig.periodDays} days — does not auto-renew</h3>
  <p class="fine" style="margin:0">Tag the agent on Farcaster and get an answer straight back. Pay
  from your own wallet; the server reads the transfer off Base rather than trusting a receipt.</p>

  <p class="fine" id="walletHint" style="margin:14px 0 0"></p>
  <p class="fine" style="margin:6px 0 0">Use the button at the top of the page — it always names
  the one next step: connect, sign in, then pay.</p>

  <div class="addr"><span>${esc(paymentConfig.treasury)}</span>
    <button type="button" id="copyaddr" class="ghost">Copy</button></div>
  <p class="fine" style="margin:6px 0 0">Treasury on Base. ${esc(formatUsdc(priceUnits()))} USDC
  buys ${paymentConfig.periodDays} days.</p>

  <div id="proout" aria-live="polite"></div>

  <div class="row" id="fidrow" hidden style="margin-top:12px">
    <input id="fid" type="text" inputmode="numeric" placeholder="your Farcaster FID">
    <button type="button" id="linkfid">Link FID</button>
  </div>

  <details class="more" id="paidElsewhere">
    <summary>Paid from another wallet or app?</summary>
    <p class="fine" style="margin:0">Paste the transaction hash and the server will verify it
    on-chain. The address that <em>sent</em> the USDC is the one entitled.</p>
    <div class="row">
      <input id="txhash" type="text" placeholder="0x… transaction hash">
      <button type="button" id="claim">Claim</button>
    </div>
  </details>
</div>

<h2>Endpoints</h2>
<div class="tbl"><table>
<thead><tr><th>Route</th><th>Returns</th><th class="num">Price</th></tr></thead>
<tbody>
${ROUTES.map(
  ([route, what, p]) =>
    `<tr><td data-label="Route"><code>${esc(route)}</code></td>` +
    `<td data-label="Returns">${esc(what)}</td>` +
    `<td class="num" data-label="Price">${price(p)}</td></tr>`,
).join('\n')}
</tbody>
</table></div>

<h2>What it will cost</h2>
<p>This is <strong>not a free service</strong>, and it is not advertised as one. It is in
<strong>${esc(pricingMode)} mode</strong>: every route is served without charge and no key is
required, while each response publishes what the call will cost once billing is enabled. One
price for every priced route, because the payment gateway prices an endpoint rather than a
route.</p>
<pre><code>x-oracle-price-usd: 0.02     what this route will cost
x-oracle-charged-usd: 0      what it cost you today
x-oracle-pricing: ${esc(pricingMode)}     the current mode</code></pre>

<h2>Access and payment</h2>
<p>Five ways in, all live today. In <strong>${esc(pricingMode)} mode</strong> none is required
yet — every route is served without charge — but each already works, and the machine-readable
description at <code>/.well-known/agent.json</code> carries the details.</p>
<div class="tbl"><table>
<thead><tr><th>Method</th><th>For</th><th>How</th></tr></thead>
<tbody>
<tr><td data-label="Method">Bankr x402 gateway</td>
<td data-label="For">agents that already pay through Bankr</td>
<td data-label="How">Call the service at Bankr's URL instead of here. Bankr issues the 402, takes
the USDC on Base and forwards the paid request to this origin. Same routes, same responses; the
payment is between you and Bankr. The address is in <code>/.well-known/agent.json</code>.</td></tr>
<tr><td data-label="Method"><code>x402</code>, scheme <code>exact</code></td>
<td data-label="For">agents paying this origin directly</td>
<td data-label="How">The published protocol: call a priced route with no credential →
<code>402</code> listing what to pay, sign an EIP-3009 authorization, retry with it base64-encoded
in <code>x-payment</code>. Any standard client — <code>x402-fetch</code> — already does this, and
the facilitator pays the gas.</td></tr>
<tr><td data-label="Method"><code>x402</code>, prepaid credit</td>
<td data-label="For">callers that would rather transfer once</td>
<td data-label="How">Send USDC on Base to the treasury and <code>POST /x402/topup {"txHash"}</code>.
Any amount, no minimum; each call debits its own price. Balance:
<code>GET /x402/balance?payer=0x…</code>.</td></tr>
<tr><td data-label="Method">wallet signature</td><td data-label="For">session-based access</td>
<td data-label="How"><code>GET /auth/nonce</code> → sign → <code>POST /auth/verify</code> →
bearer token.</td></tr>
<tr><td data-label="Method">pro</td><td data-label="For">Farcaster answers + unmetered</td>
<td data-label="How">${formatUsdc(priceUnits())} USDC for ${paymentConfig.periodDays} days, then
<code>POST /pro/claim</code>.</td></tr>
</tbody>
</table></div>

<h2>Read the labels</h2>
<div class="note">
<code>deviation: null</code> is normal and <strong>must never be read as zero</strong>:
${fmt(uncovered)} of ${fmt(s.tokens)} stock tokens have no Chainlink feed, so for those a
deviation is not merely unknown but unknowable on-chain. <code>depth</code> is an active-tick
estimate that can mislead — trust <code>impact</code>, which is a quoter simulation.
Nothing here signs, broadcasts, or holds your funds.
</div>

<div class="note">
<strong>v3 is not a rounding error.</strong> Uniswap v3 carries roughly a third of stock-paired
volume here, and four of the five largest stock-paired pools by 24h volume are v3. Every other
RH data source indexes v4 alone — and <code>/quote</code> here takes a v3 pool address as
readily as a v4 poolId.
</div>

<footer>
<span class="wordmark" style="font-size:.8rem;color:var(--dim);margin-bottom:10px">${esc(
    agentIdentity.name,
  )}</span>
<a href="https://github.com/MeMikko/rh-stockpair-oracle">github.com/MeMikko/rh-stockpair-oracle</a>
 · <a href="${esc(agentIdentity.farcasterUrl)}">@${esc(agentIdentity.farcasterHandle)} on Farcaster</a>
 — tag it there and, with pro, it answers directly.
</footer>
</main>
<script>${clientScript()}</script>
</body></html>`;
}

export function registerLanding(app: FastifyInstance): void {
  app.get('/', async (req, reply) => {
    // An agent that asks for JSON gets the service description rather than a
    // page it cannot read. The previous behaviour returned HTML to everyone,
    // which is why two external test runs concluded the auth methods did not
    // exist -- they were documented only in markup.
    const accept = String(req.headers.accept ?? '');
    if (accept.includes('application/json') && !accept.includes('text/html')) {
      reply.header('cache-control', 'public, max-age=300');
      return serviceDescriptor();
    }
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'public, max-age=60');
    return page(readStats());
  });

  // The raster logo, for social previews and the iOS home screen. Immutable:
  // it changes when the brand does, which is not on a cache's timescale.
  app.get('/logo.jpg', async (_req, reply) => {
    if (!logoBytes) return reply.code(404).send({ error: 'no logo asset in this deployment' });
    reply.header('content-type', 'image/jpeg');
    reply.header('cache-control', 'public, max-age=604800, immutable');
    return logoBytes;
  });

  // The drawn mark, as a file, so the favicon is the same drawing the page
  // uses rather than a second one that drifts from it.
  app.get('/mark.svg', async (_req, reply) => {
    reply.header('content-type', 'image/svg+xml; charset=utf-8');
    reply.header('cache-control', 'public, max-age=604800, immutable');
    return mark('fav', 64, `${agentIdentity.name} logo`).replace(
      '<svg class="mk"',
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
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
      'Allow: /logo.jpg',
      'Allow: /mark.svg',
      'Disallow: /quote',
      'Disallow: /prepare-swap',
      'Disallow: /gas',
      'Disallow: /ask',
      'Disallow: /price',
      'Disallow: /pools',
      'Disallow: /volume',
      'Disallow: /corporate-actions',
      'Disallow: /webhooks/',
      'Disallow: /auth/',
      'Disallow: /pro',
      '',
    ].join('\n');
  });
}
