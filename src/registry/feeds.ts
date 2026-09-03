import { getDb } from '../db/index.js';

/**
 * Chainlink's reference-data-directory is the documented source of truth for
 * feed addresses; RH's own docs tell you to read it rather than hardcode.
 */
const FEEDS_URL = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';

export type FeedKind = 'stock' | 'reference';

export interface Feed {
  symbol: string;
  proxyAddress: string;
  secondaryProxy: string | null;
  decimals: number;
  heartbeat: number;
  threshold: number;
  marketHours: string | null;
  name: string;
  /**
   * What the feed is for. 'stock' is a Robinhood equity feed and counts toward
   * /coverage; 'reference' exists only to price the other side of a pool.
   */
  kind: FeedKind;
}

interface RawFeed {
  name: string;
  proxyAddress: string;
  secondaryProxyAddress?: string;
  decimals: number;
  heartbeat: number;
  threshold: number;
  docs?: { marketHours?: string };
}

/**
 * Feed names are not consistently formatted ("Robinhood AAPL / USD",
 * "RHSPY / USD", "Robinhood SGOV-USD"), so normalise rather than trusting one shape.
 */
export function feedSymbol(name: string): string {
  return name
    .replace(/^Robinhood\s+/i, '')
    .replace(/^RH/, '')
    .replace(/[-/\s]+USD.*$/i, '')
    .trim();
}

/**
 * ETH/USD, kept as a reference rather than as coverage.
 *
 * The `^Robinhood|^RH` filter below is right for equity feeds and was quietly
 * wrong for everything else: a stock/WETH pool has a perfectly good USD
 * reference on the other side, and this registry excluded it by construction.
 * Two of the twenty busiest stock-paired pools were therefore unmeasurable for
 * a reason that was ours rather than the chain's — and since history cannot be
 * backfilled, every day of that was a day of those pools nobody can recover.
 *
 * Matched on the name, not the symbol, because the symbol is derived from the
 * name. Deliberately narrow: this is the one non-equity feed this service has
 * a use for, and a loose pattern would start counting feeds as coverage.
 */
const ETH_USD_NAME = /^\s*(?:w?eth)\s*[-/]\s*usd\s*$/i;

export async function fetchFeeds(): Promise<Feed[]> {
  const res = await fetch(FEEDS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`feeds fetch failed: ${res.status}`);
  const raw = (await res.json()) as RawFeed[];

  const map = (f: RawFeed, symbol: string, kind: FeedKind): Feed => ({
    symbol,
    proxyAddress: f.proxyAddress,
    secondaryProxy: f.secondaryProxyAddress ?? null,
    decimals: f.decimals,
    heartbeat: f.heartbeat,
    threshold: f.threshold,
    marketHours: f.docs?.marketHours ?? null,
    name: f.name,
    kind,
  });

  const stock = raw
    .filter((f) => /^Robinhood\s|^RH/i.test(f.name ?? ''))
    .map((f) => map(f, feedSymbol(f.name), 'stock'))
    .filter((f) => f.symbol.length > 0);

  // Absent on a chain that publishes no ETH/USD feed, and then nothing changes:
  // the WETH branch keeps returning its honest "no reference" reason.
  const eth = raw
    .filter((f) => !/^Robinhood\s|^RH/i.test(f.name ?? '') && ETH_USD_NAME.test(f.name ?? ''))
    .slice(0, 1)
    .map((f) => map(f, 'ETH', 'reference'));

  return [...stock, ...eth];
}

export function saveFeeds(feeds: Feed[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO feeds (symbol, proxy_address, secondary_proxy, decimals, heartbeat,
                        threshold, market_hours, name, kind, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       proxy_address=excluded.proxy_address, secondary_proxy=excluded.secondary_proxy,
       decimals=excluded.decimals, heartbeat=excluded.heartbeat,
       threshold=excluded.threshold, market_hours=excluded.market_hours,
       name=excluded.name, kind=excluded.kind, synced_at=excluded.synced_at`,
  );
  const now = Date.now();
  db.exec('BEGIN');
  for (const f of feeds) {
    stmt.run(f.symbol, f.proxyAddress, f.secondaryProxy, f.decimals, f.heartbeat,
             f.threshold, f.marketHours, f.name, f.kind, now);
  }
  db.exec('COMMIT');
}

function rowToFeed(r: Record<string, unknown>): Feed {
  return {
    symbol: String(r.symbol),
    proxyAddress: String(r.proxy_address),
    secondaryProxy: r.secondary_proxy ? String(r.secondary_proxy) : null,
    decimals: Number(r.decimals),
    heartbeat: Number(r.heartbeat),
    threshold: Number(r.threshold),
    marketHours: r.market_hours ? String(r.market_hours) : null,
    name: String(r.name),
    kind: (String(r.kind ?? 'stock') === 'reference' ? 'reference' : 'stock') as FeedKind,
  };
}

/**
 * Equity feeds only.
 *
 * Reference feeds are excluded on purpose: /coverage is computed from this,
 * and an ETH/USD feed is not coverage of a stock token. Counting it would
 * inflate the one number this service publishes about its own limits.
 */
export function loadFeeds(): Feed[] {
  const rows = getDb()
    .prepare("SELECT * FROM feeds WHERE kind = 'stock'")
    .all() as Record<string, unknown>[];
  return rows.map(rowToFeed);
}

/** Every feed, whatever it is for. For diagnostics, not for coverage. */
export function loadAllFeeds(): Feed[] {
  return (getDb().prepare('SELECT * FROM feeds').all() as Record<string, unknown>[]).map(rowToFeed);
}

/**
 * A feed kept to price the other side of a pool, never to answer about a stock.
 * Separate from `feedFor` so a reference row can never satisfy a stock lookup.
 */
export function referenceFeed(symbol: string): Feed | null {
  const row = getDb()
    .prepare("SELECT * FROM feeds WHERE symbol = ? AND kind = 'reference'")
    .get(symbol) as Record<string, unknown> | undefined;
  return row ? rowToFeed(row) : null;
}

/**
 * The equity feed for a stock symbol.
 *
 * Scoped to `kind = 'stock'` so a reference feed can never be returned here.
 * If a chain ever published an equity named ETH, the two rows would otherwise
 * collide and /price would answer about the wrong asset.
 */
export function feedFor(symbol: string): Feed | null {
  const row = getDb()
    .prepare("SELECT * FROM feeds WHERE symbol = ? AND kind = 'stock'")
    .get(symbol) as Record<string, unknown> | undefined;
  return row ? rowToFeed(row) : null;
}
