import { getDb } from '../db/index.js';

/**
 * Chainlink's reference-data-directory is the documented source of truth for
 * feed addresses; RH's own docs tell you to read it rather than hardcode.
 */
const FEEDS_URL = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';

export interface Feed {
  symbol: string;
  proxyAddress: string;
  secondaryProxy: string | null;
  decimals: number;
  heartbeat: number;
  threshold: number;
  marketHours: string | null;
  name: string;
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

export async function fetchFeeds(): Promise<Feed[]> {
  const res = await fetch(FEEDS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`feeds fetch failed: ${res.status}`);
  const raw = (await res.json()) as RawFeed[];

  return raw
    .filter((f) => /^Robinhood\s|^RH/i.test(f.name ?? ''))
    .map((f) => ({
      symbol: feedSymbol(f.name),
      proxyAddress: f.proxyAddress,
      secondaryProxy: f.secondaryProxyAddress ?? null,
      decimals: f.decimals,
      heartbeat: f.heartbeat,
      threshold: f.threshold,
      marketHours: f.docs?.marketHours ?? null,
      name: f.name,
    }))
    .filter((f) => f.symbol.length > 0);
}

export function saveFeeds(feeds: Feed[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO feeds (symbol, proxy_address, secondary_proxy, decimals, heartbeat,
                        threshold, market_hours, name, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       proxy_address=excluded.proxy_address, secondary_proxy=excluded.secondary_proxy,
       decimals=excluded.decimals, heartbeat=excluded.heartbeat,
       threshold=excluded.threshold, market_hours=excluded.market_hours,
       name=excluded.name, synced_at=excluded.synced_at`,
  );
  const now = Date.now();
  db.exec('BEGIN');
  for (const f of feeds) {
    stmt.run(f.symbol, f.proxyAddress, f.secondaryProxy, f.decimals, f.heartbeat,
             f.threshold, f.marketHours, f.name, now);
  }
  db.exec('COMMIT');
}

export function loadFeeds(): Feed[] {
  const rows = getDb().prepare('SELECT * FROM feeds').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    symbol: String(r.symbol),
    proxyAddress: String(r.proxy_address),
    secondaryProxy: r.secondary_proxy ? String(r.secondary_proxy) : null,
    decimals: Number(r.decimals),
    heartbeat: Number(r.heartbeat),
    threshold: Number(r.threshold),
    marketHours: r.market_hours ? String(r.market_hours) : null,
    name: String(r.name),
  }));
}

export function feedFor(symbol: string): Feed | null {
  const row = getDb().prepare('SELECT * FROM feeds WHERE symbol = ?').get(symbol) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    symbol: String(row.symbol),
    proxyAddress: String(row.proxy_address),
    secondaryProxy: row.secondary_proxy ? String(row.secondary_proxy) : null,
    decimals: Number(row.decimals),
    heartbeat: Number(row.heartbeat),
    threshold: Number(row.threshold),
    marketHours: row.market_hours ? String(row.market_hours) : null,
    name: String(row.name),
  };
}
