import { describe, it, expect, beforeEach } from 'vitest';

// Point the DB at a scratch file before any module reads env.
process.env.DB_PATH = './data/test-gas.db';
const { recordGasSample, subsidyEvidence } = await import('../src/pricing/gasHistory.js');
const { getDb } = await import('../src/db/index.js');
const { gasAnswer } = await import('../src/answer/answer.js');
const { verifyDraft } = await import('../src/agent/verify.js');
type SubsidyEvidence = import('../src/pricing/gasHistory.js').SubsidyEvidence;
type GasSnapshot = import('../src/pricing/gas.js').GasSnapshot;

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
 * Contiguity is the whole point of the run fields: the same counts describe
 * both a subsidy that has ended and a reading that flaps, and only the order
 * of the samples tells them apart.
 */
describe('subsidyEvidence run tracking', () => {
  beforeEach(() => { getDb().exec('DELETE FROM gas_samples'); });

  /** Blocks ascend with time, so the newest sample is the highest block. */
  const record = (block: number, charged: boolean) =>
    recordGasSample(BigInt(block), charged ? 5n : 0n, 0n, 300n);

  it('counts the run of charged samples ending at the newest one', () => {
    for (let b = 1; b <= 10; b++) record(b, false);
    for (let b = 11; b <= 16; b++) record(b, true);

    const e = subsidyEvidence(false);
    expect(e.currentNonZeroRun).toBe(6);
    expect(e.nonZeroSamples).toBe(6);
    expect(e.zeroSince).toBeNull();
    expect(e.nonZeroSince).not.toBeNull();
  });

  it('reports no run once the reading reverts, however many samples were charged', () => {
    // The 2026-09-02 shape: a burst of charged samples, then free again.
    for (let b = 1; b <= 4; b++) record(b, false);
    for (let b = 5; b <= 8; b++) record(b, true);
    for (let b = 9; b <= 12; b++) record(b, false);

    const e = subsidyEvidence(true);
    expect(e.nonZeroSamples).toBe(4);
    expect(e.currentNonZeroRun).toBe(0);
    expect(e.currentNonZeroRunSeconds).toBe(0);
    expect(e.nonZeroSince).toBeNull();
    expect(e.zeroSince).not.toBeNull();
  });

  it('separates an ended subsidy from a flap that shares its counts', () => {
    // Four charged of twelve, both times. Only the order differs.
    for (let b = 1; b <= 8; b++) record(b, false);
    for (let b = 9; b <= 12; b++) record(b, true);
    const ended = subsidyEvidence(false);

    getDb().exec('DELETE FROM gas_samples');
    for (const b of [1, 2, 3, 4, 6, 8, 10, 12]) record(b, false);
    for (const b of [5, 7, 9, 11]) record(b, true);
    const flapping = subsidyEvidence(true);

    expect(flapping.nonZeroSamples).toBe(ended.nonZeroSamples);
    expect(flapping.samples).toBe(ended.samples);
    expect(ended.currentNonZeroRun).toBe(4);
    expect(flapping.currentNonZeroRun).toBe(0);
  });

  it('has no run across an empty window', () => {
    const e = subsidyEvidence(true);
    expect(e.currentNonZeroRun).toBe(0);
    expect(e.zeroSince).toBeNull();
    expect(e.nonZeroSince).toBeNull();
  });
});

/**
 * The subsidy claim is the one this agent must never publish on noise: the L1
 * reading flaps, and "the subsidy has ended" cannot be retracted once posted.
 */
describe('gas subsidy signal thresholds', () => {
  // Mirrors the gate in detectGasSubsidy: an unbroken run, long in both
  // samples and wall clock. Neither alone is sufficient -- /gas records a
  // sample per request, so callers can stack samples into minutes, and the
  // watcher can stall and stretch few samples across hours.
  const fires = (run: number, runSeconds: number) =>
    run >= 12 && runSeconds >= 3 * 60 * 60;

  const hours = (h: number) => h * 60 * 60;

  it('stays silent when nothing is being charged right now', () => {
    expect(fires(0, 0)).toBe(false);
  });

  it('stays silent on a ten-minute flap, however densely sampled', () => {
    expect(fires(40, 10 * 60)).toBe(false);
  });

  it('stays silent on a long span carried by too few samples', () => {
    // A stalled watcher: two samples six hours apart say nothing about the
    // six hours between them.
    expect(fires(2, hours(6))).toBe(false);
  });


  it('fires on an unbroken run that clears both thresholds', () => {
    expect(fires(36, hours(3))).toBe(true);
    expect(fires(12, hours(4))).toBe(true);
  });
});

/**
 * The `/ask` gas answer verifies itself against its own facts before it is
 * returned, so a template that quotes a number it did not publish as a fact
 * degrades the whole answer to "I don't know". That is exactly what happened
 * when the run text was first written with minutes derived at render time --
 * caught by a smoke run, not by a test, hence this one.
 */
describe('gasAnswer verifies against its own facts', () => {
  const snapshot = (e: Partial<SubsidyEvidence>): GasSnapshot => ({
    blockNumber: '53210102', baseFeePerGas: '10000000', gasPrice: '10000000',
    minimumGasPrice: '20000000', congestionWei: '0', perArbGasTotal: '10000000',
    perL1CalldataUnit: '64181840', l1BaseFeeEstimate: '4009', gasBacklog: '0',
    subsidy: {
      l1DataFreeNow: e.freeAcrossWindow ?? false,
      expectedEnd: '2026-09-30',
      note: '',
      evidence: {
        freeAtThisBlock: false, freeAcrossWindow: false, samples: 107,
        windowSeconds: 32100, nonZeroSamples: 26, lastNonZeroAt: 1788417042,
        currentNonZeroRun: 0, currentNonZeroRunSeconds: 0,
        nonZeroSince: null, zeroSince: 1788405342, ...e,
      },
    },
  });

  const cases: [string, Partial<SubsidyEvidence>][] = [
    ['subsidy active', { freeAcrossWindow: true, nonZeroSamples: 0, samples: 107 }],
    ['flapping, free right now', { currentNonZeroRun: 0 }],
    // 11700s / 60 = 195 exactly; the first version of this template put that
    // 195 in the text while the facts carried only 11700, and the answer was
    // refused outright.
    ['charged, unbroken run', { currentNonZeroRun: 40, currentNonZeroRunSeconds: 11700, zeroSince: null, nonZeroSince: 1788405342 }],
    // A run whose seconds do not divide evenly, so the rounded minutes are a
    // number no other fact happens to supply.
    ['charged, run rounding to an odd minute', { currentNonZeroRun: 13, currentNonZeroRunSeconds: 11045, zeroSince: null, nonZeroSince: 1788405342 }],
  ];

  for (const [name, evidence] of cases) {
    it(`emits a verifiable answer when ${name}`, () => {
      const a = gasAnswer(snapshot(evidence));
      const v = verifyDraft(a.text, a.facts);
      expect(v.unsupported).toEqual([]);
      expect(v.ok).toBe(true);
    });
  }

  it('says which of the three states it is in', () => {
    expect(gasAnswer(snapshot({ freeAcrossWindow: true })).text).toContain('subsidy is still active');
    expect(gasAnswer(snapshot({ currentNonZeroRun: 0 })).text).toContain('flaps');
    expect(gasAnswer(snapshot({ currentNonZeroRun: 40, currentNonZeroRunSeconds: 11700 })).text)
      .toContain('40 consecutive samples, spanning 195 minutes');
  });
});
