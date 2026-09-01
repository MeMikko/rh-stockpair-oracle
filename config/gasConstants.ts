/** Arbitrum Nitro precompile addresses (identical across Orbit chains). */
export const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C';
export const NODE_INTERFACE = '0x00000000000000000000000000000000000000C8';
export const ARB_SYS = '0x0000000000000000000000000000000000000064';

/**
 * Robinhood Chain launched with a 90-day gas subsidy that is reported to end
 * in late September 2026. We do not hardcode that date as fact: /gas reports
 * whether the subsidy is *observably* active by reading the L1 calldata price
 * from the chain, so the endpoint stays correct whenever it actually ends.
 */
export const SUBSIDY_EXPECTED_END = '2026-09-30';
