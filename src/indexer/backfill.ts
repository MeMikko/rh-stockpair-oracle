import { getClient, env, isPublicLogsRpc, logsRpcHost, GENESIS_BLOCK } from '../../config/chain.js';
import { savePools } from './initialize.js';
import { saveV3Pools } from './v3.js';
import { initializeFetcher, v3PoolFetcher, type LogSource } from './sources.js';
import { walkLogs, type Progress } from './logWalker.js';
import { BLOCKSCOUT_LOG_CAP } from '../sources/blockscout.js';
import { withRetry } from '../util/retry.js';

export const V4_STREAM = 'v4:initialize';
export const V3_STREAM = 'v3:poolcreated';

export interface BackfillOpts {
  /** Where to start when there is no stored cursor. Defaults to genesis. */
  fromBlock?: bigint;
  /** Stop after this many committed ranges; useful for a bounded first run. */
  maxRanges?: number;
  /** Ignore any stored cursor and rewalk from fromBlock. */
  resume?: boolean;
  /** Which of the two discovery paths to read from. Default 'rpc'. */
  source?: LogSource;
  /** Cursor stream name override, so a cross-check walk cannot clobber the real cursor. */
  stream?: string;
  onProgress?: (info: Progress & { stockPaired: number }) => void;
}

export interface BackfillResult {
  ranges: number;
  pools: number;
  stockPaired: number;
  failures: number;
  fromBlock: bigint;
  toBlock: bigint;
  complete: boolean;
  source: LogSource;
}

/**
 * Starting span for a source. The explorer caps a response at 1000 rows and
 * times out on wide ranges at the CDN, so it starts an order of magnitude
 * tighter than an RPC that caps on result count alone; the walker adapts from
 * there in both directions.
 */
function maxSpanFor(source: LogSource): bigint {
  const configured = BigInt(env.logChunk);
  if (source !== 'blockscout') return configured;
  const cap = BigInt(BLOCKSCOUT_LOG_CAP) * 10n;
  return configured < cap ? configured : cap;
}

function noteEndpoint(what: string): void {
  if (!isPublicLogsRpc()) return;
  // Not a warning any more. Measured 2026-09-02: the public endpoint is the
  // *better* of the two for logs. Alchemy's free tier caps eth_getLogs at a
  // 10-block range, which turns a 52M-block walk into 5.2M requests; the
  // public endpoint takes 1000-block ranges and sustains ~10 req/s across 8
  // connections. It errors often under that load, which the walker absorbs by
  // retrying, so failure counts below are expected rather than alarming.
  console.log(
    `[${what}] logs from ${logsRpcHost()} at ${env.logChunk} blocks x ${env.logConcurrency} parallel`,
  );
}

/**
 * Backfill v4 pool discovery from PoolManager Initialize events.
 *
 * Defaults to genesis rather than a recent window: a coverage claim ("every
 * stock-paired pool on the chain") is only true if the walk actually started
 * at block 1. The adaptive walker keeps that affordable -- see logWalker.
 */
export async function backfill(opts: BackfillOpts = {}): Promise<BackfillResult> {
  const source = opts.source ?? 'rpc';
  if (source === 'rpc') noteEndpoint('backfill');
  const client = getClient();
  const tip = await withRetry(() => client.getBlockNumber(), { label: 'blockNumber' });
  const from = opts.fromBlock ?? GENESIS_BLOCK;

  let stockPaired = 0;
  const res = await walkLogs({
    stream: opts.stream ?? V4_STREAM,
    fromBlock: from,
    toBlock: tip,
    maxSpan: maxSpanFor(source),
    concurrency: source === 'blockscout' ? 1 : env.logConcurrency,
    resume: opts.resume,
    maxRanges: opts.maxRanges,
    fetch: initializeFetcher(source),
    save: (rows) => { stockPaired += savePools(rows).stockPaired; },
    onProgress: (p) => opts.onProgress?.({ ...p, stockPaired }),
  });

  return {
    ranges: res.ranges, pools: res.rows, stockPaired, failures: res.failures,
    fromBlock: from, toBlock: tip, complete: res.complete, source,
  };
}

/**
 * Backfill v3 pool discovery from the factory's PoolCreated events.
 *
 * This exists to answer a question the v4 indexer cannot: how much
 * stock-paired liquidity is on v3 and therefore invisible to /quote. Whether
 * the answer is "none" or "a lot", it has to be measured before any claim of
 * full coverage is made.
 */
export async function backfillV3(opts: BackfillOpts = {}): Promise<BackfillResult> {
  const source = opts.source ?? 'rpc';
  if (source === 'rpc') noteEndpoint('backfill:v3');
  const client = getClient();
  const tip = await withRetry(() => client.getBlockNumber(), { label: 'blockNumber' });
  const from = opts.fromBlock ?? GENESIS_BLOCK;

  let stockPaired = 0;
  const res = await walkLogs({
    stream: opts.stream ?? V3_STREAM,
    fromBlock: from,
    toBlock: tip,
    maxSpan: maxSpanFor(source),
    concurrency: source === 'blockscout' ? 1 : env.logConcurrency,
    resume: opts.resume,
    maxRanges: opts.maxRanges,
    fetch: v3PoolFetcher(source),
    save: (rows) => { stockPaired += saveV3Pools(rows).stockPaired; },
    onProgress: (p) => opts.onProgress?.({ ...p, stockPaired }),
  });

  return {
    ranges: res.ranges, pools: res.rows, stockPaired, failures: res.failures,
    fromBlock: from, toBlock: tip, complete: res.complete, source,
  };
}
