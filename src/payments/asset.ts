import { parseAbi } from 'viem';
import { paymentConfig } from '../../config/payments.js';
import { x402Config } from '../../config/x402.js';
import { baseClient } from './baseClient.js';

/**
 * The EIP-712 domain a payer signs against, read from the token.
 *
 * An `exact` payment is an EIP-3009 `transferWithAuthorization` signature, and
 * that signature is bound to the token's own EIP-712 domain — its `name` and
 * `version`. Get either wrong and the signature the client produces is valid
 * for a domain that does not exist: the facilitator rejects it, and the caller
 * is told "invalid signature" about a signature that is fine.
 *
 * Both values are on the contract, so they are read rather than remembered.
 * USDC on Base reports name "USD Coin" and version "2"; that sentence is the
 * sort of thing that is true until it is not, which is why it is a comment
 * here and a contract call below.
 */

const ABI = parseAbi(['function name() view returns (string)', 'function version() view returns (string)']);

export interface AssetDomain {
  name: string;
  version: string;
  /** How it was established, so a caller can see whether it was checked. */
  source: 'chain' | 'config' | 'fallback';
}

let cached: AssetDomain | undefined;

/**
 * Cached for the process lifetime. A token's EIP-712 domain does not change
 * without a redeploy of the token, and re-reading it per request would put an
 * RPC round trip in front of every 402.
 */
export async function assetDomain(): Promise<AssetDomain> {
  if (cached) return cached;

  if (x402Config.assetName && x402Config.assetVersion) {
    cached = { name: x402Config.assetName, version: x402Config.assetVersion, source: 'config' };
    return cached;
  }

  try {
    const [name, version] = await Promise.all([
      baseClient().readContract({ address: paymentConfig.usdc, abi: ABI, functionName: 'name' }),
      baseClient().readContract({ address: paymentConfig.usdc, abi: ABI, functionName: 'version' }),
    ]);
    cached = { name: String(name), version: String(version), source: 'chain' };
    return cached;
  } catch {
    // Not cached: a failed read is a transient RPC problem, and caching it
    // would make one bad minute permanent for the life of the process. The
    // fallback is what native USDC on Base returns today, which is better
    // than omitting `extra` entirely and leaving the client to guess.
    return { name: 'USD Coin', version: '2', source: 'fallback' };
  }
}

/** Testing seam: drop the memoised domain. */
export function resetAssetDomain(): void {
  cached = undefined;
}
