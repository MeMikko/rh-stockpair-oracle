export const MAX_SLIPPAGE_BPS = 5_000;

/**
 * Apply a slippage tolerance to a quoted output to get min-out.
 *
 * Integer maths throughout, rounding down, so the result is never optimistic:
 * a min-out that rounds up would let a swap execute slightly worse than the
 * caller asked for. This is the number that protects the signer, so it is a
 * pure function with its own tests rather than an expression inside a handler.
 */
export function applySlippage(quotedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps)) throw new RangeError('slippageBps must be an integer');
  if (slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new RangeError(`slippageBps must be between 0 and ${MAX_SLIPPAGE_BPS}`);
  }
  if (quotedOut < 0n) throw new RangeError('quotedOut must be non-negative');
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
