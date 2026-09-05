import type { Address, Hex } from 'viem';
import { getClient } from '../../config/chain.js';
import { getDb } from '../db/index.js';
import { tokenMeta } from '../registry/tokenMeta.js';
import { readPoolState, priceFromSqrtX96 } from '../pricing/poolState.js';
import { readV3PoolState } from '../pricing/poolStateV3.js';
import { stockContext } from '../pricing/stockContext.js';
import { pairedUsdReference } from '../pricing/deviation.js';
import { feedFor } from '../registry/feeds.js';
import { stockTokenMap } from '../registry/stockTokens.js';
import { marketStatus } from '../pricing/marketHours.js';
import { flagForAdjacent } from './priceFlag.js';
import { withRetry } from '../util/retry.js';

/**
 * One pool, one moment, written down.
 *
 * `/quote` answers what a pool is priced at now and forgets it. That is the
 * right shape for a lookup and the wrong shape for the question this service
 * is uniquely placed to answer: stock tokens trade 24/5 on-chain while the
 * underlying equity market keeps hours, so *how far a pool drifts while the
 * market is shut* is the premise of the whole project stated as a measurement.
 * It cannot be read live and it cannot be backfilled — the public RPC has no
 * archive and Alchemy's free tier caps `eth_getLogs` at ten blocks — so it
 * exists only if it is recorded as it happens.
 *
 * Hence the session is stored on the same row as the deviation. Joining them
 * afterwards from two sources would mean trusting that the clocks agreed.
 */

export interface Snapshot {
  poolKey: string;
  protocol: 'v4' | 'v3';
  at: number;
  block: number;
  stockSymbol: string | null;
  spot: number;
  /** The exact Q64.96 price the chain returned, so anything derived can be rebuilt. */
  sqrtPriceX96: string;
  impliedUsd: number | null;
  /** What the pool implies the stock is worth -- the number a reader asks for. */
  poolStockUsd: number | null;
  oracleUsd: number | null;
  deviation: number | null;
  /** Why there is no deviation. Null means one was measured. */
  deviationReason: string | null;
  liquidity: string;
  marketSession: string;
  marketOpen: boolean;
}

export interface SamplePool {
  key: string;
  protocol: 'v4' | 'v3';
  token0: string;
  token1: string;
  fee: number;
  stockSide: number | null;
  stockSymbol: string | null;
  pairedToken: string | null;
  quoteKind: string;
  swaps: number;
}

/**
 * The pools worth sampling: stock-paired, measurable first, busiest within that.
 *
 * Ordered by measured swaps rather than by liquidity or recency, because a
 * series is only worth its storage where something trades. A pool with no
 * swaps draws a flat line that says nothing about drift.
 *
 * Swaps alone were not enough. Ranked purely by them, the sampler spent half
 * its budget on pools whose drift can never be computed: measured here on
 * 2026-09-05, 1,368 of 1,372 v4 rows carried no deviation, because the busiest
 * v4 stock pools are paired against memecoins -- NVDA/HUGGY, QQQ/CAYENNE, a
 * "Greatest Meme Ever" token whose ticker is GME. Those pools trade, so they
 * sorted to the top; they have no USD reference, so every row they produced
 * was excluded from every statistic the series exists to support.
 *
 * They are still sampled, last. A price series for them is worth keeping --
 * it is what /quote answers from, and nobody else records it -- but it must
 * not crowd out the rows a drift figure can actually come out of.
 *
 * "Measurable" is asked of the pricing path (`pairedUsdReference`, `feedFor`)
 * rather than restated here, so the sampler cannot come to believe a pool is
 * measurable that computeDeviation will refuse.
 */
