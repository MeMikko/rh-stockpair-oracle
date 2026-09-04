import { getDb } from '../db/index.js';

/**
 * The trades a person would notice, kept instead of thrown away.
 *
 * Every swap on this chain already passes through the volume measurement --
 * `measureV4Volume` and `measureV3Volume` read each Swap log, add it to a
 * per-pool total, and drop it. So the agent could say what a pool traded in
 * total and had nothing to say about the trade that moved it, which is the
 * thing anyone actually asks about. No extra RPC call is needed to fix that:
 * the logs are already in hand.
 *
 * Two passes rather than one, because a swap's size in dollars is not known
 * while the logs are being walked:
 *
 *   1. During the walk, keep the largest few swaps per pool by the raw
 *      stock-side amount. Exact, cheap, and needs no price or decimals --
 *      within one pool the stock side is always the same token.
 *   2. Afterwards, where a Chainlink price exists, convert those candidates
 *      to USD and keep the ones worth recording.
 *
 * A swap in a stock with no feed is stored with a null USD and the reason,
 * never with a guess: 159 of 194 stock tokens have no feed, and the whole
 * argument for this data is that its numbers are checkable.
 */

/** Largest swaps kept per pool during the walk. Bounds memory over a 24h window. */
export const TOP_PER_POOL = 5;

export interface SwapCandidate {
  poolKey: string;
  protocol: 'v4' | 'v3';
  txHash: string;
  logIndex: number;
  block: number;
  amount0: bigint;
  amount1: bigint;
}

/**
 * A bounded top-N per pool.
 *
 * Ordered on the stock side, which the caller identifies: a pool's paired
 * token can be anything a launchpad minted, so ranking on it would rank pools
 * against each other in units that do not compare.
 */
export class TopSwaps {
  private readonly byPool = new Map<string, SwapCandidate[]>();

  constructor(
    /** poolKey (lowercased) -> which side of the pool is the stock. */
    private readonly stockSide: Map<string, 0 | 1>,
    private readonly perPool = TOP_PER_POOL,
  ) {}

  /** Ignores pools the caller did not list: non-stock pools are not the subject. */
  offer(c: SwapCandidate): void {
    const side = this.stockSide.get(c.poolKey);
    if (side === undefined) return;
    const size = abs(side === 0 ? c.amount0 : c.amount1);
    if (size === 0n) return;

    const list = this.byPool.get(c.poolKey) ?? [];
    list.push(c);
    list.sort((a, b) => {
      const sa = abs(side === 0 ? a.amount0 : a.amount1);
      const sb = abs(side === 0 ? b.amount0 : b.amount1);
      return sa === sb ? 0 : sa > sb ? -1 : 1;
    });
    if (list.length > this.perPool) list.length = this.perPool;
    this.byPool.set(c.poolKey, list);
  }

  all(): SwapCandidate[] {
    return [...this.byPool.values()].flat();
  }

