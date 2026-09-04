/**
 * Which recorded prices are not fit to compute a statistic from.
 *
 * The lesson is borrowed, the rule is not. HoodGrow — the same operator's
 * earlier service on this chain — stored 60 days of prices before noticing
 * that some were mids of a one-sided quote book: numbers nothing had traded
 * at. Measured over adjacent snapshots, its quote-derived cohort produced 122
 * moves of 10% or more across 99,464 pairs where the Chainlink control
 * produced zero across 39,914. The rows could not be repaired, because only
 * the mid had been kept.
 *
 * **Our prices are not mids, and the difference matters.** An AMM spot price
 * comes from the pool's own reserves, so it only moves because someone traded
 * against it. A 10% jump here is a real trade, not a phantom quote.
 *
 * What it is instead is a trade large relative to the pool's depth — and a
 * price set by one order that size is a statement about that order, not about
 * a market. For a drift statistic against Chainlink that is just as unusable
 * as a mid nobody traded at, so it is flagged for a different reason and under
 * an honest name: `adjacent-jump` says what was observed, not what it means.
 *
 * The threshold is inherited rather than measured here, and that is stated
 * rather than hidden: 10% is HoodGrow's figure from a different price source.
 * Ours is recomputable — `npm run flag:prices` re-derives every flag from
 * stored rows — so when this deployment has enough history to measure its own
 * distribution, the number can be replaced and the past re-flagged. That is
 * possible only because the raw sqrtPriceX96 is stored alongside the derived
 * price, which is the actual thing HoodGrow could not do.
 */

/** A move between adjacent samples too large for the price to describe a market. */
export const FLAG_ADJACENT_JUMP = 'adjacent-jump';

/**
 * Percentage move between consecutive samples that marks a row.
 *
 * Deliberately over-flags. A real move that size gets marked and a consumer
 * loses a little coverage; an unmarked one costs them a wrong conclusion about
 * how far a pool drifts overnight. Those are not symmetric.
 */
export const JUMP_PERCENT = 10;

/**
 * How far apart two samples may be and still count as consecutive.
 *
 * The sampler runs every 15 minutes, so 20 leaves room for a late sweep
 * without spanning a gap. Without this bound the comparison silently reaches
 * across missing samples and reports two days of ordinary movement as a jump —
 * the failure that produced 23 phantom anomalies in HoodGrow's first pass, all
 * at one hour of the day, one per symbol, which is what gave it away.
 */
export const MAX_GAP_MINUTES = 20;

export interface AdjacentSample {
  /** currency1 per currency0, as recorded. */
  spot: number;
  /** Milliseconds since epoch. */
  at: number;
}

/**
 * The flag for a sample given the one before it, or null.
 *
 * Pure, so the sampler and the recompute script cannot disagree about what a
 * flag means. A second definition in SQL would be free to drift from this one.
 */
export function flagForAdjacent(
  previous: AdjacentSample | null,
  current: AdjacentSample,
): string | null {
  if (previous === null) return null;
  if (!(previous.spot > 0) || !(current.spot > 0)) return null;

  const gapMinutes = (current.at - previous.at) / 60_000;
  // Non-positive would mean the caller handed them in the wrong order. Treat
  // that as not comparable rather than taking an absolute value and inventing
  // an adjacency that was never established.
  if (gapMinutes <= 0 || gapMinutes > MAX_GAP_MINUTES) return null;

  const movePercent = (Math.abs(current.spot - previous.spot) / previous.spot) * 100;
  return movePercent >= JUMP_PERCENT ? FLAG_ADJACENT_JUMP : null;
}
