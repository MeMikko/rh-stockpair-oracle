import { describe, it, expect } from 'vitest';
import { applySlippage } from '../src/swap/slippage.js';

describe('applySlippage', () => {
  it('applies basis points exactly', () => {
    expect(applySlippage(1_000_000n, 50)).toBe(995_000n);   // 0.50%
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);  // 1.00%
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  it('never rounds in the signer\'s disfavour', () => {
    // 999 * 9950 / 10000 = 994.005 -> must floor to 994, not 995.
    expect(applySlippage(999n, 50)).toBe(994n);
  });

  it('keeps full precision on 18-decimal amounts', () => {
    const quoted = 40_174_821_975_874_843_909_750n;
    expect(applySlippage(quoted, 50)).toBe(39_973_947_865_995_469_690_201n);
  });

  it('handles zero and full slippage', () => {
    expect(applySlippage(0n, 50)).toBe(0n);
    expect(applySlippage(1_000n, 5_000)).toBe(500n);
  });

  it('rejects out-of-range and non-integer tolerances', () => {
    expect(() => applySlippage(1n, -1)).toThrow(RangeError);
    expect(() => applySlippage(1n, 5_001)).toThrow(RangeError);
    expect(() => applySlippage(1n, 12.5)).toThrow(RangeError);
    expect(() => applySlippage(-1n, 50)).toThrow(RangeError);
  });
});
