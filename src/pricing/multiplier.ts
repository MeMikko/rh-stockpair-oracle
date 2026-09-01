import type { Address } from 'viem';
import { getClient } from '../../config/chain.js';
import { STOCK_TOKEN_ABI } from '../abi.js';

export interface MultiplierState {
  current: bigint;        // 1e18-scaled
  pending: bigint | null; // set only when it differs from current
  effectiveAt: number;    // unix seconds; 0 = never adjusted
  oraclePaused: boolean;
  /** A corporate action is scheduled and has not taken effect yet. */
  actionPending: boolean;
}

/**
 * ERC-8056 state for a stock token.
 *
 * IMPORTANT -- multiplier vs Chainlink. RH's docs state the on-chain Chainlink
 * feed already returns the multiplier-adjusted value and that integrators must
 * NOT apply the multiplier a second time. We therefore treat the feed answer as
 * USD per raw token unit and never multiply by uiMultiplier in the USD path.
 * The multiplier is still surfaced in /quote so a consumer can verify, and
 * scripts/check-multiplier-convention.ts tests the assumption empirically
 * against a stock/USDG pool.
 */
export async function readMultiplier(token: Address): Promise<MultiplierState> {
  const client = getClient();
  const [current, pending, effectiveAt, oraclePaused] = await Promise.all([
    client.readContract({ address: token, abi: STOCK_TOKEN_ABI, functionName: 'uiMultiplier' }),
    client.readContract({ address: token, abi: STOCK_TOKEN_ABI, functionName: 'newUIMultiplier' }).catch(() => null),
    client.readContract({ address: token, abi: STOCK_TOKEN_ABI, functionName: 'effectiveAt' }).catch(() => 0n),
    client.readContract({ address: token, abi: STOCK_TOKEN_ABI, functionName: 'oraclePaused' }).catch(() => false),
  ]);

  const eff = Number(effectiveAt ?? 0n);
  const now = Math.floor(Date.now() / 1000);
  const pendingDiffers = pending !== null && pending !== current;

  return {
    current,
    pending: pendingDiffers ? pending : null,
    effectiveAt: eff,
    oraclePaused: Boolean(oraclePaused),
    actionPending: pendingDiffers && eff > now,
  };
}
