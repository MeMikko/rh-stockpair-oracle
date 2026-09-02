import { getDb } from '../db/index.js';
import { feedFor, loadFeeds } from '../registry/feeds.js';
import { readFeed } from '../pricing/chainlink.js';
import { labelHook } from '../../config/addresses.js';

/**
 * Turn raw swap amounts into USD volume for stock-paired pools.
 *
 * The stock side is the only side with a defensible USD reference, so volume
 * is the notional of that side -- one side of the swap, which is the ordinary
 * DEX convention -- priced with the Chainlink feed. The paired token is
 * whatever a launchpad minted an hour ago; pricing the swap off it would be
 * circular.
 *
 * That leaves a hole and the hole is reported rather than filled: 159 of 194
 * stock tokens have no feed, so their pools produce a measured swap count and
 * an unpriceable volume. A total that silently omitted them would understate
 * the chain; one that guessed at them would be fiction. Both numbers are
 * returned separately.
 */

export interface PoolVolumeRow {
  poolKey: string;
  protocol: 'v4' | 'v3';
  stockSymbol: string;
  pairedToken: string;
  hooks: string | null;
  hookLabel: string | null;
  stockSide: 0 | 1;
  swaps: number;
  /** Stock-side notional in whole tokens. */
  stockUnits: number;
  priceUsd: number | null;
  volumeUsd: number | null;
  /** Why volumeUsd is null, when it is. */
  reason: string | null;
}

export interface VolumeReport {
  fromBlock: number;
  toBlock: number;
  fromTs: number;
  toTs: number;
  hours: number;
  pools: PoolVolumeRow[];
  totalUsd: number;
  pricedPools: number;
  unpricedPools: number;
  unpricedSwaps: number;
  totalSwaps: number;
}

interface Row {
  pool_key: string;
  protocol: 'v4' | 'v3';
  stock_symbol: string;
  paired_token: string;
  stock_side: number;
  hooks: string | null;
  swaps: number;
  abs_amount0: string;
  abs_amount1: string;
  from_block: number;
  to_block: number;
  from_ts: number;
  to_ts: number;
}

/**
 * Join the volume accumulator to the pool tables. Stock tokens are 18-decimal
 * on this chain, but the decimals come from the registry rather than that
 * assumption, because USDG is 6 and a wrong exponent is a 10^12 error.
 */
function loadRows(): Row[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT v.pool_key, v.protocol, p.stock_symbol, p.paired_token, p.stock_side,
              p.hooks, v.swaps, v.abs_amount0, v.abs_amount1,
              v.from_block, v.to_block, v.from_ts, v.to_ts
         FROM pool_volume v
         JOIN pools p ON p.pool_id = v.pool_key
        WHERE v.protocol = 'v4' AND p.quote_kind = 'stock'
        UNION ALL
       SELECT v.pool_key, v.protocol, p3.stock_symbol, p3.paired_token, p3.stock_side,
              NULL as hooks, v.swaps, v.abs_amount0, v.abs_amount1,
              v.from_block, v.to_block, v.from_ts, v.to_ts
         FROM pool_volume v
         JOIN pools_v3 p3 ON p3.address = v.pool_key
        WHERE v.protocol = 'v3' AND p3.quote_kind = 'stock'`,
    )
    .all() as unknown as Row[];
}

export async function buildVolumeReport(): Promise<VolumeReport> {
  const rows = loadRows();
  if (rows.length === 0) {
    return {
      fromBlock: 0, toBlock: 0, fromTs: 0, toTs: 0, hours: 0,
      pools: [], totalUsd: 0, pricedPools: 0, unpricedPools: 0,
      unpricedSwaps: 0, totalSwaps: 0,
    };
  }

  // One Chainlink read per distinct symbol, not per pool.
  const symbols = [...new Set(rows.map((r) => r.stock_symbol))];
  const prices = new Map<string, number>();
  const feedErrors = new Map<string, string>();
  await Promise.all(
    symbols.map(async (sym) => {
      const feed = feedFor(sym);
      if (!feed) return;
      try {
        const read = await readFeed(feed);
        prices.set(sym, read.priceUsd);
      } catch (err) {
        feedErrors.set(sym, (err as Error).message.slice(0, 60));
      }
    }),
  );

  const decimalsBySymbol = new Map(
    (
      getDb().prepare('SELECT symbol, decimals FROM stock_tokens').all() as unknown as Array<{
        symbol: string;
        decimals: number;
      }>
    ).map((r) => [r.symbol, r.decimals]),
  );

  const pools: PoolVolumeRow[] = rows.map((r) => {
    const side = r.stock_side === 1 ? 1 : 0;
    const raw = BigInt(side === 0 ? r.abs_amount0 : r.abs_amount1);
    const dec = decimalsBySymbol.get(r.stock_symbol) ?? 18;
    const units = Number(raw) / 10 ** dec;
    const price = prices.get(r.stock_symbol) ?? null;
    const reason = price !== null
      ? null
      : feedErrors.has(r.stock_symbol)
        ? `feed_read_failed:${feedErrors.get(r.stock_symbol)}`
        : 'no_chainlink_feed_for_stock';

    return {
      poolKey: r.pool_key,
      protocol: r.protocol,
      stockSymbol: r.stock_symbol,
      pairedToken: r.paired_token,
      hooks: r.hooks,
      hookLabel: r.hooks ? labelHook(r.hooks) : null,
      stockSide: side,
      swaps: r.swaps,
      stockUnits: units,
      priceUsd: price,
      volumeUsd: price !== null ? units * price : null,
      reason,
    };
  });

  const priced = pools.filter((p) => p.volumeUsd !== null);
  const unpriced = pools.filter((p) => p.volumeUsd === null);
  const first = rows[0]!;

  return {
    fromBlock: first.from_block,
    toBlock: first.to_block,
    fromTs: first.from_ts,
    toTs: first.to_ts,
    hours: (first.to_ts - first.from_ts) / 3600,
    pools: pools.sort((a, b) => (b.volumeUsd ?? -1) - (a.volumeUsd ?? -1)),
    totalUsd: priced.reduce((s, p) => s + (p.volumeUsd ?? 0), 0),
    pricedPools: priced.length,
    unpricedPools: unpriced.length,
    unpricedSwaps: unpriced.reduce((s, p) => s + p.swaps, 0),
    totalSwaps: pools.reduce((s, p) => s + p.swaps, 0),
  };
}

/** Feed count, for the caveat line on any volume claim. */
export function feedCoverage(): { total: number; withFeed: number } {
  const total = (
    getDb().prepare('SELECT COUNT(*) c FROM stock_tokens').get() as unknown as { c: number }
  ).c;
  return { total, withFeed: loadFeeds().length };
}
