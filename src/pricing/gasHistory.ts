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
 * `freeAcrossWindow` and `nonZeroSamples` instead.
 */
export function subsidyEvidence(freeAtThisBlock: boolean): SubsidyEvidence {
  const rows = getDb().prepare(
    'SELECT observed_at, per_l1_calldata_unit, l1_base_fee_estimate FROM gas_samples ORDER BY block DESC',
  ).all() as { observed_at: number; per_l1_calldata_unit: string; l1_base_fee_estimate: string }[];

  const nonZero = rows.filter(
    (r) => r.per_l1_calldata_unit !== '0' || r.l1_base_fee_estimate !== '0',
  );
  const times = rows.map((r) => Number(r.observed_at));

  return {
    freeAtThisBlock,
    freeAcrossWindow: rows.length > 0 && nonZero.length === 0,
    samples: rows.length,
    windowSeconds: times.length > 1 ? Math.max(...times) - Math.min(...times) : 0,
    nonZeroSamples: nonZero.length,
    lastNonZeroAt: nonZero.length > 0 ? Number(nonZero[0]!.observed_at) : null,
  };
}
