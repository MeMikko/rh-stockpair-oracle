import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { paymentConfig } from '../../config/payments.js';

/**
 * One Base client, shared.
 *
 * Two modules read Base now — the transfer verifier and the asset domain
 * reader — and a second client would mean a second connection pool and a
 * second place to get the RPC URL wrong.
 */
let client: PublicClient | undefined;

export function baseClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: base,
      transport: http(paymentConfig.rpcUrl, { timeout: 20_000, retryCount: 3 }),
    }) as PublicClient;
  }
  return client;
}
