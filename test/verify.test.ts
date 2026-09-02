import { describe, it, expect } from 'vitest';
import { verifyDraft, allowedNumbers, MAX_POST_LENGTH } from '../src/agent/verify.js';
import { templateDraft } from '../src/agent/draft.js';

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

/**
 * Every template must satisfy the same guard rail the model's output does.
 * A template that quietly derives a number would pass review by looking
 * plausible and then fail verification only in production, where the effect
 * is a signal that never publishes.
 */
describe('protocol_split template', () => {
  const splitFacts = {
    v3SharePercent: 37,
    v3VolumeUsdMillions: 151.6,
    v4VolumeUsdMillions: 257.9,
    totalVolumeUsdMillions: 409.5,
    windowHours: 24.1,
    v3Pools: 1104,
    v4Pools: 1652,
    topPoolByUsdProtocol: 'v4',
    topPoolByUsdSymbol: 'CRCL',
    topPoolByUsdMillions: 43.5,
    fromBlock: 51543684,
    toBlock: 52401168,
  };

  it('passes verification with only facts-backed numbers', () => {
    const text = templateDraft({
      id: 'x', kind: 'protocol_split', severity: 'high',
      summary: 'split', facts: splitFacts, reproduce: 'npm run volume:sync',
      detectedAt: 0,
    });
    const r = verifyDraft(text, splitFacts);
    expect(r.unsupported).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('does not claim the biggest pool is v3', () => {
    // Ranking by USD and by swap count pick different pools, so no published
    // claim may rest on which protocol holds "the most-traded" one.
    const text = templateDraft({
      id: 'x', kind: 'protocol_split', severity: 'high',
      summary: 'split', facts: splitFacts, reproduce: 'npm run volume:sync',
      detectedAt: 0,
    });
    expect(text).not.toMatch(/most[- ]traded/i);
    expect(text).toContain('37%');
  });
});

describe('layer identifiers', () => {
  const gasFacts = { nonZeroSamples: 3, samples: 12, windowSeconds: 900 };

  it('does not read the 1 in "L1" as a claimed number', () => {
    const r = verifyDraft(
      'Robinhood Chain is charging for L1 data in 3 of the last 12 samples.',
      gasFacts,
    );
    expect(r.unsupported).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still rejects a real invented number alongside L1', () => {
    const r = verifyDraft('L1 data charged in 7 of the last 12 samples.', gasFacts);
    expect(r.unsupported).toContain('7');
  });
});

describe('hostnames', () => {
  const facts = { v3SharePercent: 36, totalPools: 1008633 };

  it('does not read the 4 in a hostname as a claimed number', () => {
    const r = verifyDraft('Live at oracle.sb4s.xyz — v3 carries 36% of volume.', facts);
    expect(r.unsupported).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still rejects an invented number alongside a URL', () => {
    const r = verifyDraft('oracle.sb4s.xyz indexes 999 pools.', facts);
    expect(r.unsupported).toContain('999');
  });

  it('does not let a decimal hide inside the hostname pattern', () => {
    // The TLD must be letters, so `2.50` is never treated as a domain.
    expect(verifyDraft('the price is 2.50', facts).unsupported).toContain('2.50');
  });
});
