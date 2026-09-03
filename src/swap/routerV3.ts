import type { Address } from 'viem';
import { getClient } from '../../config/chain.js';
import { V3 } from '../../config/addresses.js';
import { V3_SWAP_ROUTER_02_ABI } from '../abi.js';

/**
 * Which v3 router is actually deployed, established by asking it.
 *
 * Uniswap shipped two: `SwapRouter` carries the deadline inside the
 * ExactInputSingle struct, `SwapRouter02` dropped it and enforces one through
 * `multicall(deadline, data)`. One field's difference changes the struct, which
 * changes the selector — calldata built for the wrong one is not slightly
 * wrong, it is a call the contract does not have. Half-correct calldata is
 * worse than none, so this is read rather than assumed from the fact that a
 * config key happens to be named `swapRouter02`.
 *
 * `factoryV2()` is the probe: it exists only on SwapRouter02, it is a view
 * call, and it costs one eth_call the first time a v3 swap is encoded.
 *
 * Set V3_ROUTER_VARIANT to pin it when the RPC cannot be reached — but a pin
 * is a claim, and it is reported as `config` rather than `chain` so a reader
 * can tell which they are looking at.
 */
export type V3RouterVariant = 'swap-router-02' | 'swap-router-01';

export interface V3RouterFacts {
  address: Address;
  variant: V3RouterVariant;
  /** How the variant was established. `chain` is the only one that measured it. */
  source: 'chain' | 'config';
  /** Where the deadline lives in this variant's calldata. */
  deadlineIn: 'multicall' | 'params';
}

let cached: V3RouterFacts | undefined;

function pinned(): V3RouterVariant | null {
  const v = process.env.V3_ROUTER_VARIANT?.trim();
  if (v === 'swap-router-02' || v === 'swap-router-01') return v;
  return null;
}

export class RouterVariantUnknown extends Error {}

export async function v3RouterFacts(): Promise<V3RouterFacts> {
  if (cached) return cached;

  const address = V3.swapRouter02 as Address;
  const pin = pinned();
  if (pin) {
    cached = {
      address,
      variant: pin,
      source: 'config',
      deadlineIn: pin === 'swap-router-02' ? 'multicall' : 'params',
    };
    return cached;
  }

  try {
    await getClient().readContract({
      address,
      abi: V3_SWAP_ROUTER_02_ABI,
      functionName: 'factoryV2',
    });
    cached = { address, variant: 'swap-router-02', source: 'chain', deadlineIn: 'multicall' };
    return cached;
  } catch (err) {
    // A revert here means the function is absent, which is the SwapRouter01
    // answer. A transport failure means we learned nothing, and the two must
    // not be confused: concluding "01" from an unreachable RPC would emit
    // calldata for a router that may not exist.
    const message = (err as Error).message ?? '';
    const reverted = /revert|execution reverted|returned no data|0x$/i.test(message);
    if (!reverted) {
      throw new RouterVariantUnknown(
        `could not read factoryV2() on ${address}: ${message.split('\n')[0]}`,
      );
    }
    cached = { address, variant: 'swap-router-01', source: 'chain', deadlineIn: 'params' };
    return cached;
  }
}

/** Testing seam: drop the memoised probe result. */
export function resetV3RouterFacts(): void {
  cached = undefined;
}
