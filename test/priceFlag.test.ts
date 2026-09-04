import { describe, it, expect } from 'vitest';
import {
  flagForAdjacent, FLAG_ADJACENT_JUMP, JUMP_PERCENT, MAX_GAP_MINUTES,
} from '../src/history/priceFlag.js';

/**
 * The rule alone, as a pure function.
 *
 * Separate from the storage tests on purpose: the rule is what the recompute
 * script and the sampler must agree about, and a second definition of it — in
 * SQL, or inlined at a call site — would be free to drift from this one.
 */
const at = (minutes: number) => minutes * 60_000;

describe('adjacent-jump', () => {
  it('has nothing to say about the first sample', () => {
    expect(flagForAdjacent(null, { spot: 100, at: 0 })).toBeNull();
  });

  it('passes a move under the threshold', () => {
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 109.9, at: at(15) })).toBeNull();
  });

  it('flags a move at the threshold, in both directions', () => {
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 110, at: at(15) })).toBe(FLAG_ADJACENT_JUMP);
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 90, at: at(15) })).toBe(FLAG_ADJACENT_JUMP);
  });

  /**
   * The bound that stops two days of ordinary movement reading as one jump.
   * Its absence produced 23 phantom anomalies in the measurement this rule is
   * borrowed from — all at one hour of the day, one per symbol.
   */
  it('refuses to compare across a gap longer than the sampling interval allows', () => {
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 300, at: at(MAX_GAP_MINUTES + 1) })).toBeNull();
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 300, at: at(MAX_GAP_MINUTES) })).toBe(
      FLAG_ADJACENT_JUMP,
    );
  });

  /** Out-of-order input is not comparable; it must not become comparable by abs(). */
  it('treats a backwards pair as not comparable rather than reordering it', () => {
    expect(flagForAdjacent({ spot: 100, at: at(10) }, { spot: 300, at: 0 })).toBeNull();
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 300, at: 0 })).toBeNull();
  });

  it('says nothing about a non-positive price rather than dividing by it', () => {
    expect(flagForAdjacent({ spot: 0, at: 0 }, { spot: 100, at: at(5) })).toBeNull();
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 0, at: at(5) })).toBeNull();
  });

  it('measures the move against the earlier price, not the later one', () => {
    // 100 -> 111 is +11% of 100 and -9.9% of 111. Only one of those is the
    // move that happened, and picking the other would silently under-flag
    // every rise and over-flag every fall.
    expect(flagForAdjacent({ spot: 100, at: 0 }, { spot: 111, at: at(5) })).toBe(FLAG_ADJACENT_JUMP);
    expect(flagForAdjacent({ spot: 111, at: 0 }, { spot: 100, at: at(5) })).toBeNull();
  });

  it('states its threshold rather than hiding it in a comparison', () => {
    expect(JUMP_PERCENT).toBe(10);
    expect(MAX_GAP_MINUTES).toBe(20);
  });
});
