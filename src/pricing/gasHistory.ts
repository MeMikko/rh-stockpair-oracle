import { getDb } from '../db/index.js';

/** Keep the log short; this is a smoothing window, not an archive. */
const RETAIN = 500;

export interface SubsidyEvidence {
  /** This block only. Flaps, so never publish a claim from it alone. */
  freeAtThisBlock: boolean;
  /** True only if every retained sample in the window was zero. */
  freeAcrossWindow: boolean;
  samples: number;
  windowSeconds: number;
  nonZeroSamples: number;
  lastNonZeroAt: number | null;
  /**
   * Unbroken run of non-zero samples ending at the newest sample; 0 while the
   * newest sample is free. This is the field that separates the two states the
   * counts alone cannot: 26 non-zero out of 107 is a subsidy that has ended if
   * those 26 are the most recent 26, and a flapping reading if they are not.
   */
  currentNonZeroRun: number;
  /**
   * Wall-clock span of that run, in seconds.
   *
   * Carried alongside the count because the two are not interchangeable here:
   * `/gas` records a sample on every request, so a burst of callers can pile up
   * samples minutes apart and inflate a run's length without the chain having
   * charged for any longer. The clock cannot be inflated that way.
   */
  currentNonZeroRunSeconds: number;
  /** Start of the current non-zero run, or null while free. Stable for the life of one run. */
  nonZeroSince: number | null;
  /**
   * Start of the unbroken zero run ending at the newest sample; null while
   * charging. A lower bound: the window may well begin mid-run, in which case
   * calldata was free before this too.
   */
  zeroSince: number | null;
}

export function recordGasSample(
  block: bigint, perL1CalldataUnit: bigint, l1BaseFeeEstimate: bigint, baseFeePerGas: bigint,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO gas_samples (block, observed_at, per_l1_calldata_unit, l1_base_fee_estimate, base_fee_per_gas)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(block) DO NOTHING`,
  ).run(Number(block), Math.floor(Date.now() / 1000), String(perL1CalldataUnit),
        String(l1BaseFeeEstimate), String(baseFeePerGas));
  db.prepare(
    'DELETE FROM gas_samples WHERE block NOT IN (SELECT block FROM gas_samples ORDER BY block DESC LIMIT ?)',
  ).run(RETAIN);
}

/**
 * Summarise what the retained samples actually support.
 *
 * A transient non-zero L1 reading was observed on 2026-09-01 that reverted to
 * zero minutes later, so `freeAtThisBlock` alone would have reported the
 * subsidy as ended. Anything published downstream should key off
 * `freeAcrossWindow`, `currentNonZeroRun` and `nonZeroSamples` instead.
 */
export function subsidyEvidence(freeAtThisBlock: boolean): SubsidyEvidence {
  const rows = getDb().prepare(
    'SELECT observed_at, per_l1_calldata_unit, l1_base_fee_estimate FROM gas_samples ORDER BY block DESC',
  ).all() as { observed_at: number; per_l1_calldata_unit: string; l1_base_fee_estimate: string }[];

  const charged = (r: { per_l1_calldata_unit: string; l1_base_fee_estimate: string }) =>
    r.per_l1_calldata_unit !== '0' || r.l1_base_fee_estimate !== '0';

  const nonZero = rows.filter(charged);
  const times = rows.map((r) => Number(r.observed_at));

  // Rows are newest-first, so the leading stretch of like-valued samples is the
  // run in progress. Exactly one of the two runs below is non-empty.
  let nonZeroRun = 0;
  while (nonZeroRun < rows.length && charged(rows[nonZeroRun]!)) nonZeroRun++;
  let zeroRun = 0;
  while (zeroRun < rows.length && !charged(rows[zeroRun]!)) zeroRun++;

  const newestAt = rows.length > 0 ? Number(rows[0]!.observed_at) : 0;
  const nonZeroSince = nonZeroRun > 0 ? Number(rows[nonZeroRun - 1]!.observed_at) : null;

  return {
    freeAtThisBlock,
    freeAcrossWindow: rows.length > 0 && nonZero.length === 0,
    samples: rows.length,
    windowSeconds: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    nonZeroSamples: nonZero.length,
    lastNonZeroAt: nonZero.length > 0 ? Number(nonZero[0]!.observed_at) : null,
    currentNonZeroRun: nonZeroRun,
    currentNonZeroRunSeconds: nonZeroSince === null ? 0 : newestAt - nonZeroSince,
    nonZeroSince,
    zeroSince: zeroRun > 0 ? Number(rows[zeroRun - 1]!.observed_at) : null,
  };
}
