import type { Address } from 'viem';

/**
 * What pro costs, where it is paid, and for how long.
 *
 * Every value here was confirmed rather than typed from memory: both addresses
 * are checksum-verified, because a wrong treasury address does not fail — it
 * silently accepts money nobody can retrieve.
 */

/** Base mainnet. Where the payers' funds actually are. */
export const PAYMENT_CHAIN_ID = 8453;

export const paymentConfig = {
  rpcUrl: process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org',

  /** Checksum verified 2026-09-02. */
  treasury: '0x8520B3693a2Cf3c2bEa3a505Af3A9c1b093954c7' as Address,

  /** Native USDC on Base, 6 decimals. Checksum verified 2026-09-02. */
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  usdcDecimals: 6,

  /** $5.99 for 30 days, bought one period at a time. */
  priceUsd: 5.99,
  periodDays: 30,

  /**
   * Confirmations before a payment counts.
   *
   * Base reorgs are shallow and rare, but granting on an unconfirmed transfer
   * means granting on one that can disappear. Cheap insurance against the one
   * failure mode that hands out entitlements for money that never arrived.
   */
  confirmations: 3,
};

/** Price in USDC base units. Integer arithmetic: never float-compare money. */
export function priceUnits(): bigint {
  return BigInt(Math.round(paymentConfig.priceUsd * 10 ** paymentConfig.usdcDecimals));
}

/** Human-readable amount from base units, for display only. */
export function formatUsdc(units: bigint): string {
  const d = BigInt(10 ** paymentConfig.usdcDecimals);
  return `${units / d}.${String(units % d).padStart(paymentConfig.usdcDecimals, '0').slice(0, 2)}`;
}

/**
 * Access tiers that are not bought with money.
 *
 * Token-gating is designed in from the start but dormant: there is no token
 * yet, and inventing a placeholder address would produce a check that appears
 * to work and gates nothing. When a token exists, set the address and minimum
 * balance; `source: token:<address>` already fits the entitlements table.
 */
export const tokenGate = {
  enabled: Boolean(process.env.PRO_TOKEN_ADDRESS?.trim()),
  address: process.env.PRO_TOKEN_ADDRESS?.trim() ?? '',
  minBalance: process.env.PRO_TOKEN_MIN_BALANCE?.trim() ?? '0',
  chainId: Number(process.env.PRO_TOKEN_CHAIN_ID ?? PAYMENT_CHAIN_ID),
};
