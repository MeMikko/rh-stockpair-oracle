import { TOKENS } from '../../config/addresses.js';

export type QuoteKind = 'stock' | 'weth' | 'usdg' | 'other';

export interface Classification {
  quoteKind: QuoteKind;
  /** 0 or 1 -- which side of the pool is the stock token. */
  stockSide: 0 | 1 | null;
  stockSymbol: string | null;
  /** The non-stock side; what /quote prices in USD. */
  pairedToken: string | null;
}

/**
 * Classify a pool by its currencies alone. Hook-agnostic on purpose: a new
 * launchpad appears as a new hook address and is picked up with no code change.
 */
export function classifyPool(
  currency0: string,
  currency1: string,
  stockMap: Map<string, string>,
): Classification {
  const c0 = currency0.toLowerCase();
  const c1 = currency1.toLowerCase();
  const s0 = stockMap.get(c0);
  const s1 = stockMap.get(c1);

  // A stock/stock pool is real (e.g. NVDA/SPY). Treat side 0 as the pricing
  // asset and price side 1 against it; the caller can invert.
  if (s0 && s1) {
    return { quoteKind: 'stock', stockSide: 0, stockSymbol: s0, pairedToken: c1 };
  }
  if (s0) return { quoteKind: 'stock', stockSide: 0, stockSymbol: s0, pairedToken: c1 };
  if (s1) return { quoteKind: 'stock', stockSide: 1, stockSymbol: s1, pairedToken: c0 };

  const weth = TOKENS.weth.toLowerCase();
  const usdg = TOKENS.usdg.toLowerCase();
  if (c0 === weth || c1 === weth) {
    return { quoteKind: 'weth', stockSide: null, stockSymbol: null, pairedToken: c0 === weth ? c1 : c0 };
  }
  if (c0 === usdg || c1 === usdg) {
    return { quoteKind: 'usdg', stockSide: null, stockSymbol: null, pairedToken: c0 === usdg ? c1 : c0 };
  }
  return { quoteKind: 'other', stockSide: null, stockSymbol: null, pairedToken: null };
}
