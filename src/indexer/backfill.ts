import { getClient, env, isPublicRpc } from '../../config/chain.js';
import { getCursor, setCursor } from '../db/index.js';
import { fetchInitializeRange, savePools } from './initialize.js';
import { withRetry } from '../util/retry.js';

const STREAM = 'v4:initialize';
const MIN_CHUNK = 25n;

export interface BackfillOpts {
  /** Where to start when there is no stored cursor. */
  fromBlock?: bigint;
  /** Stop after this many successful ranges; useful for a bounded first run. */
  maxChunks?: number;
  onProgress?: (info: { from: bigint; to: bigint; pools: number; stockPaired: number; span: bigint }) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resumable backfill of PoolManager Initialize events, with adaptive ranges.
 *
 * The public RPC not only caps eth_getLogs near 1000 blocks, it also times out
 * server-side ("context deadline exceeded") on ranges it nominally accepts. So
 * the span is treated as a moving target: halve it on failure down to
 * MIN_CHUNK, grow it back gently on success. The cursor is committed after each
 * successful range, so an interrupted run resumes without regap.
 */
export async function backfill(
  opts: BackfillOpts = {},
): Promise<{ chunks: number; pools: number; stockPaired: number; failures: number }> {
  const client = getClient();
  const tip = await withRetry(() => client.getBlockNumber(), { label: 'blockNumber' });
  const maxChunk = BigInt(env.logChunk);

  const stored = getCursor(STREAM);
  let cursor = stored !== null ? BigInt(stored) + 1n : (opts.fromBlock ?? tip - maxChunk);
  let span = maxChunk;

  if (isPublicRpc()) {
    console.warn(
      '[backfill] public RPC: ranges are capped near 1000 blocks and time out under load.\n' +
      '           Set RH_RPC_URL to a dedicated endpoint for any real backfill.',
    );
  }

  let chunks = 0, pools = 0, stockPaired = 0, failures = 0, consecutiveOk = 0;

  while (cursor <= tip) {
    if (opts.maxChunks !== undefined && chunks >= opts.maxChunks) break;
    const to = cursor + span - 1n > tip ? tip : cursor + span - 1n;

    try {
      const rows = await fetchInitializeRange(cursor, to);
      const res = savePools(rows);
      setCursor(STREAM, Number(to));

      pools += res.saved;
      stockPaired += res.stockPaired;
      chunks++;
      opts.onProgress?.({ from: cursor, to, pools: res.saved, stockPaired: res.stockPaired, span });
      cursor = to + 1n;

      // Grow back toward the cap after a run of clean responses.
      if (++consecutiveOk >= 3 && span < maxChunk) {
        span = span * 2n > maxChunk ? maxChunk : span * 2n;
        consecutiveOk = 0;
      }
    } catch (err) {
      failures++;
      consecutiveOk = 0;
      if (span > MIN_CHUNK) {
        span = span / 2n < MIN_CHUNK ? MIN_CHUNK : span / 2n;
        console.warn(`[backfill] range ${cursor}-${to} failed; retrying with span ${span}`);
        await sleep(1_000);
        continue;
      }
      // Already at the floor: back off harder before retrying the same range.
      if (failures % 5 === 0) {
        console.error(`[backfill] stuck at ${cursor} after ${failures} failures: ${(err as Error).message.slice(0, 120)}`);
      }
      await sleep(5_000);
    }
  }

  return { chunks, pools, stockPaired, failures };
}
