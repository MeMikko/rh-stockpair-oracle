import { getDb } from '../db/index.js';

const ASSETS_URL = 'https://api.robinhood.com/rhj/assets';

export interface StockToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isin: string | null;
  currentMultiplier: string;
  pendingMultiplier: string | null;
  status: string;
}

interface RawAsset {
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  isin?: string;
  currentMultiplier: string;
  pendingMultiplier: string;
  status: string;
  deployments: { contractAddress: string; chainId: number }[];
}

/**
 * Robinhood's own asset endpoint is the only authoritative list of canonical
 * stock tokens -- the docs warn explicitly that same-named tokens at other
 * addresses are not official, so we never accept a token from any other source.
 */
export async function fetchStockTokens(): Promise<StockToken[]> {
  const res = await fetch(ASSETS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`assets fetch failed: ${res.status}`);
  const body = (await res.json()) as { assets: RawAsset[] };

  return body.assets.flatMap((a) => {
    const dep = a.deployments.find((d) => d.chainId === 4663);
    if (!dep) return [];
    return [
      {
        address: dep.contractAddress.toLowerCase(),
        symbol: a.tokenSymbol,
        name: a.tokenName,
        decimals: a.tokenDecimals,
        isin: a.isin ?? null,
        currentMultiplier: a.currentMultiplier,
        pendingMultiplier: a.pendingMultiplier || null,
        status: a.status,
      },
    ];
  });
}

export function saveStockTokens(tokens: StockToken[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO stock_tokens
       (address, symbol, name, decimals, isin, current_multiplier, pending_multiplier, status, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       symbol=excluded.symbol, name=excluded.name, decimals=excluded.decimals,
       isin=excluded.isin, current_multiplier=excluded.current_multiplier,
       pending_multiplier=excluded.pending_multiplier, status=excluded.status,
       synced_at=excluded.synced_at`,
  );
  const now = Date.now();
  db.exec('BEGIN');
  for (const t of tokens) {
    stmt.run(t.address, t.symbol, t.name, t.decimals, t.isin, t.currentMultiplier,
             t.pendingMultiplier, t.status, now);
  }
  db.exec('COMMIT');
}

export function loadStockTokens(): StockToken[] {
  const rows = getDb().prepare('SELECT * FROM stock_tokens').all() as Record<string, unknown>[];
  return rows.map((r) => ({
    address: String(r.address),
    symbol: String(r.symbol),
    name: String(r.name),
    decimals: Number(r.decimals),
    isin: r.isin ? String(r.isin) : null,
    currentMultiplier: String(r.current_multiplier),
    pendingMultiplier: r.pending_multiplier ? String(r.pending_multiplier) : null,
    status: String(r.status),
  }));
}

/** address -> symbol, for pool classification. */
export function stockTokenMap(): Map<string, string> {
  return new Map(loadStockTokens().map((t) => [t.address, t.symbol]));
}
