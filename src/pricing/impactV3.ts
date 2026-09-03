import type { Address } from 'viem';
import { getClient } from '../../config/chain.js';
import { V3 } from '../../config/addresses.js';
import { V3_QUOTER_V2_ABI } from '../abi.js';
import { decodeQuoterError, extractRevertData } from './quoterErrors.js';
import { QuoterError, type ImpactResult } from './impact.js';

/**
 * Exact price impact for a v3 pool, via QuoterV2.
 *
 * Same rule as v4: impact comes from a simulation, never from a closed-form
 * estimate over the active tick. The difference is only in how the pool is
 * addressed — v3 quotes by (tokenIn, tokenOut, fee) rather than by a pool key,
 * and has no hook to reject the swap, so a revert here is about the pool
 * itself.
 */
export async function quoteExactInV3(opts: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  /** Spot as currency1 per currency0, so impact is comparable across protocols. */
  spotPrice: number;
  zeroForOne: boolean;
  decimalsIn: number;
  decimalsOut: number;
}): Promise<ImpactResult> {
  let result: readonly [bigint, bigint, number, bigint];
  try {
    const sim = await getClient().simulateContract({
      address: V3.quoterV2 as Address,
      abi: V3_QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: opts.tokenIn,
          tokenOut: opts.tokenOut,
          amountIn: opts.amountIn,
          fee: opts.fee,
          // No price limit: the question is what the swap would cost, not
          // whether it can be held under a bound the caller did not ask for.
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    result = sim.result as readonly [bigint, bigint, number, bigint];
  } catch (err) {
    // The v3 quoter does not wrap reverts the way the v4 one does, but the
    // decoder handles a bare revert string too, and reusing it keeps one
    // vocabulary of failures across both protocols.
    const decoded = decodeQuoterError(extractRevertData(err));
    throw new QuoterError(decoded.reason, false);
  }

  const [amountOut, , ticksCrossed, gasEstimate] = result;
  const inHuman = Number(opts.amountIn) / 10 ** opts.decimalsIn;
  const outHuman = Number(amountOut) / 10 ** opts.decimalsOut;
  const executionPrice = inHuman === 0 ? 0 : outHuman / inHuman;

  const spot = opts.zeroForOne ? opts.spotPrice : 1 / opts.spotPrice;
  const priceImpact = spot === 0 ? 0 : Math.max(0, (spot - executionPrice) / spot);

  return {
    amountIn: opts.amountIn,
    amountOut,
    executionPrice,
    priceImpact,
    gasEstimate,
    source: 'quoter-v3',
    ticksCrossed,
  };
}
