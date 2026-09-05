import { describe, it, expect } from 'vitest';
import { pairedUsdReference } from '../src/pricing/deviation.js';
import { TOKENS } from '../config/addresses.js';

/**
 * Which side of a pool can be priced, as a pure function.
 *
 * Extracted so the snapshotter's ranking and the deviation path give the same
 * answer. The case that matters is the one production actually contains: the
 * busiest v4 stock pools on this chain are paired against memecoins whose
 * tickers collide with real stocks, and a pool being busy says nothing about
 * whether a drift figure can come out of it.
 */
const MEME_GME = '0xef67e3064bef1a27e81925ec7132f23e533bd5f6';
const STOCK_AAPL = '0x1111111111111111111111111111111111111111';

/** Address -> stock symbol, the shape stockTokenMap() returns. */
const stockMap = new Map<string, string>([[STOCK_AAPL, 'AAPL']]);

describe('pairedUsdReference', () => {
  it('prices a dollar as a dollar', () => {
    expect(pairedUsdReference(TOKENS.usdg, stockMap)).toBe('usdg');
  });

  it('is case-insensitive, because pool rows are not normalised on the way in', () => {
    expect(pairedUsdReference(TOKENS.usdg.toUpperCase(), stockMap)).toBe('usdg');
    expect(pairedUsdReference(TOKENS.weth.toLowerCase(), stockMap)).toBe('weth');
  });

  it('recognises another stock token as a reference', () => {
    expect(pairedUsdReference(STOCK_AAPL, stockMap)).toBe('paired_stock');
  });

  it('recognises WETH', () => {
    expect(pairedUsdReference(TOKENS.weth, stockMap)).toBe('weth');
  });

  /**
   * The whole point. "Greatest Meme Ever" trades under the ticker GME and sits
   * in one of the busiest stock-paired v4 pools on the chain. It is not in the
   * stock token map, so it is not a reference — a pool against it states a
   * price for the memecoin, not for GameStop.
   */
  it('refuses a memecoin whose ticker collides with a real stock', () => {
    expect(pairedUsdReference(MEME_GME, stockMap)).toBeNull();
  });

  it('refuses anything unknown', () => {
    expect(pairedUsdReference('0xdead00000000000000000000000000000000beef', stockMap)).toBeNull();
  });

  /**
   * Membership is by ADDRESS, never by symbol. Matching on the ticker is
   * exactly how a memecoin called GME would be mistaken for GameStop.
   */
  it('does not match a stock by its symbol', () => {
    expect(pairedUsdReference('GME', stockMap)).toBeNull();
  });
});
