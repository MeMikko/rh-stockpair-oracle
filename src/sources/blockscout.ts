import type { Address, Hex } from 'viem';

/**
 * Robinhood Chain Blockscout, as a second data source.
 *
 * It earns its place for two reasons. It removes the hard dependency on one
 * commercial RPC for backfill, and it answers questions the RPC cannot --
 * contract creation blocks (the public RPC keeps no archive state, so a binary
 * search on eth_getCode fails with "metadata is not found"), holder counts,
 * and token metadata.
 *
 * It is NOT the source of truth. Anything that reaches /quote or
 * /prepare-swap is read from the chain, because an explorer's index can lag or
 * backfill differently and a quote must never be second-hand.
 *
 * Three behaviours here were measured, not assumed:
 *  - requests without a browser User-Agent are rejected with 403;
 *  - the v1 logs API caps a response at 1000 entries and the `page` parameter
 *    is ignored (page 1 and page 2 return identical rows), so the cap can only
 *    be escaped by narrowing the block range;
 *  - wide ranges fail at the edge with an HTML 524 rather than a JSON error.
 */

const DEFAULT_BASE = 'https://robinhoodchain.blockscout.com';

/** Blockscout rejects non-browser agents outright. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/** Measured response cap of the v1 logs API. */
export const BLOCKSCOUT_LOG_CAP = 1000;

export const bsEnv = {
  baseUrl: (process.env.BLOCKSCOUT_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ''),
  apiKey: process.env.BLOCKSCOUT_API_KEY?.trim() ?? '',
  /** Minimum gap between calls, ms. Raised automatically on 429. */
  minIntervalMs: Number(process.env.BLOCKSCOUT_MIN_INTERVAL_MS ?? 120),
};

export function blockscoutConfigured(): boolean {
  return Boolean(bsEnv.baseUrl);
}

/** Thrown when a response hit the 1000-row cap and is therefore truncated. */
export class BlockscoutTruncated extends Error {
  constructor(
    public readonly from: bigint,
    public readonly to: bigint,
  ) {
    super(
      `blockscout: response capped at ${BLOCKSCOUT_LOG_CAP} logs over ${from}-${to}; narrow the range`,
    );
    this.name = 'BlockscoutTruncated';
  }
}

let lastCall = 0;
let interval = bsEnv.minIntervalMs;

async function throttle(): Promise<void> {
  const wait = lastCall + interval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function get(path: string, params: Record<string, string | number>): Promise<unknown> {
  const url = new URL(bsEnv.baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // Etherscan-compatible key parameter; raises the rate limit. Sent only to
  // the configured explorer host.
  if (bsEnv.apiKey) url.searchParams.set('apikey', bsEnv.apiKey);

  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
      continue;
    }

    if (res.status === 429) {
      // Back off hard and give up quickly. The free tier allows ~10 requests
      // per short window, so a long retry loop does not wait out the limit --
      // it spends the next window's budget and keeps the caller throttled.
      // Failing fast lets the walker surface the limit instead of hiding it.
      interval = Math.min(interval * 2, 10_000);
      if (attempt >= 1) {
        throw new Error(
          `blockscout: rate limited (429) after ${attempt + 1} attempts; ` +
            `free tier allows ~10 requests per window. Raise limits or slow the caller.`,
        );
      }
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    // 524/504 are Cloudflare giving up on a wide range. Surface as a range
    // error so the walker narrows instead of retrying the same span forever.
    if (res.status === 524 || res.status === 504 || res.status === 502) {
      throw new Error(`blockscout: upstream timeout ${res.status} (range too wide)`);
    }
    if (!res.ok) throw new Error(`blockscout: HTTP ${res.status} on ${path}`);

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`blockscout: non-JSON response on ${path}: ${text.slice(0, 80)}`);
    }
  }
  throw new Error(`blockscout: gave up on ${path} after repeated 429s`);
}

export interface BsLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
  timeStamp: number;
}

/**
 * Fetch logs for one address+topic over a block range.
 *
 * Throws BlockscoutTruncated when the response hits the cap; the caller must
 * narrow the range rather than accept a silently short list. Returning 1000
 * rows and pretending they are all of them is the one failure mode that would
 * put a wrong pool count into a published post.
 */
export async function bsGetLogs(
  address: Address,
  topic0: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BsLog[]> {
  const body = (await get('/api', {
    module: 'logs',
    action: 'getLogs',
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    address,
    topic0,
  })) as { status?: string; message?: string; result?: unknown };

  // "No logs found" comes back as status 0 with a string result, not an error.
  if (!Array.isArray(body.result)) {
    const msg = String(body.message ?? '').toLowerCase();
    if (msg.includes('no logs') || msg.includes('not found')) return [];
    throw new Error(`blockscout: unexpected logs payload: ${JSON.stringify(body).slice(0, 120)}`);
  }

  const rows = body.result as Array<Record<string, string | string[]>>;
  if (rows.length >= BLOCKSCOUT_LOG_CAP) throw new BlockscoutTruncated(fromBlock, toBlock);

  return rows.map((r) => ({
    address: String(r.address) as Address,
    topics: (r.topics as string[]).filter(Boolean) as Hex[],
    data: String(r.data ?? '0x') as Hex,
    blockNumber: Number(BigInt(String(r.blockNumber))),
    transactionHash: String(r.transactionHash) as Hex,
    logIndex: Number(BigInt(String(r.logIndex || '0x0'))),
    timeStamp: Number(BigInt(String(r.timeStamp || '0x0'))),
  }));
}

/**
 * Block a contract was created in. The public RPC cannot answer this -- it
 * keeps no archive state -- which is why a genesis backfill would otherwise
 * have to start at block 1 and walk millions of empty blocks.
 */
export async function bsCreationBlock(address: Address): Promise<number | null> {
  const body = (await get('/api', {
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: address,
  })) as { result?: Array<{ blockNumber?: string }> };
  const blk = body.result?.[0]?.blockNumber;
  return blk ? Number(blk) : null;
}

export interface BsTokenInfo {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  holders: number | null;
  totalSupply: string | null;
  /** The explorer's own USD rate. Informational only -- never a pricing input. */
  exchangeRate: number | null;
}

/**
 * Token metadata including holder count, which no RPC call returns: it is an
 * index over transfer history, not chain state.
 */
export async function bsTokenInfo(address: Address): Promise<BsTokenInfo | null> {
  let body: Record<string, unknown>;
  try {
    body = (await get(`/api/v2/tokens/${address}`, {})) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || !('symbol' in body)) return null;
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    symbol: (body.symbol as string) ?? null,
    name: (body.name as string) ?? null,
    decimals: num(body.decimals),
    holders: num(body.holders ?? body.holders_count),
    totalSupply: (body.total_supply as string) ?? null,
    exchangeRate: num(body.exchange_rate),
  };
}
