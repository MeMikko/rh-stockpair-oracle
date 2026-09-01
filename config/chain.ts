import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem';
import { CHAIN_ID } from './addresses.js';

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    multicall3: { address: '0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1' },
  },
});

export const env = {
  rpcUrl: process.env.RH_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
  rpcFallbackUrl: process.env.RH_RPC_FALLBACK_URL ?? '',
  logChunk: Number(process.env.RH_LOG_CHUNK ?? 1000),
  dbPath: process.env.DB_PATH ?? './data/oracle.db',
  port: Number(process.env.PORT ?? 8080),
};

let client: PublicClient | undefined;

export function getClient(): PublicClient {
  if (client) return client;
  const urls = [env.rpcUrl, env.rpcFallbackUrl].filter(Boolean);
  // The public endpoint rate limits aggressively (429) and times out under
  // load. Retry generously with backoff rather than surfacing transient 429s
  // as request failures.
  const transports = urls.map((u) =>
    http(u, { timeout: 30_000, retryCount: 6, retryDelay: 1_500, batch: false }),
  );
  client = createPublicClient({
    chain: robinhoodChain,
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
    // No multicall batching: the Multicall3 deployed at the documented RH
    // address is not aggregate3-compatible with viem and makes otherwise-fine
    // reads (StateView.getSlot0) surface as reverts. Call volume is kept down
    // by the persistent token_meta cache instead.
  }) as PublicClient;
  return client;
}

/** True when the configured endpoint is the rate-limited public one. */
export function isPublicRpc(): boolean {
  return env.rpcUrl.includes('rpc.mainnet.chain.robinhood.com');
}
