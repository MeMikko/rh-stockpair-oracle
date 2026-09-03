import type { Address } from 'viem';
import { feedFor } from '../registry/feeds.js';
import { readFeed, type OracleRead } from './chainlink.js';
import { readMultiplier, type MultiplierState } from './multiplier.js';
import { computeDeviation } from './deviation.js';
import { stockTokenMap } from '../registry/stockTokens.js';

/**
 * What a pool's spot price implies about the stock, shared by every surface
 * that needs it.
 *
 * Extracted from `/quote` rather than copied into the snapshotter. A second
 * implementation would drift, and then the history would disagree with the
 * live answer about the same pool at the same moment -- which is the one thing
 * a time series must never do, because the whole reason to keep it is that it
 * can be compared against what the service said at the time.
 */

/** The pool-agnostic half of an answer: what the stock side implies in USD. */
export async function stockContext(pool: {
  quoteKind: string;
  stockSymbol: string | null;
  pairedToken: string | null;
  stockSide: number | null;
  currency0: string;
  currency1: string;
  /** currency1 per currency0, from the pool's own sqrt price. */
  spot: number;
}): Promise<{
  oracle: OracleRead | null;
  multiplier: MultiplierState | null;
  impliedUsd: number | null;
  deviation: Awaited<ReturnType<typeof computeDeviation>>;
}> {
  let oracle: OracleRead | null = null;
  let multiplier: MultiplierState | null = null;
  let impliedUsd: number | null = null;
  let deviation: Awaited<ReturnType<typeof computeDeviation>> = {
    deviation: null, reason: 'pool_not_stock_paired',
    poolImpliedStockUsd: null, referenceUsd: null,
  };

  if (pool.quoteKind !== 'stock' || !pool.stockSymbol || !pool.pairedToken) {
    return { oracle, multiplier, impliedUsd, deviation };
  }

  const stockAddr = pool.stockSide === 0 ? pool.currency0 : pool.currency1;
  multiplier = await readMultiplier(stockAddr as Address);

  const feed = feedFor(pool.stockSymbol);
  // 159 of 194 stock tokens have no Chainlink feed. Report that explicitly
  // rather than omitting the field: a consumer must be able to tell
  // "no deviation" apart from "deviation unknowable".
  if (feed) oracle = await readFeed(feed);

  // spot is currency1 per currency0; normalise to stock tokens per paired token.
  const stockPerPaired = pool.stockSide === 0 ? 1 / pool.spot : pool.spot;
  if (oracle) impliedUsd = stockPerPaired * oracle.priceUsd;

  deviation = await computeDeviation(
    pool.stockSymbol, pool.pairedToken, stockPerPaired, oracle, stockTokenMap(),
  );

  return { oracle, multiplier, impliedUsd, deviation };
}
