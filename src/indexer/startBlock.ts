import type { Address } from 'viem';
import { V3, V4 } from '../../config/addresses.js';
import { bsCreationBlock } from '../sources/blockscout.js';

/**
 * Where a genesis backfill should actually start.
 *
 * Chain 4663's block 1 is 2026-04-30, and Uniswap was not deployed until
 * ~9,000 blocks later, so starting at block 1 is harmless but starting at the
 * creation block is honest about what "from genesis" means for this stream.
 *
 * The RPC cannot answer this: the public endpoint keeps no archive state, so
 * eth_getCode at a historical block returns "metadata is not found". The
 * explorer can, which is one of the two reasons it is wired in as a second
 * source. The measured values are cached as fallbacks so a backfill still
 * starts in the right place when the explorer is unreachable.
 */
const MEASURED: Record<'v3' | 'v4', bigint> = {
  // Confirmed 2026-09-02 via Blockscout getcontractcreation.
  v4: 9_070n, // PoolManager  0x8366a3...0951
  v3: 8_930n, // UniswapV3Factory 0x1f7d75...2efa
};

const CONTRACT: Record<'v3' | 'v4', Address> = {
  v4: V4.poolManager as Address,
  v3: V3.factory as Address,
};

export async function discoverStartBlock(which: 'v3' | 'v4'): Promise<bigint> {
  try {
    const blk = await bsCreationBlock(CONTRACT[which]);
    if (blk !== null && blk > 0) {
      const found = BigInt(blk);
      if (found !== MEASURED[which]) {
        console.warn(
          `[startBlock] ${which} creation block is ${found}, recorded ${MEASURED[which]} -- using the live value`,
        );
      }
      return found;
    }
  } catch (err) {
    console.warn(
      `[startBlock] explorer lookup failed (${(err as Error).message.slice(0, 80)}); ` +
        `falling back to recorded block ${MEASURED[which]}`,
    );
  }
  return MEASURED[which];
}
