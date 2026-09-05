import { feedFor, referenceFeed } from '../registry/feeds.js';
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
 * Which USD reference the non-stock side of a pool has, if any.
 *
 * Pulled out of computeDeviation so the snapshotter can ask the same question
 * without asking for a price. It has to rank pools by whether a drift figure
 * can ever come out of them, and a second answer to "is this pool measurable"
 * -- in SQL, or as a list of addresses copied into the sampler -- would be
 * free to drift from the one the pricing path actually uses. Then the series
 * would fill with pools the sampler believed were measurable and the pricing
 * path silently refused, which is exactly the failure this returns a reason
 * for rather than a null.
 *
 * Says nothing about the STOCK side: that needs `feedFor(symbol)`, and the two
 * are separate questions with separate answers in computeDeviation.
 */
export type PairedUsdReference = 'usdg' | 'paired_stock' | 'weth' | null;

export function pairedUsdReference(
  pairedToken: string,
  stockMap: Map<string, string>,
): PairedUsdReference {
  const paired = pairedToken.toLowerCase();
  if (paired === TOKENS.usdg.toLowerCase()) return 'usdg';
  if (stockMap.get(paired)) return 'paired_stock';
  if (paired === TOKENS.weth.toLowerCase()) return 'weth';
  return null;
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
 *   stock/WETH          -- when an ETH/USD reference feed is published
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
  const reference = pairedUsdReference(paired, stockMap);

  // stock/USDG -- the paired side is a dollar, so the pool states a USD price.
  if (reference === 'usdg') {
    const poolStockUsd = 1 / stockPerPaired; // USDG per stock token
    return {
      deviation: (poolStockUsd - stockOracle.priceUsd) / stockOracle.priceUsd,
      reason: null,
      poolImpliedStockUsd: poolStockUsd,
      referenceUsd: stockOracle.priceUsd,
    };
  }

  // stock/stock -- both sides priced by Chainlink, so the ratio is checkable.
  if (reference === 'paired_stock') {
    const otherSymbol = stockMap.get(paired) as string;
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

  // stock/WETH -- the same shape as stock/stock, with ETH's own feed standing
  // in for the paired side. Kept last because it is the narrowest case, and
  // gated on the feed actually existing: where the chain publishes no ETH/USD
  // the answer is still null with a reason, not a number derived from nothing.
  if (reference === 'weth') {
    const ethFeed = referenceFeed('ETH');
    if (!ethFeed) return none('no_eth_usd_reference_configured');
    const ethOracle = await readFeed(ethFeed);
    const poolStockUsd = ethOracle.priceUsd / stockPerPaired;
    return {
      deviation: (poolStockUsd - stockOracle.priceUsd) / stockOracle.priceUsd,
      reason: null,
      poolImpliedStockUsd: poolStockUsd,
      referenceUsd: stockOracle.priceUsd,
    };
  }

  return none('paired_token_has_no_usd_reference');
}
