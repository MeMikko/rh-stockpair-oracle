import type { Address, Hex } from 'viem';
import { getClient, getLogsClient, env } from '../../config/chain.js';
import { V4 } from '../../config/addresses.js';
import { V4_SWAP_EVENT, V3_SWAP_EVENT } from '../abi.js';
import { getDb } from '../db/index.js';
import { walkLogs } from '../indexer/logWalker.js';
import { withRetry } from '../util/retry.js';

/**
 * Swap-volume measurement over a bounded window.
 *
 * Individual swaps are deliberately not stored. The chain produces far more of
 * them than a v1 cache should hold and no endpoint answers a per-swap
 * question, so each range is folded into a per-pool accumulator and only the
 * totals are persisted -- always alongside the block and timestamp window they
 * were measured over, because an undated volume number is not reproducible.
 *
 * v4 and v3 need different reads. Every v4 swap on the chain passes through
 * the PoolManager singleton and carries its PoolId as topic1, so one address
 * filter covers the whole protocol. A v3 swap is emitted by the pool contract
 * itself, so the pool is identified by the log's own address.
 */

export interface VolumeAccumulator {
  swaps: number;
  abs0: bigint;
  abs1: bigint;
}

export interface VolumeWindow {
  fromBlock: bigint;
  toBlock: bigint;
  fromTs: number;
  toTs: number;
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Node-side result ceiling for eth_getLogs, measured on the public endpoint:
 * a 1,000,000-block range came back with 9,454 logs and would not go higher.
 * Kept slightly under 10,000 so a genuine near-cap response is re-fetched
 * narrower rather than trusted.
 */
const RAW_RESULT_CAP = 9_500;

/** Resolve a block window covering roughly the last `seconds` of chain time. */
export async function recentWindow(seconds: number): Promise<VolumeWindow> {
  const client = getClient();
  const tip = await withRetry(() => client.getBlockNumber(), { label: 'blockNumber' });
  const tipBlock = await withRetry(() => client.getBlock({ blockNumber: tip }), { label: 'block' });
  const toTs = Number(tipBlock.timestamp);

  // Measure the local block rate rather than assuming one: chain 4663 has run
  // at 0.10s/block recently but averages 0.21s since genesis, and a window
  // sized from the wrong rate silently measures the wrong number of hours.
  const probeBack = 100_000n;
  const probe = await withRetry(() => client.getBlock({ blockNumber: tip - probeBack }), {
    label: 'block',
  });
  const secondsPerBlock = (toTs - Number(probe.timestamp)) / Number(probeBack);
  const span = BigInt(Math.ceil(seconds / secondsPerBlock));
  const fromBlock = tip > span ? tip - span : 1n;

  const fromBlockData = await withRetry(() => client.getBlock({ blockNumber: fromBlock }), {
    label: 'block',
  });

  return { fromBlock, toBlock: tip, fromTs: Number(fromBlockData.timestamp), toTs };
}

/**
 * Aggregate v4 swap volume per PoolId over a window.
 *
 * No pool filter is applied at the RPC: topic1 filtering would need the full
 * stock-paired PoolId set in every request, and the set is large enough that
 * fetching everything once and filtering locally is both cheaper and immune to
 * a stale filter list.
 */
export async function measureV4Volume(
  win: VolumeWindow,
  onProgress?: (done: number, pools: number) => void,
): Promise<Map<string, VolumeAccumulator>> {
  const acc = new Map<string, VolumeAccumulator>();

  await walkLogs<{ id: Hex; amount0: bigint; amount1: bigint }>({
    stream: 'v4:swaps:window',
    fromBlock: win.fromBlock,
    toBlock: win.toBlock,
    maxSpan: BigInt(env.logChunk),
    resume: false,
    fetch: async (from, to) => {
      const logs = await getLogsClient().getLogs({
        address: V4.poolManager as Address,
        event: V4_SWAP_EVENT,
        fromBlock: from,
        toBlock: to,
      });
      return logs.map((l) => ({
        id: l.args.id!,
        amount0: l.args.amount0!,
        amount1: l.args.amount1!,
      }));
    },
    save: (rows) => {
      for (const r of rows) {
        const k = r.id.toLowerCase();
        const cur = acc.get(k) ?? { swaps: 0, abs0: 0n, abs1: 0n };
        cur.swaps++;
        cur.abs0 += abs(r.amount0);
        cur.abs1 += abs(r.amount1);
        acc.set(k, cur);
      }
    },
    onProgress: (p) => onProgress?.(p.done, acc.size),
  });

  return acc;
}

/**
 * Aggregate v3 swap volume per pool address over a window.
 *
 * Filtered to the known v3 pool set when that set is small enough to pass as
 * an address filter, and otherwise fetched by topic and filtered locally --
 * the v3 Swap signature is not unique to Uniswap, so an unfiltered total would
 * quietly include forks.
 */
export async function measureV3Volume(
  win: VolumeWindow,
  poolAddresses: string[],
  onProgress?: (done: number, pools: number) => void,
): Promise<Map<string, VolumeAccumulator>> {
  const acc = new Map<string, VolumeAccumulator>();
  if (poolAddresses.length === 0) return acc;

  const known = new Set(poolAddresses.map((a) => a.toLowerCase()));
  const useAddressFilter = poolAddresses.length <= 400;

  await walkLogs<{ pool: string; amount0: bigint; amount1: bigint }>({
    stream: 'v3:swaps:window',
    fromBlock: win.fromBlock,
    toBlock: win.toBlock,
    maxSpan: BigInt(env.logChunk),
    resume: false,
    fetch: async (from, to) => {
      const logs = await getLogsClient().getLogs({
        ...(useAddressFilter ? { address: poolAddresses as Address[] } : {}),
        event: V3_SWAP_EVENT,
        fromBlock: from,
        toBlock: to,
      });

      // Truncation has to be judged on the RAW response, before filtering.
      // The walker's own cap check sees only what this function returns, so
      // when an unfiltered query is truncated at the node's 10k limit and
      // few of those logs belong to known pools, a short list looks like a
      // complete one and the missing swaps are lost silently -- understating
      // volume with no error anywhere.
      if (logs.length >= RAW_RESULT_CAP) {
        throw new Error(
          `v3 swaps: raw response hit the ${RAW_RESULT_CAP} result cap over ${from}-${to}; narrow the range`,
        );
      }

      return logs
        .filter((l) => known.has(l.address.toLowerCase()))
        .map((l) => ({
          pool: l.address.toLowerCase(),
          amount0: l.args.amount0!,
          amount1: l.args.amount1!,
        }));
    },
    save: (rows) => {
      for (const r of rows) {
        const cur = acc.get(r.pool) ?? { swaps: 0, abs0: 0n, abs1: 0n };
        cur.swaps++;
        cur.abs0 += abs(r.amount0);
        cur.abs1 += abs(r.amount1);
        acc.set(r.pool, cur);
      }
    },
    onProgress: (p) => onProgress?.(p.done, acc.size),
  });

  return acc;
}

/**
 * The stock-paired pool keys, as one set.
 *
 * The v4 scan is chain-wide by necessity — one address filter covers the whole
 * protocol — so the accumulator carries every pool on the chain that traded.
 * Current volume is stored for all of them because `/pools` reads it, but the
 * permanent record is narrowed to the subject this service actually answers
 * about. Keeping forever what is never asked about is not caution, it is
 * hoarding.
 */
function stockPairedKeys(): Set<string> {
  const db = getDb();
  const keys = new Set<string>();
  for (const r of db
    .prepare('SELECT pool_id AS k FROM pools WHERE stock_symbol IS NOT NULL')
    .all() as Array<{ k: string }>) {
    keys.add(r.k.toLowerCase());
  }
  for (const r of db
    .prepare('SELECT address AS k FROM pools_v3 WHERE stock_symbol IS NOT NULL')
    .all() as Array<{ k: string }>) {
    keys.add(r.k.toLowerCase());
  }
  return keys;
}

export function saveVolume(
  protocol: 'v4' | 'v3',
  win: VolumeWindow,
  acc: Map<string, VolumeAccumulator>,
): number {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO pool_volume (pool_key, protocol, from_block, to_block, from_ts, to_ts,
                              swaps, abs_amount0, abs_amount1, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pool_key, protocol) DO UPDATE SET
       from_block = excluded.from_block, to_block = excluded.to_block,
       from_ts = excluded.from_ts, to_ts = excluded.to_ts,
       swaps = excluded.swaps, abs_amount0 = excluded.abs_amount0,
       abs_amount1 = excluded.abs_amount1, updated_at = excluded.updated_at`,
  );
  // The same measurement, kept. `OR IGNORE` rather than an upsert: a window
  // end identifies the sample, so re-running the same window is a repeat
  // observation and must not overwrite what was recorded the first time.
  const history = db.prepare(
    `INSERT OR IGNORE INTO pool_volume_history
       (pool_key, protocol, to_ts, from_block, to_block, from_ts, swaps,
        abs_amount0, abs_amount1, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const keep = stockPairedKeys();

  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const [key, v] of acc) {
      stmt.run(
        key, protocol, Number(win.fromBlock), Number(win.toBlock), win.fromTs, win.toTs,
        v.swaps, v.abs0.toString(), v.abs1.toString(), now,
      );
      if (keep.has(key)) {
        history.run(
          key, protocol, win.toTs, Number(win.fromBlock), Number(win.toBlock), win.fromTs,
          v.swaps, v.abs0.toString(), v.abs1.toString(), now,
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return acc.size;
}
