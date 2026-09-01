import { describe, it, expect } from 'vitest';
import { classifyPool } from '../src/indexer/classify.js';

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MEME = '0x531e9908b8175349e5645bf5960ec75a49f3bba3';
const map = new Map([[NVDA, 'NVDA']]);

describe('classifyPool', () => {
  it('detects a stock token on side 1', () => {
    const c = classifyPool(MEME, NVDA, map);
    expect(c.quoteKind).toBe('stock');
    expect(c.stockSide).toBe(1);
    expect(c.stockSymbol).toBe('NVDA');
    expect(c.pairedToken).toBe(MEME);
  });

  it('detects a stock token on side 0', () => {
    const c = classifyPool(NVDA, MEME, map);
    expect(c.stockSide).toBe(0);
    expect(c.pairedToken).toBe(MEME);
  });

  it('classifies weth and usdg pools', () => {
    expect(classifyPool(WETH, MEME, map).quoteKind).toBe('weth');
    expect(classifyPool(USDG, MEME, map).quoteKind).toBe('usdg');
  });

  it('is case insensitive', () => {
    expect(classifyPool(MEME, NVDA.toUpperCase().replace('0X', '0x'), map).quoteKind).toBe('stock');
  });

  it('falls through to other', () => {
    expect(classifyPool(MEME, '0xdead', map).quoteKind).toBe('other');
  });
});
