import type { Address, Hex } from 'viem';
import { getClient } from '../../config/chain.js';
import { V4, DYNAMIC_FEE_FLAG } from '../../config/addresses.js';
import { STATE_VIEW_ABI } from '../abi.js';

export interface PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  /** Live LP fee. For dynamic-fee pools this is the only meaningful fee. */
  lpFee: number;
  liquidity: bigint;
  isDynamicFee: boolean;
}

export async function readPoolState(poolId: Hex, storedFee: number): Promise<PoolState> {
  const client = getClient();
  const [slot0, liquidity] = await Promise.all([
    client.readContract({
      address: V4.stateView as Address, abi: STATE_VIEW_ABI,
      functionName: 'getSlot0', args: [poolId],
    }),
    client.readContract({
      address: V4.stateView as Address, abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity', args: [poolId],
    }),
  ]);

  return {
    sqrtPriceX96: slot0[0],
    tick: Number(slot0[1]),
    protocolFee: Number(slot0[2]),
    lpFee: Number(slot0[3]),
    liquidity,
    isDynamicFee: storedFee === DYNAMIC_FEE_FLAG,
  };
}

const Q96 = 2n ** 96n;

/**
 * Spot price of currency0 denominated in currency1, in human units.
 *
 * Done in floating point deliberately: this is a display/deviation number, not
 * a settlement number. Anything that must be exact (min-out, impact) goes
 * through the on-chain Quoter instead.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}

/**
 * Rough single-sided depth: token1 reserves implied by the active tick's
 * liquidity. Labelled an estimate everywhere it surfaces, because concentrated
 * liquidity outside the active range is not counted.
 */
export function activeLiquidityDepth(
  liquidity: bigint, sqrtPriceX96: bigint, decimals0: number, decimals1: number,
): { token0: number; token1: number } {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return { token0: 0, token1: 0 };
  const L = Number(liquidity);
  const sqrtP = Number(sqrtPriceX96) / Number(Q96);
  return {
    token0: (L / sqrtP) / 10 ** decimals0,
    token1: (L * sqrtP) / 10 ** decimals1,
  };
}
