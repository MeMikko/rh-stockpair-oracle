import type { Address } from 'viem';
import { getClient } from '../../config/chain.js';
import { V3_POOL_ABI } from '../abi.js';

/**
 * State of a v3 pool.
 *
 * v3 keeps its state in the pool contract rather than behind a singleton, so
 * this reads the pool directly instead of going through StateView. The numbers
 * that come out mean the same thing as v4's, which is why the price and depth
 * maths in `poolState.ts` is shared rather than duplicated: both protocols use
 * the same Q64.96 square-root price and the same active-tick liquidity.
 *
 * v3 carries about a third of stock-paired volume on this chain, and four of
 * the five largest stock-paired pools are v3. A quote endpoint that only
 * spoke v4 was indexing the truth and publishing a subset of it.
 */
export interface V3PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  /** The pool's static fee, read live rather than trusted from the index. */
  fee: number;
  /**
   * False while a swap is mid-flight inside the pool's own reentrancy lock.
   * Reported rather than acted on: it is transient, and a caller seeing it
   * should retry rather than conclude anything about the pool.
   */
  unlocked: boolean;
}

export async function readV3PoolState(pool: Address): Promise<V3PoolState> {
  const client = getClient();
  const [slot0, liquidity, fee] = await Promise.all([
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'slot0' }),
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'liquidity' }),
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'fee' }),
  ]);

  return {
    sqrtPriceX96: slot0[0],
    tick: Number(slot0[1]),
    liquidity,
    fee: Number(fee),
    unlocked: Boolean(slot0[6]),
  };
}
