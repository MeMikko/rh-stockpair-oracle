import { describe, it, expect } from 'vitest';
import { feedSymbol } from '../src/registry/feeds.js';

describe('feedSymbol', () => {
  it('normalises the three name shapes Chainlink actually uses', () => {
    expect(feedSymbol('Robinhood AAPL / USD')).toBe('AAPL');
    expect(feedSymbol('RHSPY / USD')).toBe('SPY');
    expect(feedSymbol('Robinhood SGOV-USD')).toBe('SGOV');
    expect(feedSymbol('Robinhood MSTR / USD')).toBe('MSTR');
  });
});