export function poolsToSample(limit: number): SamplePool[] {
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT * FROM (
         SELECT p.pool_id AS key, 'v4' AS protocol, p.currency0 AS token0, p.currency1 AS token1,
                p.fee AS fee, p.stock_side AS stockSide, p.stock_symbol AS stockSymbol,
                p.paired_token AS pairedToken, p.quote_kind AS quoteKind,
                COALESCE(v.swaps, 0) AS swaps
         FROM pools p
         LEFT JOIN pool_volume v ON v.pool_key = p.pool_id AND v.protocol = 'v4'
         WHERE p.stock_symbol IS NOT NULL
         UNION ALL
         SELECT p3.address AS key, 'v3' AS protocol, p3.token0, p3.token1,
                p3.fee AS fee, p3.stock_side AS stockSide, p3.stock_symbol AS stockSymbol,
                p3.paired_token AS pairedToken, p3.quote_kind AS quoteKind,
                COALESCE(v3.swaps, 0) AS swaps
         FROM pools_v3 p3
         LEFT JOIN pool_volume v3 ON v3.pool_key = p3.address AND v3.protocol = 'v3'
         WHERE p3.stock_symbol IS NOT NULL
       )
       ORDER BY swaps DESC, key`,
    )
    .all() as unknown as SamplePool[];

  const stockMap = stockTokenMap();
  const measurable = (p: SamplePool): boolean =>
    p.quoteKind === 'stock' &&
    p.stockSymbol !== null &&
    p.pairedToken !== null &&
    feedFor(p.stockSymbol) !== null &&
    pairedUsdReference(p.pairedToken, stockMap) !== null;

  // A stable partition, so within each tier the swaps ordering above is kept.
  const first: SamplePool[] = [];
  const rest: SamplePool[] = [];
  for (const p of candidates) (measurable(p) ? first : rest).push(p);
  return first.concat(rest).slice(0, limit);
}

/** Read one pool's current state and turn it into a row. Writes nothing. */
export async function takeSnapshot(pool: SamplePool, at = Date.now()): Promise<Snapshot> {
  const [m0, m1, block] = await Promise.all([
    tokenMeta(pool.token0 as Address),
    tokenMeta(pool.token1 as Address),
    withRetry(() => getClient().getBlockNumber(), { label: 'blockNumber' }),
  ]);

  let spot: number;
  let liquidity: bigint;
  let sqrtPriceX96: bigint;

  if (pool.protocol === 'v4') {
    const s = await readPoolState(pool.key as Hex, pool.fee);
    sqrtPriceX96 = s.sqrtPriceX96;
    spot = priceFromSqrtX96(s.sqrtPriceX96, m0.decimals, m1.decimals);
    liquidity = s.liquidity;
  } else {
    const s = await readV3PoolState(pool.key as Address);
    sqrtPriceX96 = s.sqrtPriceX96;
    spot = priceFromSqrtX96(s.sqrtPriceX96, m0.decimals, m1.decimals);
    liquidity = s.liquidity;
  }

  const ctx = await stockContext({
    quoteKind: pool.quoteKind,
    stockSymbol: pool.stockSymbol,
    pairedToken: pool.pairedToken,
    stockSide: pool.stockSide,
    currency0: pool.token0,
    currency1: pool.token1,
    spot,
  });

  const market = marketStatus(new Date(at));

  return {
    poolKey: pool.key.toLowerCase(),
    protocol: pool.protocol,
    at,
    block: Number(block),
    stockSymbol: pool.stockSymbol,
    spot,
    sqrtPriceX96: sqrtPriceX96.toString(),
    impliedUsd: ctx.impliedUsd,
    poolStockUsd: ctx.deviation.poolImpliedStockUsd,
    oracleUsd: ctx.oracle?.priceUsd ?? null,
    deviation: ctx.deviation.deviation,
    deviationReason: ctx.deviation.reason,
    liquidity: liquidity.toString(),
    marketSession: market.session,
    marketOpen: market.isOpen,
  };
}

export function saveSnapshots(rows: Snapshot[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO quote_snapshots
       (pool_key, protocol, at, block, stock_symbol, spot, sqrt_price_x96, implied_usd,
        pool_stock_usd, oracle_usd, deviation, deviation_reason, liquidity,
        market_session, market_open, price_flag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The sample immediately before this one for the same pool. Flagging at
  // write time rather than at read time means the stored series carries its
  // own verdict, and a reader cannot forget to apply the rule.
  const prior = db.prepare(
    'SELECT at, spot FROM quote_snapshots WHERE pool_key = ? AND at < ? ORDER BY at DESC LIMIT 1',
  );
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const prev = prior.get(r.poolKey, r.at) as { at: number; spot: string } | undefined;
      const flag = flagForAdjacent(
        prev ? { at: Number(prev.at), spot: Number(prev.spot) } : null,
        { at: r.at, spot: r.spot },
      );
      stmt.run(
        r.poolKey, r.protocol, r.at, r.block, r.stockSymbol,
        // Text, not REAL: these are ratios and money, and a float would round
        // away exactly the small deviations the series exists to record.
        String(r.spot),
        r.sqrtPriceX96,
        r.impliedUsd === null ? null : String(r.impliedUsd),
        r.poolStockUsd === null ? null : String(r.poolStockUsd),
        r.oracleUsd === null ? null : String(r.oracleUsd),
        r.deviation === null ? null : String(r.deviation),
        r.deviationReason, r.liquidity, r.marketSession, r.marketOpen ? 1 : 0, flag,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

/**
 * Drop what is older than the retention window.
 *
 * A cap exists because this runs on a shared box, not because the data stops
 * being interesting. Whoever raises it should raise the disk first.
 */
export function pruneHistory(days: number): { snapshots: number; volume: number } {
  const db = getDb();
  const cutoffMs = Date.now() - days * 86_400_000;
  const cutoffS = Math.floor(cutoffMs / 1000);
  const snapshots = db.prepare('DELETE FROM quote_snapshots WHERE at < ?').run(cutoffMs);
  const volume = db.prepare('DELETE FROM pool_volume_history WHERE to_ts < ?').run(cutoffS);
  return { snapshots: Number(snapshots.changes ?? 0), volume: Number(volume.changes ?? 0) };
}