  size(): number {
    return this.all().length;
  }
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

export interface PoolFacts {
  stockSymbol: string;
  stockSide: 0 | 1;
  /** Decimals of the stock side. USDG is 6 and stock tokens are 18 here, and a
   * wrong exponent is a 10^12 error, so this is read rather than assumed. */
  decimals: number;
}

export interface StoredSwap {
  txHash: string;
  logIndex: number;
  poolKey: string;
  protocol: string;
  block: number;
  stockSymbol: string;
  /** Of the stock, from the taker's side: buy when stock left the pool. */
  side: 'buy' | 'sell';
  stockUnits: number;
  usd: number | null;
  usdReason: string | null;
  observedAt: number;
}

/**
 * The stock-paired pools worth ranking, with what is needed to price them.
 *
 * Loaded once per run rather than per swap: over a 24h window this is looked
 * up hundreds of thousands of times.
 */
export function poolFacts(): Map<string, PoolFacts> {
  const db = getDb();
  const decimals = new Map(
    (
      db.prepare('SELECT symbol, decimals FROM stock_tokens').all() as Array<{
        symbol: string; decimals: number;
      }>
    ).map((r) => [r.symbol, Number(r.decimals)]),
  );

  const out = new Map<string, PoolFacts>();
  const add = (key: string, symbol: string, side: number) => {
    const d = decimals.get(symbol);
    if (d === undefined) return;
    out.set(key.toLowerCase(), { stockSymbol: symbol, stockSide: side === 0 ? 0 : 1, decimals: d });
  };
  for (const r of db
    .prepare(
      "SELECT pool_id AS k, stock_symbol AS s, stock_side AS side FROM pools WHERE quote_kind = 'stock' AND stock_symbol IS NOT NULL",
    )
    .all() as Array<{ k: string; s: string; side: number }>) {
    add(r.k, r.s, r.side);
  }
  for (const r of db
    .prepare(
      "SELECT address AS k, stock_symbol AS s, stock_side AS side FROM pools_v3 WHERE quote_kind = 'stock' AND stock_symbol IS NOT NULL",
    )
    .all() as Array<{ k: string; s: string; side: number }>) {
    add(r.k, r.s, r.side);
  }
  return out;
}

/**
 * Price the candidates and keep the ones above the floor.
 *
 * `minUsd` is a floor on what gets recorded at all, deliberately well above
 * "any trade": a threshold that admits everything makes "notable" mean
 * nothing, and this table exists to answer what stood out.
 */
export function selectLargeSwaps(
  candidates: SwapCandidate[],
  facts: Map<string, PoolFacts>,
  prices: Map<string, number>,
  minUsd: number,
  now = Date.now(),
): StoredSwap[] {
  const out: StoredSwap[] = [];
  for (const c of candidates) {
    const f = facts.get(c.poolKey);
    if (!f) continue;

    const raw = f.stockSide === 0 ? c.amount0 : c.amount1;
    const stockUnits = Number(abs(raw)) / 10 ** f.decimals;
    if (!Number.isFinite(stockUnits) || stockUnits <= 0) continue;

    // Sign convention is the pool's: a negative amount is the token leaving
    // the pool, which is the taker receiving it. Stock out of the pool is a
    // buy of the stock.
    const side: 'buy' | 'sell' = raw < 0n ? 'buy' : 'sell';

    const price = prices.get(f.stockSymbol);
    const usd = price === undefined ? null : stockUnits * price;
    if (usd !== null && usd < minUsd) continue;

    out.push({
      txHash: c.txHash,
      logIndex: c.logIndex,
      poolKey: c.poolKey,
      protocol: c.protocol,
      block: c.block,
      stockSymbol: f.stockSymbol,
      side,
      stockUnits,
      usd,
      // An unpriceable swap is kept rather than dropped, and says why. Dropping
      // it would make the table quietly cover only the 35 stocks with feeds
      // while reading as though it covered all 194.
      usdReason: usd === null ? 'no_chainlink_feed_for_stock' : null,
      observedAt: now,
    });
  }
  return out;
}

export function saveLargeSwaps(rows: StoredSwap[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO large_swaps
       (tx_hash, log_index, pool_key, protocol, block, stock_symbol, side,
        stock_units, usd, usd_reason, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      // (tx_hash, log_index) is the swap's own identity on chain, so a window
      // measured twice records it once.
      const res = stmt.run(
        r.txHash, r.logIndex, r.poolKey, r.protocol, r.block, r.stockSymbol, r.side,
        String(r.stockUnits), r.usd === null ? null : String(r.usd), r.usdReason, r.observedAt,
      );
      if (Number(res.changes) > 0) inserted += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return inserted;
}

export interface LargeSwapRow extends StoredSwap {}

/** Recorded trades for a stock, biggest first. */
export function largeSwapsFor(symbol: string, limit = 20): LargeSwapRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM large_swaps WHERE stock_symbol = ?
         ORDER BY CASE WHEN usd IS NULL THEN 1 ELSE 0 END, CAST(usd AS REAL) DESC, block DESC
         LIMIT ?`,
      )
      .all(symbol, limit) as Array<Record<string, unknown>>
  ).map(mapRow);
}

/** The biggest recorded trades across every stock. */
export function largestSwaps(limit = 10): LargeSwapRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM large_swaps WHERE usd IS NOT NULL
         ORDER BY CAST(usd AS REAL) DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>
  ).map(mapRow);
}

function mapRow(r: Record<string, unknown>): LargeSwapRow {
  return {
    txHash: String(r.tx_hash),
    logIndex: Number(r.log_index),
    poolKey: String(r.pool_key),
    protocol: String(r.protocol),
    block: Number(r.block),
    stockSymbol: String(r.stock_symbol),
    side: String(r.side) === 'buy' ? 'buy' : 'sell',
    stockUnits: Number(r.stock_units),
    usd: r.usd === null || r.usd === undefined ? null : Number(r.usd),
    usdReason: (r.usd_reason as string | null) ?? null,
    observedAt: Number(r.observed_at),
  };
}
