import type { Address, Hex } from 'viem';
import { getClient } from '../../config/chain.js';
import { V4 } from '../../config/addresses.js';
import { V4_QUOTER_ABI } from '../abi.js';
import type { PoolKey } from '../indexer/poolKey.js';
import { decodeQuoterError, extractRevertData } from './quoterErrors.js';

export interface ImpactResult {
  amountIn: bigint;
  amountOut: bigint;
  /** Execution price, human units of out per unit of in. */
  executionPrice: number;
  /** Fractional shortfall vs spot, e.g. 0.0123 = 1.23%. */
  priceImpact: number;
  gasEstimate: bigint;
  /** Which quoter produced it. Published, so a consumer can tell them apart. */
  source: 'quoter' | 'quoter-v3';
  /**
   * v3 only: initialized ticks the swap crossed. A high count on a small size
   * is the clearest signal that a pool's liquidity is fragmented.
   */
  ticksCrossed?: number;
}

/** A quote that failed for a reason we could name. */
export class QuoterError extends Error {
  constructor(
    public readonly reason: string,
    /** True when the revert came from the pool's hook, not the pool itself. */
    public readonly fromHook: boolean,
  ) {
    super(reason);
    this.name = 'QuoterError';
  }
}

/**
 * Exact price impact via the on-chain v4 Quoter.
 *
 * Preferred over any closed-form estimate because it honours the pool's hook
 * and its live (possibly dynamic) fee -- both of which are the norm on RH,
 * where launchpad hooks and non-standard fee values are routine.
 *
 * The Quoter is nonpayable and signals through reverts, so this goes through
 * eth_call. When a hook rejects the swap the failure is named rather than
 * swallowed; callers fall back to the liquidity depth estimate and label it.
 */
export async function quoteExactIn(
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  spotPrice: number,
  decimalsIn: number,
  decimalsOut: number,
): Promise<ImpactResult> {
  let result: readonly [bigint, bigint];
  try {
    const sim = await getClient().simulateContract({
      address: V4.quoter as Address,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' as Hex }],
    });
    result = sim.result as readonly [bigint, bigint];
  } catch (err) {
    const decoded = decodeQuoterError(extractRevertData(err));
    throw new QuoterError(decoded.reason, decoded.wrapped);
  }

  const [amountOut, gasEstimate] = result;
  const inHuman = Number(amountIn) / 10 ** decimalsIn;
  const outHuman = Number(amountOut) / 10 ** decimalsOut;
  const executionPrice = inHuman === 0 ? 0 : outHuman / inHuman;

  // spotPrice is always currency1 per currency0; invert when selling currency1
  // so the comparison is like-for-like.
  const spot = zeroForOne ? spotPrice : 1 / spotPrice;
  const priceImpact = spot === 0 ? 0 : Math.max(0, (spot - executionPrice) / spot);

  return { amountIn, amountOut, executionPrice, priceImpact, gasEstimate, source: 'quoter' };
}
