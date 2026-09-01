import { feedFor } from '../registry/feeds.js';
import { readFeed, type OracleRead } from './chainlink.js';
import { TOKENS } from '../../config/addresses.js';

export interface DeviationResult {
  /** Signed fraction: +0.01 means the pool prices the stock 1% above Chainlink. */
  deviation: number | null;
  reason: string | null;
  poolImpliedStockUsd: number | null;
  referenceUsd: number | null;
}

/**
 * Deviation vs Chainlink is only computable when the NON-stock side of the pool
 * has its own USD reference. A memecoin/NVDA pool gives no independent read on
 * NVDA -- the pool price there is a statement about the memecoin, not about
 * NVDA -- so we return null with a reason instead of inventing a number.
 *
 * Computable cases:
 *   stock/USDG          -- USDG treated as $1
 *   stock/stock         -- when both sides have feeds
 * Everything else       -- null, reason explains why.
 */
export async function computeDeviation(
  stockSymbol: string,
  pairedToken: string,
  /** Stock tokens per 1 paired token, from pool spot. */
  stockPerPaired: number,
  stockOracle: OracleRead | null,
  stockMap: Map<string, string>,
): Promise<DeviationResult> {
  const none = (reason: string): DeviationResult => ({
    deviation: null, reason, poolImpliedStockUsd: null, referenceUsd: null,
  });

  if (!stockOracle) return none('no_chainlink_feed_for_stock');
  if (stockPerPaired <= 0 || !Number.isFinite(stockPerPaired)) return none('degenerate_pool_price');

  const paired = pairedToken.toLowerCase();

  // stock/USDG -- the paired side is a dollar, so the pool states a USD price.
  if (paired === TOKENS.usdg.toLowerCase()) {
    const poolStockUsd = 1 / stockPerPaired; // USDG per stock token
    return {
      deviation: (poolStockUsd - stockOracle.priceUsd) / stockOracle.priceUsd,
      reason: null,
      poolImpliedStockUsd: poolStockUsd,
      referenceUsd: stockOracle.priceUsd,
    };
  }

  // stock/stock -- both sides priced by Chainlink, so the ratio is checkable.
  const otherSymbol = stockMap.get(paired);
  if (otherSymbol) {
    const otherFeed = feedFor(otherSymbol);
    if (!otherFeed) return none('no_chainlink_feed_for_paired_stock');
    const otherOracle = await readFeed(otherFeed);
    const poolStockUsd = otherOracle.priceUsd / stockPerPaired;
    return {
      deviation: (poolStockUsd - stockOracle.priceUsd) / stockOracle.priceUsd,
      reason: null,
      poolImpliedStockUsd: poolStockUsd,
      referenceUsd: stockOracle.priceUsd,
    };
  }

  if (paired === TOKENS.weth.toLowerCase()) return none('no_eth_usd_reference_configured');
  return none('paired_token_has_no_usd_reference');
}
