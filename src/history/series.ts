import { getDb } from '../db/index.js';

/**
 * Reading the record back.
 *
 * Every function here answers from stored rows only. Nothing is interpolated,
 * nothing is filled forward, and a gap stays a gap: the series is evidence,
 * and evidence that quietly invents its missing points is worse than a short
 * series. `samples` is therefore returned everywhere, so a caller can see how
 * much the answer rests on.
 */

export interface SnapshotRow {
  at: number;
  block: number;
  protocol: string;
  spot: number;
  /** The exact price the chain returned; null on rows written before it was kept. */
  sqrtPriceX96: string | null;
  /** Null means the sample passed the rule, not that it went unchecked. */
  priceFlag: string | null;
  impliedUsd: number | null;
  poolStockUsd: number | null;
  oracleUsd: number | null;
  deviation: number | null;
  deviationReason: string | null;
  liquidity: string;
  marketSession: string;
  marketOpen: boolean;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function mapRow(r: Record<string, unknown>): SnapshotRow {
  return {
    at: Number(r.at),
    block: Number(r.block),
    protocol: String(r.protocol),
    spot: Number(r.spot),
    sqrtPriceX96: (r.sqrt_price_x96 as string | null) ?? null,
    priceFlag: (r.price_flag as string | null) ?? null,
    impliedUsd: num(r.implied_usd as string | null),
    poolStockUsd: num(r.pool_stock_usd as string | null),
    oracleUsd: num(r.oracle_usd as string | null),
    deviation: num(r.deviation as string | null),
    deviationReason: (r.deviation_reason as string | null) ?? null,
    liquidity: String(r.liquidity),
    marketSession: String(r.market_session),
    marketOpen: Number(r.market_open) === 1,
  };
}

/** Snapshots for one pool, oldest first. */
export function snapshotsForPool(poolKey: string, sinceMs: number, limit = 500): SnapshotRow[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT * FROM quote_snapshots
         WHERE pool_key = ? AND at >= ?
         ORDER BY at ASC
         LIMIT ?`,
      )
      .all(poolKey.toLowerCase(), sinceMs, limit) as Array<Record<string, unknown>>
  ).map(mapRow);
}

/** The pool this service has the most history for, for a given stock. */
export function bestSampledPool(symbol: string): { poolKey: string; samples: number } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT pool_key AS poolKey, COUNT(*) AS samples
       FROM quote_snapshots
       WHERE stock_symbol = ?
       GROUP BY pool_key
       ORDER BY samples DESC, pool_key
       LIMIT 1`,
    )
    .get(symbol) as { poolKey: string; samples: number } | undefined;
  return row && row.samples > 0 ? row : null;
}

export interface SessionStat {
  session: string;
  samples: number;
  /** Mean of |deviation|, over measurable samples that were not flagged. */
  meanAbsDeviation: number | null;
  maxAbsDeviation: number | null;
  /** Samples with no Chainlink feed, so no deviation was knowable. */
  unknowable: number;
  /**
   * Samples the statistic is actually computed from: a measured deviation and
   * an unflagged price. Reported rather than left to be derived, because
   * `samples - unknowable - flagged` is wrong whenever a row is both.
   */
  usable: number;
  /**
   * Samples excluded because the price they carry describes one order rather
   * than a market. Counted, never silently dropped — the same reason
   * `unknowable` is counted: a statistic that quietly narrows its own input
   * reads as though it covered everything.
   */
  flagged: number;
}

/**
 * Drift against Chainlink, split by what the equity market was doing.
 *
 * This is the statistic the project exists to be able to state. It is not
 * available from any live endpoint, here or anywhere else, because it is a
 * fact about a period rather than about a moment — and no one else on this
 * chain has been recording the period.
 *
 * Samples with no feed are counted separately rather than dropped. 159 of the
 * 194 stock tokens have none, so a mean taken over "whatever had a number"
 * would be a mean over a self-selected third of the subject and would read as
 * if it covered all of it.
 */
export function driftBySession(symbol: string, sinceMs: number): SessionStat[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT market_session AS session,
              COUNT(*) AS samples,
              SUM(CASE WHEN deviation IS NULL THEN 1 ELSE 0 END) AS unknowable,
              SUM(CASE WHEN price_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged,
              SUM(CASE WHEN deviation IS NOT NULL AND price_flag IS NULL THEN 1 ELSE 0 END) AS usable,
              -- Flagged rows are excluded from the statistic and counted above.
              -- A price set by one order large enough to move the pool 10% is a
              -- fact about that order, and averaging it into "how far this pool
              -- drifts overnight" would answer a different question.
              AVG(CASE WHEN deviation IS NULL OR price_flag IS NOT NULL THEN NULL
                       ELSE ABS(CAST(deviation AS REAL)) END) AS meanAbs,
              MAX(CASE WHEN deviation IS NULL OR price_flag IS NOT NULL THEN NULL
                       ELSE ABS(CAST(deviation AS REAL)) END) AS maxAbs
       FROM quote_snapshots
       WHERE stock_symbol = ? AND at >= ?
       GROUP BY market_session
       ORDER BY samples DESC`,
    )
    .all(symbol, sinceMs) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    session: String(r.session),
    samples: Number(r.samples),
    unknowable: Number(r.unknowable),
    flagged: Number(r.flagged),
    usable: Number(r.usable),
    meanAbsDeviation: r.meanAbs === null ? null : Number(r.meanAbs),
    maxAbsDeviation: r.maxAbs === null ? null : Number(r.maxAbs),
  }));
}

export interface VolumePoint {
  toTs: number;
  fromTs: number;
  swaps: number;
  absAmount0: string;
  absAmount1: string;
}

/** Kept volume windows for one pool, oldest first. */
export function volumeHistory(poolKey: string, sinceTs: number, limit = 500): VolumePoint[] {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT to_ts, from_ts, swaps, abs_amount0, abs_amount1
         FROM pool_volume_history
         WHERE pool_key = ? AND to_ts >= ?
         ORDER BY to_ts ASC
         LIMIT ?`,
      )
      .all(poolKey.toLowerCase(), sinceTs, limit) as Array<Record<string, unknown>>
  ).map((r) => ({
    toTs: Number(r.to_ts),
    fromTs: Number(r.from_ts),
    swaps: Number(r.swaps),
    absAmount0: String(r.abs_amount0),
    absAmount1: String(r.abs_amount1),
  }));
}

export interface HistoryDepth {
  snapshots: number;
  /** How many recorded samples carry a price not fit to compute a statistic from. */
  flagged: number;
  volumeWindows: number;
  /** When recording began, or null before the first sample. */
  since: number | null;
  symbols: number;
}

/**
 * How much history exists at all.
 *
 * Published deliberately, and free: a caller deciding whether to pay for a
 * series should be able to find out first whether there is one. On a fresh
 * deployment every number here is zero, and saying so plainly is better than
 * selling an empty answer.
 */
export function historyDepth(): HistoryDepth {
  const db = getDb();
  const s = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(at) AS since, COUNT(DISTINCT stock_symbol) AS symbols,
              SUM(CASE WHEN price_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged
       FROM quote_snapshots`,
    )
    .get() as { n: number; since: number | null; symbols: number; flagged: number | null };
  const v = db.prepare('SELECT COUNT(*) AS n FROM pool_volume_history').get() as { n: number };
  return {
    snapshots: Number(s.n),
    flagged: Number(s.flagged ?? 0),
    volumeWindows: Number(v.n),
    since: s.since === null ? null : Number(s.since),
    symbols: Number(s.symbols),
  };
}
