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

/**
 * Endpoint for eth_getLogs, which is a different problem from state reads.
 *
 * Measured 2026-09-02, and it overturns what this project previously assumed:
 *
 *  - Alchemy's free tier caps eth_getLogs at a **10 block** range, which turns
 *    a 52M-block walk into 5.2M requests. Not viable at any concurrency.
 *  - The public RH endpoint does **not** cap the block range near 1000, as the
 *    README long claimed. It caps the *result set* near 10,000 logs. A
 *    200,000-block range comes back in ~1.3s with ~5,200 logs. The errors that
 *    looked like a range limit are plain "Too Many Requests" under load.
 *
 * So logs come from the public endpoint by default, while state reads -- which
 * need the archive access the public endpoint lacks -- stay on Alchemy.
 */
const logsRpcUrl = process.env.RH_LOGS_RPC_URL?.trim() || PUBLIC_RPC;
const onPublic = logsRpcUrl.includes('rpc.mainnet.chain.robinhood.com');

export const env = {
  rpcUrl,
  rpcFallbackUrl: process.env.RH_RPC_FALLBACK_URL ?? '',
  /**
   * Starting eth_getLogs span. Both endpoints cap on result count rather than
   * range, so the walk starts wide and the adaptive controller narrows it
   * wherever the chain is dense. 200k keeps a dense range near 5k logs, half
   * the observed ceiling, leaving headroom before truncation.
   */
  logsRpcUrl,
  logChunk: Number(process.env.RH_LOG_CHUNK ?? 200_000),
  /** Parallel in-flight ranges during a backfill. */
  logConcurrency: Number(process.env.RH_LOG_CONCURRENCY ?? (onPublic ? 8 : 4)),
  dbPath: process.env.DB_PATH ?? './data/oracle.db',
  port: Number(process.env.PORT ?? 8080),
  /**
   * Bind address. Defaults to all interfaces so local development and
   * containers work without configuration; production sets 127.0.0.1 so the
   * only route in is the TLS reverse proxy. On a host with a public IP the
   * difference is whether port 8080 is on the internet.
   */
  host: process.env.HOST ?? '0.0.0.0',
};

/** Endpoint host, safe to log -- never includes the API key path segment. */
export function rpcHost(): string {
  try { return new URL(env.rpcUrl).host; } catch { return 'invalid-url'; }
}

export function logsRpcHost(): string {
  try { return new URL(env.logsRpcUrl).host; } catch { return 'invalid-url'; }
}

let client: PublicClient | undefined;
let logsClient: PublicClient | undefined;

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

/**
 * Client for log queries. Separate from the state client because the two have
 * opposite strengths here: the public endpoint indexes logs generously but
 * keeps no archive state, and the Alchemy free tier is the reverse.
 */
export function getLogsClient(): PublicClient {
  if (logsClient) return logsClient;
  if (env.logsRpcUrl === env.rpcUrl) return getClient();
  logsClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(env.logsRpcUrl, {
      timeout: 30_000, retryCount: 4, retryDelay: 1_000, batch: false,
    }),
  }) as PublicClient;
  return logsClient;
}

/** True when the configured endpoint is the rate-limited public one. */
export function isPublicRpc(): boolean {
  return env.rpcUrl.includes('rpc.mainnet.chain.robinhood.com');
}

/** True when logs come from the rate-limited public endpoint. */
export function isPublicLogsRpc(): boolean {
  return onPublic;
}

/** Chain genesis, measured: block 1 timestamp is 2026-04-30T16:52:11Z. */
export const GENESIS_BLOCK = 1n;
