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

export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * Resolve the RPC endpoint. An explicit RH_RPC_URL always wins; otherwise an
 * ALCHEMY_API_KEY is expanded into RH's Alchemy endpoint. The key is read from
 * the environment and never written anywhere -- log lines print the host only.
 */
function resolveRpcUrl(): string {
  const explicit = process.env.RH_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (key) return `https://robinhood-mainnet.g.alchemy.com/v2/${key}`;
  return PUBLIC_RPC;
}

const rpcUrl = resolveRpcUrl();
const onPublic = rpcUrl.includes('rpc.mainnet.chain.robinhood.com');

export const env = {
  rpcUrl,
  rpcFallbackUrl: process.env.RH_RPC_FALLBACK_URL ?? '',
  /**
   * Starting eth_getLogs span. The public endpoint rejects anything over ~1000
   * blocks outright. Dedicated endpoints cap on *result count* rather than
   * range, so the backfill starts wide and lets the adaptive controller find
   * the ceiling -- 52M blocks cannot be walked 1000 at a time.
   */
  logChunk: Number(process.env.RH_LOG_CHUNK ?? (onPublic ? 1_000 : 100_000)),
  dbPath: process.env.DB_PATH ?? './data/oracle.db',
  port: Number(process.env.PORT ?? 8080),
};

/** Endpoint host, safe to log -- never includes the API key path segment. */
export function rpcHost(): string {
  try { return new URL(env.rpcUrl).host; } catch { return 'invalid-url'; }
}

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

/** Chain genesis, measured: block 1 timestamp is 2026-04-30T16:52:11Z. */
export const GENESIS_BLOCK = 1n;
