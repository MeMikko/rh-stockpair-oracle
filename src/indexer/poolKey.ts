import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * v4 PoolId = keccak256 of the abi-encoded PoolKey (5 words / 0xa0 bytes),
 * matching PoolIdLibrary.toId.
 *
 * We recompute this for every indexed pool and assert it against the id in the
 * Initialize event. If they ever disagree, our stored PoolKey is wrong and any
 * quote built from it would be wrong too -- so it is cheaper to catch here.
 */
export function computePoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}
