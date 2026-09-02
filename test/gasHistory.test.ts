import { describe, it, expect, beforeEach } from 'vitest';

// Point the DB at a scratch file before any module reads env.
process.env.DB_PATH = './data/test-gas.db';
const { recordGasSample, subsidyEvidence } = await import('../src/pricing/gasHistory.js');
const { getDb } = await import('../src/db/index.js');

describe('subsidyEvidence', () => {
  beforeEach(() => { getDb().exec('DELETE FROM gas_samples'); });

  it('reports free across the window when every sample is zero', () => {
    for (let b = 1; b <= 5; b++) recordGasSample(BigInt(b), 0n, 0n, 300n);
    const e = subsidyEvidence(true);
    expect(e.freeAcrossWindow).toBe(true);
    expect(e.nonZeroSamples).toBe(0);
    expect(e.samples).toBe(5);
  });

  it('does NOT report free across the window after a single non-zero blip', () => {
    for (let b = 1; b <= 4; b++) recordGasSample(BigInt(b), 0n, 0n, 300n);
    recordGasSample(5n, 0n, 7n, 300n); // transient non-zero L1 base fee
    for (let b = 6; b <= 9; b++) recordGasSample(BigInt(b), 0n, 0n, 300n);

    const e = subsidyEvidence(true);
    // This is the whole point: instantaneously free, but not free across the
    // window, so nothing downstream should claim the subsidy is intact.
    expect(e.freeAtThisBlock).toBe(true);
    expect(e.freeAcrossWindow).toBe(false);
    expect(e.nonZeroSamples).toBe(1);
    expect(e.lastNonZeroAt).not.toBeNull();
  });

  it('counts a non-zero calldata unit as well as a non-zero base fee', () => {
    recordGasSample(1n, 0n, 0n, 300n);
    recordGasSample(2n, 5n, 0n, 300n);
    expect(subsidyEvidence(false).nonZeroSamples).toBe(1);
  });

  it('is not free across an empty window', () => {
    expect(subsidyEvidence(true).freeAcrossWindow).toBe(false);
  });

  it('ignores duplicate blocks', () => {
    recordGasSample(1n, 0n, 0n, 300n);
    recordGasSample(1n, 0n, 0n, 300n);
    expect(subsidyEvidence(true).samples).toBe(1);
  });
});

/**
 * The subsidy claim is the one this agent must never publish on noise: the L1
 * reading flaps, and "the subsidy has ended" cannot be retracted once posted.
 */
describe('gas subsidy signal thresholds', () => {
  const fires = (nonZeroSamples: number, samples: number) =>
    samples >= 30 && nonZeroSamples * 2 > samples;

  it('stays silent on a blip', () => {
    expect(fires(3, 12)).toBe(false);
    expect(fires(1, 40)).toBe(false);
  });

  it('stays silent on a thin window even when every sample is non-zero', () => {
    expect(fires(12, 12)).toBe(false);
    expect(fires(29, 29)).toBe(false);
  });

  it('stays silent on an exact half', () => {
    expect(fires(20, 40)).toBe(false);
  });

  it('fires on a majority across a sufficient window', () => {
    expect(fires(21, 40)).toBe(true);
    expect(fires(30, 30)).toBe(true);
  });
});
