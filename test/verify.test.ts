import { describe, it, expect } from 'vitest';
import { verifyDraft, allowedNumbers, MAX_POST_LENGTH } from '../src/agent/verify.js';

const facts = {
  symbol: 'MSFT', actionType: 'CASH_DIVIDEND', processDate: '2026-09-10',
  daysAway: 8, affectedPools: 3, rate: '0.91',
};

describe('verifyDraft', () => {
  it('accepts a draft whose numbers all come from the facts', () => {
    const r = verifyDraft('MSFT cash dividend of 0.91 on 2026-09-10 reprices 3 pools.', facts);
    expect(r.ok).toBe(true);
    expect(r.unsupported).toEqual([]);
  });

  it('rejects an invented number', () => {
    // 12 pools is not in the facts; 3 is.
    const r = verifyDraft('MSFT dividend reprices 12 pools.', facts);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain('12');
  });

  it('rejects a plausible but unsupported derived statistic', () => {
    const r = verifyDraft('MSFT dividend of 0.91 — a 4.2% yield — hits 3 pools.', facts);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain('4.2');
  });

  it('allows date components written separately', () => {
    expect(verifyDraft('Due 10 September 2026 across 3 pools.', facts).ok).toBe(true);
  });

  it('tolerates thousands separators against a plain fact', () => {
    const r = verifyDraft('Total 1,000 pools.', { n: 1000 });
    expect(r.ok).toBe(true);
  });

  it('rejects an over-length draft even when the numbers check out', () => {
    const r = verifyDraft('MSFT 3 '.repeat(60), facts);
    expect(r.tooLong).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.length).toBeGreaterThan(MAX_POST_LENGTH);
  });

  it('rejects an empty draft', () => {
    expect(verifyDraft('   ', facts).ok).toBe(false);
  });

  it('derives allowed forms from numeric facts', () => {
    const a = allowedNumbers({ coveragePercent: 18.0, uncovered: 159 });
    expect(a.has('18')).toBe(true);
    expect(a.has('159')).toBe(true);
  });
});

describe('identifier handling', () => {
  const f = { symbol: 'UPS', affectedPools: 1, processDate: '2026-09-03' };

  it('allows standard identifiers that contain digits', () => {
    const r = verifyDraft(
      'UPS action on 2026-09-03 lands as an ERC-8056 multiplier change on Robinhood Chain, repricing 1 pool.', f);
    expect(r.unsupported).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('allows a Uniswap version reference', () => {
    expect(verifyDraft('1 v4 pool reprices on 2026-09-03.', f).ok).toBe(true);
  });

  it('still rejects an invented number in a draft that also names a standard', () => {
    // 47 is not a fact; the ERC-8056 reference must not launder it through.
    const r = verifyDraft('ERC-8056 multiplier change reprices 47 pools.', f);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain('47');
  });

  it('does not allow a bare number that merely resembles a standard id', () => {
    const r = verifyDraft('There are 8056 pools affected.', f);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain('8056');
  });
});
